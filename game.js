// Cobrunner oyun kuralları (ağdan bağımsız, test edilebilir saf mantık)
const COLS = 18, ROWS = 24;          // mobil dikey ekrana uygun ızgara
const START_LEN = 3;
const FOOD_COUNT = 10;               // normal yem sayısı
const MAX_FOODS = 15;                // ekran kalabalıklaşmasın
const TARGET_MIN = 15, TARGET_MAX = 60;
const NUM_MIN = 1, NUM_MAX = 12;     // ekrandaki sayı yemleri bu aralıkta
const VALUE_LIMIT = 9999;
const FREEZE_MS = 5000;              // 🧊 dondurma süresi
const OPS = ['+', '-', 'x', '/'];
const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const lengthOf = s => s.body.length + s.grow;

// İşlem kuralları: eksiye düşmez, bölmede aşağı yuvarlanır, üst sınır 9999.
function applyOp(v, op, n) {
  let r = v;
  if (op === '+') r = v + n;
  else if (op === '-') r = v - n;
  else if (op === 'x') r = v * n;
  else if (op === '/') r = Math.floor(v / n);
  return Math.max(0, Math.min(VALUE_LIMIT, r));
}

// ---------- Yemler ----------
let foodSeq = 0;
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
  const f = { id: ++foodSeq, ...freeCell(room), ...spec };
  room.foods.push(f);
  room.foodsDirty = true;
  return f;
}
const SPECIALS = ['reset', 'zap', 'freeze']; // ⟲ hedef yenile, ⚡ rakibi sıfırla, 🧊 rakibi dondur
function randomFoodSpec(room) {
  const r = Math.random();
  if (r < 0.58) return { type: 'num', value: rnd(NUM_MIN, NUM_MAX) };
  if (r < 0.86) return { type: 'op', value: OPS[rnd(0, 3)] };
  const free = SPECIALS.filter(t => !room.foods.some(f => f.type === t)); // her özel yemden en fazla 1
  if (free.length) return { type: free[rnd(0, free.length - 1)] };
  return { type: 'num', value: rnd(NUM_MIN, NUM_MAX) };
}
function refillFoods(room) {
  let normal = room.foods.filter(f => f.type === 'num' || f.type === 'op').length;
  while (normal < FOOD_COUNT) { const f = addFood(room, randomFoodSpec(room)); if (f.type === 'num' || f.type === 'op') normal++; }
}

// ---------- Hedefe ulaşılabilirlik ----------
// İşlem kalıcıdır: yeni işlem yemi alınana kadar her sayı son işlemle uygulanır.
function canReach(v, op, foods, t, depth, used = 0, lastWasOp = false) {
  for (let i = 0; i < foods.length; i++) {
    if (used & (1 << i)) continue;
    const f = foods[i];
    if (f.type === 'op') {
      if (lastWasOp || f.value === op || depth < 2) continue; // art arda iki işlem anlamsız
      if (canReach(v, f.value, foods, t, depth - 1, used | (1 << i), true)) return true;
    } else {
      const nv = applyOp(v, op, f.value);
      if (nv === t) return true;
      if (depth > 1 && nv !== v && canReach(nv, op, foods, t, depth - 1, used | (1 << i), false)) return true;
    }
  }
  return false;
}

