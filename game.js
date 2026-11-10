// Cobrunner oyun kuralları (sunucudan bağımsız, test edilebilir saf mantık)
const COLS = 18, ROWS = 24;        // mobil dikey ekrana uygun, okunaklı ızgara
const START_LEN = 3;
const FOOD_COUNT = 10;
const MAX_FOODS = 14;              // ekran kalabalıklaşmasın
const TARGET_MIN = 10, TARGET_MAX = 50;
const VALUE_LIMIT = 9999;
const OPS = ['+', '-', 'x', '/'];
const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

// İşlem kuralları: eksiye düşmez, bölmede aşağı yuvarlanır, üst sınır 9999.
// 0 iken − × ÷ değeri 0'da bırakır; büyümek için + gerekir.
function applyOp(v, op, n) {
  let r = v;
  if (op === '+') r = v + n;
  else if (op === '-') r = v - n;
  else if (op === 'x') r = v * n;
  else if (op === '/') r = Math.floor(v / n);
  return Math.max(0, Math.min(VALUE_LIMIT, r));
}

// ---------- Yemler ----------
function isOccupied(room, x, y) {
  if (room.foods.some(f => f.x === x && f.y === y)) return true;
  return room.snakes.some(s => s.body.some(p => p.x === x && p.y === y));
}
function freeCell(room) {
  for (let i = 0; i < 300; i++) {
    const x = rnd(0, COLS - 1), y = rnd(0, ROWS - 1);
    if (!isOccupied(room, x, y)) return { x, y };
  }
  return { x: rnd(0, COLS - 1), y: rnd(0, ROWS - 1) };
}
function addFood(room, spec) {
  room.foods.push({ ...freeCell(room), ...spec });
  room.foodsDirty = true;
}
function randomFoodSpec(room) {
  const r = Math.random();
  const has = t => room.foods.some(f => f.type === t);
  if (r < 0.60) return { type: 'num', value: rnd(1, 12) };
  if (r < 0.88) return { type: 'op', value: OPS[rnd(0, 3)] };
  if (r < 0.94 && !has('reset')) return { type: 'reset' };            // ⟲ hedefi yenile
  if (r >= 0.94 && !has('zap')) return { type: 'zap' };               // ⚡ rakibi sıfırla
  return { type: 'num', value: rnd(1, 12) };
}
function refillFoods(room) {
  while (room.foods.length < FOOD_COUNT) addFood(room, randomFoodSpec(room));
}

// ---------- Hedefe ulaşılabilirlik ----------
// İşlem kalıcıdır: sayı yenince son alınan işlem uygulanır, işlem değişmez.
function canReach(value, op, foods, target, depth, used = 0) {
  if (depth === 0) return false;
  for (let i = 0; i < foods.length; i++) {
    if (used & (1 << i)) continue;
    const f = foods[i];
    let v = value, o = op;
    if (f.type === 'num') { v = applyOp(value, op, f.value); if (v === target) return true; }
    else o = f.value;
    if (canReach(v, o, foods, target, depth - 1, used | (1 << i))) return true;
  }
  return false;
}
// Verilen işlemle tek sayıda hedefe götüren sayı (1-99)
function neededNumber(v, op, t) {
  let n = null;
  if (op === '+') n = t - v;
  else if (op === '-') n = v - t;
  else if (op === 'x') { if (v > 0 && t % v === 0) n = t / v; }
  else if (op === '/') { if (t > 0) n = Math.floor(v / t); }
  if (n !== null && Number.isInteger(n) && n >= 1 && n <= 99 && applyOp(v, op, n) === t) return n;
  return null;
}
const opOrder = cur => [cur, ...OPS.filter(o => o !== cur)];
// Değerden hedefe giden kısa bir yem listesi üretir
function planPath(v, op, t) {
  for (const o of opOrder(op)) {
    const n = neededNumber(v, o, t);
    if (n !== null) return [...(o !== op ? [{ type: 'op', value: o }] : []), { type: 'num', value: n }];
  }
  for (const o1 of opOrder(op)) {
    for (let n1 = 1; n1 <= 99; n1++) {
      const v1 = applyOp(v, o1, n1);
      for (const o2 of opOrder(o1)) {
        const n2 = neededNumber(v1, o2, t);
        if (n2 !== null) return [
          ...(o1 !== op ? [{ type: 'op', value: o1 }] : []), { type: 'num', value: n1 },
          ...(o2 !== o1 ? [{ type: 'op', value: o2 }] : []), { type: 'num', value: n2 }];
      }
    }
  }
  return [{ type: 'op', value: '+' }, { type: 'num', value: t }]; // pratikte buraya gelinmez
}
function ensureReachable(room) {
  for (const s of room.snakes) {
    const usable = room.foods.filter(f => f.type === 'num' || f.type === 'op').slice(0, 16);
    if (canReach(s.value, s.op, usable, room.target, 3)) continue;
    for (const spec of planPath(s.value, s.op, room.target)) addFood(room, spec);
  }
  // Fazla yem birikirse en eski sıradan yemleri kaldır (yeni eklenen yol yemleri sondadır)
  let i = 0;
  while (room.foods.length > MAX_FOODS && i < room.foods.length) {
    if (room.foods[i].type === 'num' || room.foods[i].type === 'op') { room.foods.splice(i, 1); room.foodsDirty = true; }
    else i++;
  }
}
// Yeni hedef: eskisiyle ve oyuncuların anlık değerleriyle aynı olmasın
function newTarget(room) {
  const avoid = new Set([room.target, ...room.snakes.map(s => s.value)]);
  let t;
  do { t = rnd(TARGET_MIN, TARGET_MAX); } while (avoid.has(t));
  return t;
}

