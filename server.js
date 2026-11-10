// Cobrunner sunucusu: hesaplar, arkadaşlar, davet, eşleştirme, oyun döngüsü, skor kaydı, hava durumu
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const createStore = require('./db');
const game = require('./game');
const { fromRaw, fetchServer, withDemo, THEMES } = require('./weather');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { perMessageDeflate: false });
const db = createStore();
app.use(express.static('public', { maxAge: '1h' }));
app.get('/health', (req, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;

// ---- Ayarlar ----
const TICK_MS = 130;               // yılan hızı (ms / adım)
const COUNTDOWN_MS = 3000;
const DURATIONS = [60, 180, 300];
const INVITE_TTL_MS = 30000;
const PALETTE = ['#22c55e', '#3b82f6', '#ef4444', '#eab308', '#a855f7', '#ec4899', '#f97316', '#06b6d4'];
const NAME_RE = /^[A-Za-z0-9_çğıöşüÇĞİÖŞÜ]{3,16}$/;

const queues = { 60: [], 180: [], 300: [] };
const rooms = new Map();           // roomId -> oda
const socketRoom = new Map();      // socketId -> roomId
const online = new Map();          // userId -> socket
const invites = new Map();         // inviteId -> { fromId, toId, duration, timer }
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// ---------- Yardımcılar ----------
function weatherOf(sock) {
  const w = withDemo(sock.data.weather, sock.data.weatherDemo);
  return w ? { ...w, city: sock.data.city || '' } : null;
}
function isBusy(userId) { const s = online.get(userId); return !!(s && socketRoom.has(s.id)); }
function removeFromQueues(socketId) { for (const d of DURATIONS) queues[d] = queues[d].filter(p => p.socket.id !== socketId); }
function pushSocialChanged(userId) { const s = online.get(userId); if (s) s.emit('social:changed'); }
async function notifyFriendsOf(userId) {
  try { (await db.getSocial(userId)).friends.forEach(f => pushSocialChanged(f.id)); }
  catch (e) { console.error(e.message); }
}
function cancelInvitesOf(userId) {
  for (const [id, inv] of invites) {
    if (inv.fromId !== userId && inv.toId !== userId) continue;
    clearTimeout(inv.timer);
    invites.delete(id);
    for (const uid of [inv.fromId, inv.toId]) { const s = online.get(uid); if (s) s.emit('invite:cancelled', { inviteId: id }); }
  }
}

// ---------- Maç ----------
function createRoom(p1, p2, duration) {
  removeFromQueues(p1.socket.id); removeFromQueues(p2.socket.id);
  cancelInvitesOf(p1.user.id); cancelInvitesOf(p2.user.id);
  const c1 = p1.user.color || PALETTE[0];
  let c2 = p2.user.color || PALETTE[1];
  if (c2 === c1) c2 = PALETTE.find(c => c !== c1);
  const g = game.createGame(
    { id: p1.socket.id, userId: p1.user.id, name: p1.user.username, color: c1 },
    { id: p2.socket.id, userId: p2.user.id, name: p2.user.username, color: c2 });
  const id = 'room-' + Date.now() + '-' + rnd(1000, 9999);
  const now = Date.now();
  const room = Object.assign(g, { id, duration, startsAt: now + COUNTDOWN_MS, endsAt: now + COUNTDOWN_MS + duration * 1000,
    overtime: false, finished: false, foodsVer: 0, timer: null });
  rooms.set(id, room);
  for (const p of [p1, p2]) { p.socket.join(id); socketRoom.set(p.socket.id, id); }
  const weather = { [p1.socket.id]: weatherOf(p1.socket), [p2.socket.id]: weatherOf(p2.socket) };
  const info = { duration, cols: game.COLS, rows: game.ROWS, weather };
  p1.socket.emit('matchFound', { ...info, opponent: p2.user.username });
  p2.socket.emit('matchFound', { ...info, opponent: p1.user.username });
  room.timer = setInterval(() => tick(room), TICK_MS);
  broadcast(room, now);
  notifyFriendsOf(p1.user.id); notifyFriendsOf(p2.user.id);
}

function tick(room) {
  if (room.finished) return;
  const now = Date.now();
  if (now >= room.startsAt) {
    const scorers = game.step(room);
    if (room.overtime && scorers.length) {
      return finish(room, scorers[0], 'Altın gol! Uzatmada ilk sayıyı yapan kazandı.');
    }
    if (!room.overtime && now >= room.endsAt) {
      const [a, b] = room.snakes;
      if (a.score !== b.score) return finish(room, a.score > b.score ? a.id : b.id, 'Süre doldu.');
      if (room.lastScorer) return finish(room, room.lastScorer, 'Skor berabere, son sayıyı yapan kazandı.');
      room.overtime = true; // 0-0: altın gol
    }
  }
  broadcast(room, now);
}

// Ağ trafiğini azaltmak için yemler sadece değiştiğinde gönderilir
function broadcast(room, now) {
  const msg = {
    t: room.target,
    s: room.snakes.map(s => ({ id: s.id, name: s.name, color: s.color, body: s.body, value: s.value, op: s.op, score: s.score })),
    cd: Math.max(0, Math.ceil((room.startsAt - now) / 1000)),
    rem: Math.max(0, Math.ceil((room.endsAt - now) / 1000)),
    ot: room.overtime,
    lock: room.resetLockedFor,
    ev: room.events
  };
  if (room.foodsDirty) { room.foodsVer++; msg.f = room.foods; room.foodsDirty = false; }
  msg.fv = room.foodsVer;
  io.to(room.id).emit('state', msg);
  room.events = [];
}

function finish(room, winnerSocketId, reason) {
  if (room.finished) return;
  room.finished = true;
  clearInterval(room.timer);
  broadcast(room, Date.now());
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
  db.saveMatch({ p1Id: a.userId, p2Id: b.userId, p1Score: a.score, p2Score: b.score,
    winnerId: winner ? winner.userId : null, duration: room.duration, reason })
    .catch(e => console.error('Maç kaydedilemedi:', e.message));
  notifyFriendsOf(a.userId); notifyFriendsOf(b.userId);
}

// ---------- Bağlantılar ----------
const ok = (cb, data = {}) => typeof cb === 'function' && cb({ ok: true, ...data });
const fail = (cb, error) => typeof cb === 'function' && cb({ ok: false, error });
function on(socket, event, handler, needsAuth = true) {
  socket.on(event, async (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    data = data || {};
    if (needsAuth && !socket.data.user) return fail(cb, 'Önce giriş yapmalısın.');
    try { await handler(data, cb); }
    catch (e) { console.error(event, e.message); fail(cb, e.message && e.message.length < 90 ? e.message : 'Sunucu hatası.'); }
  });
}

io.on('connection', socket => {
  socket.data.user = null;

  async function bindUser(user, token, cb) {
    const prev = online.get(user.id);
    if (prev && prev.id !== socket.id) { prev.emit('kicked', 'Hesabına başka bir yerden giriş yapıldı.'); prev.disconnect(true); }
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
    if (rel) {
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
    createRoom({ socket: fromSock, user: fromSock.data.user }, { socket, user: socket.data.user }, inv.duration);
  });

  // ----- Rastgele eşleştirme -----
  on(socket, 'findMatch', async ({ duration }, cb) => {
    duration = Number(duration);
    if (!DURATIONS.includes(duration)) return fail(cb, 'Geçersiz süre.');
    if (socketRoom.has(socket.id)) return fail(cb, 'Zaten bir maçtasın.');
    removeFromQueues(socket.id);
    const q = queues[duration];
    q.push({ socket, user: socket.data.user });
    ok(cb, { duration });
    while (q.length >= 2) {
      const p1 = q.shift(), p2 = q.shift();
      if (!p1.socket.connected) { if (p2.socket.connected) q.unshift(p2); continue; }
      if (!p2.socket.connected) { q.unshift(p1); continue; }
      createRoom(p1, p2, duration);
    }
  });
  on(socket, 'cancelFind', async (_, cb) => { removeFromQueues(socket.id); ok(cb); });

  on(socket, 'stats:get', async (_, cb) => ok(cb, await db.getStats(socket.data.user.id)));

  // ----- Hava durumu -----
  on(socket, 'weather:set', async ({ lat, lon, city, raw }, cb) => {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return fail(cb, 'Geçersiz konum.');
    socket.data.city = String(city || '').slice(0, 40);
    let w = fromRaw(raw);                    // tarayıcının çektiği veri
    if (!w) w = await fetchServer(lat, lon); // yedek: sunucu çeker
    socket.data.weather = w;
    ok(cb, { weather: weatherOf(socket) });
  }, false);

  on(socket, 'weather:demo', async ({ theme }, cb) => {
    socket.data.weatherDemo = THEMES[theme] ? theme : null;
    ok(cb, { weather: weatherOf(socket) });
  }, false);

  socket.on('dir', dir => {
    const room = rooms.get(socketRoom.get(socket.id));
    if (room) game.setDir(room, socket.id, dir);
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