// Hedefe giden yol üretir. Kurallar: en az 2 sayı yemi gerekir (hedef sayı tek yemle "hazır" çıkmaz),
// sayılar 1-12 aralığında, mümkün olan en kısa yol; aynı uzunluktaki yollar arasından rastgele.
function planPath(v, op, t) {
  for (let maxLen = 2; maxLen <= 8; maxLen++) {
    const failed = new Set();
    const path = [];
    const dfs = (val, cur, nums, rem, lastOp) => {
      const key = val + cur + rem + (nums >= 2 ? 2 : nums) + lastOp;
      if (failed.has(key)) return false;
      const moves = [];
      for (let n = NUM_MIN; n <= NUM_MAX; n++) moves.push(['num', n]);
      if (!lastOp && rem >= 2) for (const o of OPS) if (o !== cur) moves.push(['op', o]);
      for (const [type, value] of shuffle(moves)) {
        if (type === 'num') {
          const nv = applyOp(val, cur, value);
          if (nv === t) {
            if (nums + 1 >= 2) { path.push({ type, value }); return true; }
            continue; // tek yemde hedef = çok kolay, izin verme
          }
          if (rem > 1 && nv !== val) {
            path.push({ type, value });
            if (dfs(nv, cur, nums + 1, rem - 1, false)) return true;
            path.pop();
          }
        } else {
          path.push({ type, value });
          if (dfs(val, value, nums, rem - 1, true)) return true;
          path.pop();
        }
      }
      failed.add(key);
      return false;
    };
    if (dfs(v, op, 0, maxLen, false)) return path;
  }
  // Pratikte buraya gelinmez: sıfırdan başlayan güvenli yol
  const a = Math.max(1, Math.min(NUM_MAX, t - 1));
  return [{ type: 'op', value: '/' }, { type: 'num', value: 12 }, { type: 'num', value: 12 }, { type: 'num', value: 12 },
    { type: 'num', value: 12 }, { type: 'op', value: '+' }, { type: 'num', value: a }, { type: 'num', value: t - a }];
}

// Oyuncunun önceden hazırlanmış yolu hâlâ geçerli mi? (kalan yol yemleri sırayla yenirse hedefe varır mı)
function planStillValid(room, s) {
  if (!s.plan) return false;
  const rest = s.plan.map(id => room.foods.find(f => f.id === id)).filter(Boolean);
  if (!rest.length) return false;
  let v = s.value, op = s.op;
  for (const f of rest) { if (f.type === 'op') op = f.value; else v = applyOp(v, op, f.value); }
  return v === room.target;
}

function trimFoods(room) {
  // Fazla yem birikirse, hiçbir oyuncunun yolunda olmayan en eski sıradan yemleri kaldır
  const keep = new Set(room.snakes.flatMap(s => s.plan || []));
  for (let i = 0; room.foods.length > MAX_FOODS && i < room.foods.length;) {
    const f = room.foods[i];
    if ((f.type === 'num' || f.type === 'op') && !keep.has(f.id)) { room.foods.splice(i, 1); room.foodsDirty = true; }
    else i++;
  }
}
// Önce fazlalık temizlenir, sonra her oyuncu için hedefe ulaşılabilirlik kontrol edilir
function ensureReachable(room) {
  for (const s of room.snakes) if (!planStillValid(room, s)) s.plan = null;
  trimFoods(room);
  for (const s of room.snakes) {
    if (s.plan) continue;
    const usable = room.foods.filter(f => f.type === 'num' || f.type === 'op').slice(0, 20);
    if (canReach(s.value, s.op, usable, room.target, 5)) continue;
    s.plan = planPath(s.value, s.op, room.target).map(spec => addFood(room, spec).id);
  }
}

function newTarget(room) {
  const avoid = new Set([room.target, ...room.snakes.map(s => s.value)]);
  let t;
  do { t = rnd(TARGET_MIN, TARGET_MAX); } while (avoid.has(t));
  return t;
}

// ---------- Oda ----------
function createSnake(p, idx) {
  const st = idx === 0 ? { x: 5, y: 5, dir: 'right', dx: -1 } : { x: COLS - 6, y: ROWS - 6, dir: 'left', dx: 1 };
  const body = [];
  for (let i = 0; i < START_LEN; i++) body.push({ x: st.x + st.dx * i, y: st.y });
  return { id: p.id, userId: p.userId, name: p.name, color: p.color, body, dir: st.dir, nextDir: st.dir,
    value: 0, op: '+', score: 0, grow: 0, frozenUntil: 0, plan: null, bonus: 0 };
}
function createGame(p1, p2) {
  const room = { snakes: [createSnake(p1, 0), createSnake(p2, 1)], foods: [], foodsDirty: true,
    target: null, resetLockedFor: null, lastScorer: null, events: [] };
  room.target = newTarget(room);
  refillFoods(room);
  ensureReachable(room);
  return room;
}

