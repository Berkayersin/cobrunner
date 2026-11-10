// Cobrunner sunucusu: hesaplar, arkadaşlar, davet, eşleştirme, oyun, skor kaydı
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const createStore = require('./db');
const { getWeather, withDemo, THEMES } = require('./weather');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = createStore();
app.use(express.static('public'));
app.get('/health', (req, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;

// ---- Oyun ayarları ----
const COLS = 40, ROWS = 28;      // oyun alanı (hücre)
const TICK_MS = 120;             // yılan hızı
const START_LEN = 3;             // başlangıç boyu
const FOOD_COUNT = 14;           // ekrandaki yem sayısı
const COUNTDOWN_MS = 3000;       // maç öncesi geri sayım
const DURATIONS = [60, 180, 300];
const TARGET_MIN = 10, TARGET_MAX = 60;
const VALUE_LIMIT = 9999;
const PALETTE = ['#22c55e', '#3b82f6', '#ef4444', '#eab308', '#a855f7', '#ec4899', '#f97316', '#06b6d4'];

const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const OPS = ['+', '-', 'x', '/'];

const queues = { 60: [], 180: [], 300: [] };   // süreye göre bekleme kuyrukları
const rooms = new Map();                        // roomId -> oda
const socketRoom = new Map();                   // socketId -> roomId

const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const clamp = v => Math.max(-VALUE_LIMIT, Math.min(VALUE_LIMIT, v));

// Bölme: tam bölünmezse sonuç sıfıra doğru yuvarlanır (ör. 17 / 5 = 3)
function applyOp(v, op, n) {
  switch (op) {
    case '+': return v + n;
    case '-': return v - n;
    case 'x': return v * n;
    case '/': return Math.trunc(v / n);
  }
  return v;
}

// ---------- Yem yönetimi ----------
function isOccupied(room, x, y) {
  if (room.foods.some(f => f.x === x && f.y === y)) return true;
  return room.snakes.some(s => s.body.some(p => p.x === x && p.y === y));
}
function freeCell(room) {
  for (let i = 0; i < 500; i++) {
    const x = rnd(0, COLS - 1), y = rnd(1, ROWS - 1);
    if (!isOccupied(room, x, y)) return { x, y };
  }
  return { x: rnd(0, COLS - 1), y: rnd(0, ROWS - 1) };
}
function addFood(room, spec) {
  room.foods.push({ ...freeCell(room), ...spec });
}
function randomFoodSpec(room) {
  const r = Math.random();
  const hasReset = room.foods.some(f => f.type === 'reset');
  if (r < 0.6) return { type: 'num', value: rnd(1, 12) };
  if (r < 0.9 || hasReset) return { type: 'op', value: OPS[rnd(0, 3)] };
  return { type: 'reset' }; // ekranda aynı anda en fazla 1 hedef yenileme yemi
}
function refillFoods(room) {
  while (room.foods.length < FOOD_COUNT) addFood(room, randomFoodSpec(room));
}

// Ekrandaki sayı/işlem yemleriyle en fazla 4 yemde hedefe ulaşılabiliyor mu?
function canReach(value, op, foods, target, depth, used = 0) {
  if (depth === 0) return false;
  for (let i = 0; i < foods.length; i++) {
    if (used & (1 << i)) continue;
    const f = foods[i];
    let v = value, o = op;
    if (f.type === 'num') { v = clamp(applyOp(value, op, f.value)); o = '+'; if (v === target) return true; }
    else o = f.value;
    if (canReach(v, o, foods, target, depth - 1, used | (1 << i))) return true;
  }
  return false;
}
// Bekleyen işlemle tek sayıda hedefe götüren sayı (1-99)
function neededNumber(v, op, t) {
  let n = null;
  if (op === '+') n = t - v;
  else if (op === '-') n = v - t;
  else if (op === 'x') { if (v !== 0 && t % v === 0) n = t / v; }
  else if (op === '/') { if (t !== 0) n = Math.trunc(v / t); }
  if (n !== null && Number.isInteger(n) && n >= 1 && n <= 99 && applyOp(v, op, n) === t) return n;
  return null;
}
// Bir adım: gerekiyorsa işlem yemi + sayı yemi
function stepFoods(pendingOp, op, n) {
  const list = [];
  if (op !== pendingOp) list.push({ type: 'op', value: op });
  list.push({ type: 'num', value: n });
  return list;
}
function opOrder(pending) { return [pending, ...OPS.filter(o => o !== pending)]; }
// Değerden hedefe giden kısa bir yem planı üretir
function planPath(v, op, t) {
  for (const o of opOrder(op)) {
    const n = neededNumber(v, o, t);
    if (n !== null) return stepFoods(op, o, n);
  }
  for (const o1 of opOrder(op)) {
    for (let n1 = 1; n1 <= 99; n1++) {
      const v1 = clamp(applyOp(v, o1, n1));
      for (const o2 of opOrder('+')) {
        const n2 = neededNumber(v1, o2, t);
        if (n2 !== null) return [...stepFoods(op, o1, n1), ...stepFoods('+', o2, n2)];
      }
    }
  }
  // Çok büyük/küçük değerler için önce 99'a böl, sonra yeniden planla
  const v1 = Math.trunc(v / 99);
  return [...stepFoods(op, '/', 99), ...planPath(v1, '+', t)];
}
// Her oyuncu için hedef ulaşılabilir olmalı; değilse gerekli yemleri ekle
function ensureReachable(room) {
  for (const s of room.snakes) {
    const usable = room.foods.filter(f => f.type !== 'reset').slice(0, 20);
    if (canReach(s.value, s.op, usable, room.target, 4)) continue;
    for (const spec of planPath(s.value, s.op, room.target)) addFood(room, spec);
  }
}
function newTarget(old) {
  let t;
  do { t = rnd(TARGET_MIN, TARGET_MAX); } while (t === old);
  return t;
}

const online = new Map();          // userId -> socket
const invites = new Map();         // inviteId -> { fromId, toId, duration, timer }
const INVITE_TTL_MS = 30000;
const NAME_RE = /^[A-Za-z0-9_çğıöşüÇĞİÖŞÜ]{3,16}$/;

// ---------- Oda / maç ----------
function createSnake(player, idx) {
  const y = idx === 0 ? 9 : ROWS - 10;
  const x = idx === 0 ? 6 : COLS - 7;
  const dir = idx === 0 ? 'right' : 'left';
  const dx = idx === 0 ? -1 : 1;
  const body = [];
  for (let i = 0; i < START_LEN; i++) body.push({ x: x + dx * i, y });
  return {
    id: player.socket.id, userId: player.user.id, name: player.user.username, body, dir, nextDir: dir,
    value: 0, op: '+', score: 0, grow: 0, color: player.color
  };
}

// Oyuncunun gösterilecek hava durumu (gerçek veya sunum modu)
function weatherOf(sock) {
  const w = withDemo(sock.data.weather, sock.data.weatherDemo);
  return w ? { ...w, city: sock.data.city || '' } : null;
}

function isBusy(userId) {
  const s = online.get(userId);
  return !!(s && socketRoom.has(s.id));
}
function inQueue(socketId) { return DURATIONS.some(d => queues[d].some(p => p.socket.id === socketId)); }

function createRoom(p1, p2, duration) {
  removeFromQueues(p1.socket.id);
  removeFromQueues(p2.socket.id);
  cancelInvitesOf(p1.user.id); cancelInvitesOf(p2.user.id);
  const id = 'room-' + Date.now() + '-' + rnd(1000, 9999);
  if (p2.color === p1.color) p2.color = PALETTE.find(c => c !== p1.color);
  const now = Date.now();
  const room = {
    id, duration, snakes: [createSnake(p1, 0), createSnake(p2, 1)], foods: [],
    target: newTarget(null), startsAt: now + COUNTDOWN_MS, endsAt: now + COUNTDOWN_MS + duration * 1000,
    overtime: false, lastScorer: null, finished: false, timer: null,
    resetLockedFor: null, // hedef yenileme yemini en son kullanan (sıradakini o yiyemez)
    events: []            // istemcide ses çalmak için olaylar
  };
  refillFoods(room);
  ensureReachable(room);
  rooms.set(id, room);
  for (const p of [p1, p2]) { p.socket.join(id); socketRoom.set(p.socket.id, id); }
  // Her oyuncu kendi bölgesinin havasında oynar; rakibin havası da üstte görünür
  const weather = { [p1.socket.id]: weatherOf(p1.socket), [p2.socket.id]: weatherOf(p2.socket) };
  p1.socket.emit('matchFound', { opponent: p2.user.username, duration, cols: COLS, rows: ROWS, weather });
  p2.socket.emit('matchFound', { opponent: p1.user.username, duration, cols: COLS, rows: ROWS, weather });
  room.timer = setInterval(() => tick(room), TICK_MS);
  notifyFriendsOf(p1.user.id); notifyFriendsOf(p2.user.id);
}

function eat(room, s, index) {
  const f = room.foods.splice(index, 1)[0];
  s.grow += 1; // her yem yılanı büyütür
  if (f.type === 'num') {
    s.value = clamp(applyOp(s.value, s.op, f.value));
    s.op = '+';
    room.events.push({ type: 'num', id: s.id });
    if (s.value === room.target) {
      room.events.push({ type: 'score', id: s.id });
      s.score += 1;
      room.lastScorer = s.id;
      s.value = 0;
      room.target = newTarget(room.target);
      if (room.overtime) { finish(room, s.id, 'Altın gol! Uzatmada ilk sayıyı yapan kazandı.'); return; }
    }
  } else if (f.type === 'op') {
    s.op = f.value;
    room.events.push({ type: 'op', id: s.id });
  } else { // ⟲ hedef yenileme: değerler korunur, sadece hedef değişir
    room.target = newTarget(room.target);
    room.resetLockedFor = s.id;
    room.events.push({ type: 'reset', id: s.id });
  }
  refillFoods(room);
  ensureReachable(room);
}

function handleTimeUp(room) {
  const [a, b] = room.snakes;
  if (a.score !== b.score) finish(room, a.score > b.score ? a.id : b.id, 'Süre doldu.');
  else if (room.lastScorer) finish(room, room.lastScorer, 'Skor berabere, son sayıyı yapan kazandı.');
  else room.overtime = true; // 0-0: altın gol uzatması
}

function tick(room) {
  if (room.finished) return;
  const now = Date.now();
  if (now >= room.startsAt) {
    for (const s of room.snakes) {
      s.dir = s.nextDir;
      const d = DIRS[s.dir], h = s.body[0];
      s.body.unshift({ x: (h.x + d.x + COLS) % COLS, y: (h.y + d.y + ROWS) % ROWS }); // duvardan karşıya geçiş
      if (s.grow > 0) s.grow--; else s.body.pop();
    }
    // Yılanlar birbirinin içinden geçebilir: çarpışma kontrolü yok
    for (const s of room.snakes) {
      if (room.finished) return;
      const i = room.foods.findIndex(f => f.x === s.body[0].x && f.y === s.body[0].y &&
        !(f.type === 'reset' && room.resetLockedFor === s.id));
      if (i >= 0) eat(room, s, i);
    }
    if (room.finished) return;
    if (!room.overtime && now >= room.endsAt) handleTimeUp(room);
    if (room.finished) return;
  }
  io.to(room.id).emit('state', {
    target: room.target,
    foods: room.foods,
    snakes: room.snakes.map(s => ({ id: s.id, name: s.name, body: s.body, value: s.value, op: s.op, score: s.score, color: s.color })),
    countdown: Math.max(0, Math.ceil((room.startsAt - now) / 1000)),
    remaining: Math.max(0, Math.ceil((room.endsAt - now) / 1000)),
    overtime: room.overtime,
    resetLockedFor: room.resetLockedFor,
    events: room.events
  });
  room.events = [];
}

function finish(room, winnerSocketId, reason) {
  if (room.finished) return;
  room.finished = true;
  clearInterval(room.timer);
  const winner = room.snakes.find(s => s.id === winnerSocketId);
  io.to(room.id).emit('gameOver', {
    winnerId: winnerSocketId, winnerName: winner ? winner.name : '-', reason,
    scores: room.snakes.map(s => ({ name: s.name, score: s.score }))
  });
  for (const s of room.snakes) {
    socketRoom.delete(s.id);
    const sock = io.sockets.sockets.get(s.id);
    if (sock) sock.leave(room.id);
  }
  rooms.delete(room.id);
  const [a, b] = room.snakes;
  db.saveMatch({
    p1Id: a.userId, p2Id: b.userId, p1Score: a.score, p2Score: b.score,
    winnerId: winner ? winner.userId : null, duration: room.duration, reason
  }).catch(e => console.error('Maç kaydedilemedi:', e.message));
  notifyFriendsOf(a.userId); notifyFriendsOf(b.userId);
}

function removeFromQueues(socketId) {
  for (const d of DURATIONS) queues[d] = queues[d].filter(p => p.socket.id !== socketId);
}

// ---------- Arkadaş bildirimleri ----------
function pushSocialChanged(userId) {
  const s = online.get(userId);
  if (s) s.emit('social:changed');
}
async function notifyFriendsOf(userId) {
  try {
    const { friends } = await db.getSocial(userId);
    friends.forEach(f => pushSocialChanged(f.id));
  } catch (e) { console.error(e.message); }
}
function cancelInvitesOf(userId) {
  for (const [id, inv] of invites) {
    if (inv.fromId === userId || inv.toId === userId) {
      clearTimeout(inv.timer);
      invites.delete(id);
      const other = online.get(inv.fromId === userId ? inv.toId : inv.fromId);
      if (other) other.emit('invite:cancelled', { inviteId: id });
      const self = online.get(userId);
      if (self) self.emit('invite:cancelled', { inviteId: id });
    }
  }
}

// ---------- Bağlantılar ----------
const ok = (cb, data = {}) => typeof cb === 'function' && cb({ ok: true, ...data });
const fail = (cb, error) => typeof cb === 'function' && cb({ ok: false, error });
// Hata yakalayan, giriş gerektiren olay sarmalayıcı
function on(socket, event, handler, needsAuth = true) {
  socket.on(event, async (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    data = data || {};
    if (needsAuth && !socket.data.user) return fail(cb, 'Önce giriş yapmalısın.');
    try { await handler(data, cb); }
    catch (e) { console.error(event, e); fail(cb, e.message && e.message.length < 80 ? e.message : 'Sunucu hatası.'); }
  });
}

io.on('connection', socket => {
  socket.data.user = null;

  async function bindUser(user, token, cb) {
    const prev = online.get(user.id);
    if (prev && prev.id !== socket.id) {
      prev.emit('kicked', 'Hesabına başka bir yerden giriş yapıldı.');
      prev.disconnect(true);
    }
    socket.data.user = user;
    socket.data.token = token;
    online.set(user.id, socket);
    ok(cb, { token, user });
    notifyFriendsOf(user.id);
  }

  on(socket, 'register', async ({ username, password, color }, cb) => {
    username = String(username || '').trim();
    password = String(password || '');
    if (!NAME_RE.test(username)) return fail(cb, 'Kullanıcı adı 3-16 karakter olmalı (harf, rakam, _).');
    if (password.length < 4) return fail(cb, 'Şifre en az 4 karakter olmalı.');
    const user = await db.createUser(username, password, PALETTE.includes(color) ? color : PALETTE[0]);
    await bindUser(user, await db.createSession(user.id), cb);
  }, false);

  on(socket, 'login', async ({ username, password }, cb) => {
    const user = await db.login(String(username || '').trim(), String(password || ''));
    if (!user) return fail(cb, 'Kullanıcı adı veya şifre hatalı.');
    await bindUser(user, await db.createSession(user.id), cb);
  }, false);

  on(socket, 'resume', async ({ token }, cb) => {
    const user = token ? await db.userByToken(String(token)) : null;
    if (!user) return fail(cb, 'Oturum süresi doldu.');
    await bindUser(user, token, cb);
  }, false);

  on(socket, 'logout', async (_, cb) => {
    if (socket.data.token) await db.deleteSession(socket.data.token);
    cleanup();
    ok(cb);
  });

  on(socket, 'setColor', async ({ color }, cb) => {
    if (!PALETTE.includes(color)) return fail(cb, 'Geçersiz renk.');
    await db.setColor(socket.data.user.id, color);
    socket.data.user.color = color;
    ok(cb);
  });

  // ----- Arkadaşlar -----
  on(socket, 'social:get', async (_, cb) => {
    const s = await db.getSocial(socket.data.user.id);
    s.friends = s.friends.map(f => ({ ...f, online: online.has(f.id), inGame: isBusy(f.id) }));
    ok(cb, s);
  });

  on(socket, 'friend:add', async ({ username }, cb) => {
    const me = socket.data.user;
    const other = await db.userByName(String(username || '').trim());
    if (!other) return fail(cb, 'Böyle bir kullanıcı bulunamadı.');
    if (other.id === me.id) return fail(cb, 'Kendini ekleyemezsin.');
    const rel = await db.getRelation(me.id, other.id);
    if (rel && rel.status === 'accepted') return fail(cb, 'Zaten arkadaşsınız.');
    if (rel && rel.requester_id === me.id) return fail(cb, 'İstek zaten gönderildi.');
    if (rel) { // karşı taraf zaten istek göndermişse doğrudan kabul et
      await db.acceptRequest(other.id, me.id);
      pushSocialChanged(other.id);
      return ok(cb, { message: `${other.username} ile artık arkadaşsınız.` });
    }
    await db.addRequest(me.id, other.id);
    pushSocialChanged(other.id);
    ok(cb, { message: `${other.username} kullanıcısına istek gönderildi.` });
  });

  on(socket, 'friend:respond', async ({ userId, accept }, cb) => {
    const me = socket.data.user.id;
    if (accept) await db.acceptRequest(Number(userId), me);
    else await db.deleteRelation(Number(userId), me);
    pushSocialChanged(Number(userId));
    ok(cb);
  });

  on(socket, 'friend:remove', async ({ userId }, cb) => {
    await db.deleteRelation(socket.data.user.id, Number(userId));
    pushSocialChanged(Number(userId));
    ok(cb);
  });

  // ----- Davet -----
  on(socket, 'invite:send', async ({ userId, duration }, cb) => {
    const me = socket.data.user;
    const toId = Number(userId);
    duration = Number(duration);
    if (!DURATIONS.includes(duration)) return fail(cb, 'Geçersiz süre.');
    const rel = await db.getRelation(me.id, toId);
    if (!rel || rel.status !== 'accepted') return fail(cb, 'Sadece arkadaşlarını davet edebilirsin.');
    const target = online.get(toId);
    if (!target) return fail(cb, 'Arkadaşın çevrimiçi değil.');
    if (isBusy(toId)) return fail(cb, 'Arkadaşın şu an bir maçta.');
    if (socketRoom.has(socket.id)) return fail(cb, 'Zaten bir maçtasın.');
    if ([...invites.values()].some(i => i.fromId === me.id && i.toId === toId)) return fail(cb, 'Davet zaten gönderildi.');
    const inviteId = 'inv-' + Date.now() + '-' + rnd(1000, 9999);
    const timer = setTimeout(() => {
      if (!invites.delete(inviteId)) return;
      const s = online.get(me.id); if (s) s.emit('invite:expired', { inviteId });
      const t = online.get(toId); if (t) t.emit('invite:cancelled', { inviteId });
    }, INVITE_TTL_MS);
    invites.set(inviteId, { fromId: me.id, toId, duration, timer });
    target.emit('invite:received', { inviteId, from: me.username, duration });
    ok(cb, { inviteId });
  });

  on(socket, 'invite:respond', async ({ inviteId, accept }, cb) => {
    const inv = invites.get(inviteId);
    if (!inv || inv.toId !== socket.data.user.id) return fail(cb, 'Davet artık geçerli değil.');
    clearTimeout(inv.timer);
    invites.delete(inviteId);
    const fromSock = online.get(inv.fromId);
    if (!accept) {
      if (fromSock) fromSock.emit('invite:declined', { by: socket.data.user.username });
      return ok(cb);
    }
    if (!fromSock || socketRoom.has(fromSock.id)) return fail(cb, 'Davet eden oyuncu artık müsait değil.');
    if (socketRoom.has(socket.id)) return fail(cb, 'Zaten bir maçtasın.');
    ok(cb);
    createRoom(
      { socket: fromSock, user: fromSock.data.user, color: fromSock.data.user.color },
      { socket, user: socket.data.user, color: socket.data.user.color },
      inv.duration);
  });

  // ----- Rastgele eşleştirme -----
  on(socket, 'findMatch', async ({ duration }, cb) => {
    duration = Number(duration);
    if (!DURATIONS.includes(duration)) return fail(cb, 'Geçersiz süre.');
    if (socketRoom.has(socket.id)) return fail(cb, 'Zaten bir maçtasın.');
    removeFromQueues(socket.id);
    const q = queues[duration];
    q.push({ socket, user: socket.data.user, color: socket.data.user.color });
    ok(cb, { duration });
    while (q.length >= 2) {
      const p1 = q.shift(), p2 = q.shift();
      if (!p1.socket.connected) { if (p2.socket.connected) q.unshift(p2); continue; }
      if (!p2.socket.connected) { q.unshift(p1); continue; }
      createRoom(p1, p2, duration);
    }
  });

  on(socket, 'cancelFind', async (_, cb) => { removeFromQueues(socket.id); ok(cb); });

  // ----- Hava durumu -----
  on(socket, 'weather:set', async ({ lat, lon, city, source }, cb) => {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return fail(cb, 'Geçersiz konum.');
    socket.data.city = String(city || '').slice(0, 40);
    socket.data.weather = await getWeather(lat, lon);
    socket.data.weatherSource = source === 'gps' ? 'gps' : 'ip';
    ok(cb, { weather: weatherOf(socket) });
  }, false);

  on(socket, 'weather:demo', async ({ theme }, cb) => {
    socket.data.weatherDemo = THEMES[theme] ? theme : null;
    ok(cb, { weather: weatherOf(socket) });
  }, false);

  on(socket, 'stats:get', async (_, cb) => ok(cb, await db.getStats(socket.data.user.id)));

  socket.on('dir', dir => {
    const room = rooms.get(socketRoom.get(socket.id));
    if (!room || !DIRS[dir]) return;
    const s = room.snakes.find(x => x.id === socket.id);
    if (s && OPPOSITE[s.dir] !== dir) s.nextDir = dir;
  });

  function cleanup() {
    removeFromQueues(socket.id);
    const room = rooms.get(socketRoom.get(socket.id));
    if (room && !room.finished) {
      const other = room.snakes.find(s => s.id !== socket.id);
      finish(room, other.id, 'Rakip oyundan ayrıldı, hükmen galibiyet.');
    }
    const user = socket.data.user;
    if (user) {
      cancelInvitesOf(user.id);
      if (online.get(user.id) === socket) { online.delete(user.id); notifyFriendsOf(user.id); }
    }
    socket.data.user = null;
    socket.data.token = null;
  }
  socket.on('disconnect', cleanup);
});

db.init()
  .then(() => server.listen(PORT, () => console.log(`Cobrunner ${PORT} portunda çalışıyor. Veritabanı: ${db.kind}`)))
  .catch(e => { console.error('Veritabanına bağlanılamadı:', e.message); process.exit(1); });