// ---------- Oda ----------
function createSnake(p, idx) {
  const start = idx === 0 ? { x: 5, y: 5, dir: 'right', dx: -1 } : { x: COLS - 6, y: ROWS - 6, dir: 'left', dx: 1 };
  const body = [];
  for (let i = 0; i < START_LEN; i++) body.push({ x: start.x + start.dx * i, y: start.y });
  return { id: p.id, userId: p.userId, name: p.name, color: p.color, body, dir: start.dir, nextDir: start.dir,
    value: 0, op: '+', score: 0, grow: 0 };
}
function createGame(p1, p2) {
  const room = { snakes: [createSnake(p1, 0), createSnake(p2, 1)], foods: [], foodsDirty: true,
    target: null, resetLockedFor: null, lastScorer: null, events: [] };
  room.target = newTarget(room);
  refillFoods(room);
  ensureReachable(room);
  return room;
}

// Yem yeme. Dönüş: altın gol vb. için skor yapan oyuncu id'si (varsa)
function eat(room, s, index) {
  const f = room.foods.splice(index, 1)[0];
  room.foodsDirty = true;
  s.grow += 1;
  let scored = null;
  if (f.type === 'num') {
    s.value = applyOp(s.value, s.op, f.value);           // işlem kalıcı, değişmez
    room.events.push({ type: 'num', id: s.id });
    if (s.value === room.target) {
      s.score += 1;
      room.lastScorer = s.id;
      s.value = 0; s.op = '+';                           // yeni tura temiz başla
      room.target = newTarget(room);
      room.events.push({ type: 'score', id: s.id });
      scored = s.id;
    }
  } else if (f.type === 'op') {
    s.op = f.value;
    room.events.push({ type: 'op', id: s.id });
  } else if (f.type === 'reset') {                        // ⟲ değerler korunur, hedef değişir
    room.target = newTarget(room);
    room.resetLockedFor = s.id;
    room.events.push({ type: 'reset', id: s.id });
  } else if (f.type === 'zap') {                          // ⚡ rakibin değeri sıfırlanır
    const other = room.snakes.find(x => x !== s);
    other.value = 0; other.op = '+';
    room.events.push({ type: 'zap', id: s.id, victim: other.id });
  }
  refillFoods(room);
  ensureReachable(room);
  return scored;
}

function canEat(room, s, f) {
  return !(f.type === 'reset' && room.resetLockedFor === s.id);
}

// Bir adım ilerlet. Dönüş: bu adımda sayı yapan oyuncu id'leri
function step(room) {
  for (const s of room.snakes) {
    s.dir = s.nextDir;
    const d = DIRS[s.dir], h = s.body[0];
    s.body.unshift({ x: (h.x + d.x + COLS) % COLS, y: (h.y + d.y + ROWS) % ROWS }); // duvardan karşıya
    if (s.grow > 0) s.grow--; else s.body.pop();
  }
  const scorers = [];
  for (const s of room.snakes) { // yılanlar birbirinin içinden geçebilir
    const h = s.body[0];
    const i = room.foods.findIndex(f => f.x === h.x && f.y === h.y && canEat(room, s, f));
    if (i >= 0) { const sc = eat(room, s, i); if (sc) scorers.push(sc); }
  }
  return scorers;
}

function setDir(room, id, dir) {
  if (!DIRS[dir]) return;
  const s = room.snakes.find(x => x.id === id);
  if (s && OPPOSITE[s.dir] !== dir) s.nextDir = dir;
}

module.exports = { COLS, ROWS, OPS, applyOp, planPath, canReach, createGame, step, eat, setDir, ensureReachable, refillFoods };