// Yem yeme. Dönüş: sayı yapıldıysa oyuncu id'si
function eat(room, s, index, now) {
  const f = room.foods.splice(index, 1)[0];
  room.foodsDirty = true;
  s.grow += 1;
  let scored = null;
  const other = room.snakes.find(x => x !== s);
  if (f.type === 'num') {
    s.value = applyOp(s.value, s.op, f.value);
    room.events.push({ type: 'num', id: s.id });
    if (s.value === room.target) {
      s.score += 1;
      room.lastScorer = s.id;
      s.value = 0; s.op = '+';
      room.target = newTarget(room);
      room.events.push({ type: 'score', id: s.id });
      scored = s.id;
    }
  } else if (f.type === 'op') {
    s.op = f.value;
    room.events.push({ type: 'op', id: s.id });
  } else if (f.type === 'reset') {              // ⟲ değerler korunur, hedef değişir (sırayla)
    room.target = newTarget(room);
    room.resetLockedFor = s.id;
    room.events.push({ type: 'reset', id: s.id });
  } else if (f.type === 'zap') {                // ⚡ rakibin değeri sıfırlanır
    other.value = 0; other.op = '+';
    room.events.push({ type: 'zap', id: s.id });
  } else if (f.type === 'freeze') {             // 🧊 rakip 5 sn donar (ilk alan kullanır)
    other.frozenUntil = now + FREEZE_MS;
    room.events.push({ type: 'freeze', id: s.id });
  }
  refillFoods(room);
  ensureReachable(room);
  return scored;
}

const canEat = (room, s, f) => !(f.type === 'reset' && room.resetLockedFor === s.id);
const same = (a, b) => a.x === b.x && a.y === b.y;

// Bir adım ilerlet. Dönüş: bu adımda sayı yapan oyuncu id'leri
function step(room, now) {
  const moved = [];
  for (const s of room.snakes) {
    if (s.frozenUntil > now) continue;           // donmuş kobra hareket etmez
    s.dir = s.nextDir;
    const d = DIRS[s.dir], h = s.body[0];
    s.body.unshift({ x: (h.x + d.x + COLS) % COLS, y: (h.y + d.y + ROWS) % ROWS }); // duvardan karşıya
    if (s.grow > 0) s.grow--; else s.body.pop();
    moved.push(s);
  }
  // Çarpışmalar: önce hepsi hesaplanır, sonra uygulanır (aynı anda ısırma adil olsun)
  const cuts = new Map(); // kobra -> { at, by }
  const setCut = (victim, at, by) => { const c = cuts.get(victim); if (!c || at < c.at) cuts.set(victim, { at, by }); };
  for (const s of moved) {
    const h = s.body[0];
    for (let i = 1; i < s.body.length; i++) if (same(s.body[i], h)) { setCut(s, i, s); break; }   // kendi kuyruğu
    const o = room.snakes.find(x => x !== s);
    for (let j = 0; j < o.body.length; j++) {
      if (!same(o.body[j], h)) continue;
      if (j > 0) setCut(o, j, s);                 // rakibi ısırdığı yerden keser; kafa kafaya olursa bir şey olmaz
      break;
    }
  }
  for (const [victim, { at, by }] of cuts) {
    const lost = victim.body.length - at;
    victim.body.length = at;
    victim.grow = 0;
    room.events.push({ type: by === victim ? 'selfcut' : 'bite', id: by.id, victim: victim.id, n: lost });
  }
  // Yem
  const scorers = [];
  for (const s of moved) {
    const h = s.body[0];
    const i = room.foods.findIndex(f => same(f, h) && canEat(room, s, f));
    if (i >= 0) { const sc = eat(room, s, i, now); if (sc) scorers.push(sc); }
  }
  return scorers;
}

function setDir(room, id, dir) {
  if (!DIRS[dir]) return;
  const s = room.snakes.find(x => x.id === id);
  if (s && OPPOSITE[s.dir] !== dir) s.nextDir = dir;
}

module.exports = { COLS, ROWS, OPS, FREEZE_MS, applyOp, planPath, canReach, createGame, step, eat, setDir, ensureReachable, lengthOf };
