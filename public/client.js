// Cobrunner istemcisi
const socket = io();
const $ = id => document.getElementById(id);
const canvas = $('board'), ctx = canvas.getContext('2d');
const PALETTE = ['#22c55e', '#3b82f6', '#ef4444', '#eab308', '#a855f7', '#ec4899', '#f97316', '#06b6d4'];
const OP_SYMBOL = { '+': '+', '-': '−', 'x': '×', '/': '÷' };
const isTouch = window.matchMedia('(pointer: coarse)').matches;

let me = null, state = null, foods = [], cols = 18, rows = 24, cell = 20, dpr = 1, lastCountdown = 0;
let authMode = 'login', currentInvite = null, matchWeather = {};

const call = (event, data = {}) => new Promise(res => socket.emit(event, data, res));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const duration = () => Number(document.querySelector('input[name=dur]:checked').value);
function show(id) {
  for (const s of ['loading', 'auth', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== id);
  document.body.classList.toggle('playing', id === 'game');
}
function setMsg(el, text, good = false) { el.textContent = text || ''; el.classList.toggle('ok', good); }
let toastTimer;
function toast(text) {
  $('toast').textContent = text; $('toast').classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3500);
}
// Değişmeyen DOM'a dokunmamak için (performans)
function setText(el, v) { v = String(v); if (el.textContent !== v) el.textContent = v; }

// ================= Sesler (Web Audio, dosya gerekmez) =================
let audioCtx = null, muted = localStorage.getItem('cb_muted') === '1';
function initAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('pointerdown', initAudio);
document.addEventListener('keydown', initAudio);
function playTone(freq, dur, type = 'sine', vol = 0.15, delay = 0, endFreq = null) {
  if (muted || !audioCtx) return;
  const t = audioCtx.currentTime + delay;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(audioCtx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
const SOUNDS = {
  num: mine => playTone(mine ? 600 : 420, 0.08, 'sine', mine ? 0.18 : 0.07),
  op: mine => playTone(mine ? 820 : 560, 0.07, 'square', mine ? 0.08 : 0.04),
  reset: mine => playTone(mine ? 300 : 900, 0.35, 'sawtooth', 0.08, 0, mine ? 900 : 300),
  zap: mine => mine ? [880, 1320].forEach((f, i) => playTone(f, 0.12, 'square', 0.1, i * 0.08))
                    : playTone(500, 0.5, 'sawtooth', 0.12, 0, 80),
  score: mine => (mine ? [523, 659, 784, 1047] : [392, 330, 262]).forEach((f, i) => playTone(f, 0.14, 'triangle', 0.18, i * 0.1)),
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => playTone(f, 0.2, 'triangle', 0.2, i * 0.13)),
  lose: () => [440, 392, 330, 262].forEach((f, i) => playTone(f, 0.25, 'sine', 0.18, i * 0.16)),
  tick: last => playTone(last ? 1046 : 523, last ? 0.3 : 0.12, 'sine', 0.15),
  invite: () => [660, 880].forEach((f, i) => playTone(f, 0.15, 'triangle', 0.15, i * 0.15))
};
function updateMuteBtn() { $('muteBtn').textContent = muted ? '🔇' : '🔊'; }
$('muteBtn').addEventListener('click', () => { muted = !muted; localStorage.setItem('cb_muted', muted ? '1' : '0'); updateMuteBtn(); });
updateMuteBtn();

// ================= Oturum =================
socket.on('connect', async () => {
  const token = localStorage.getItem('cb_token');
  if (token) {
    const r = await call('resume', { token });
    if (r.ok) return enterLobby(r);
    localStorage.removeItem('cb_token');
  }
  show('auth');
});
socket.on('disconnect', () => { if (!state) show('loading'); });
socket.on('kicked', msg => { localStorage.removeItem('cb_token'); me = null; state = null; show('auth'); setMsg($('authMsg'), msg); });

function setAuthMode(mode) {
  authMode = mode;
  $('tabLogin').classList.toggle('active', mode === 'login');
  $('tabRegister').classList.toggle('active', mode === 'register');
  $('authSubmit').textContent = mode === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
  $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  setMsg($('authMsg'), '');
}
$('tabLogin').addEventListener('click', () => setAuthMode('login'));
$('tabRegister').addEventListener('click', () => setAuthMode('register'));
$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('authName').value.trim(), password = $('authPass').value;
  if (!username || !password) return setMsg($('authMsg'), 'Kullanıcı adı ve şifre gerekli.');
  $('authSubmit').disabled = true;
  const r = await call(authMode, { username, password, color: PALETTE[0] });
  $('authSubmit').disabled = false;
  if (!r.ok) return setMsg($('authMsg'), r.error);
  $('authPass').value = '';
  enterLobby(r);
});
$('logoutBtn').addEventListener('click', async () => {
  await call('logout');
  localStorage.removeItem('cb_token');
  me = null;
  show('auth');
});

let weatherStarted = false;
function enterLobby(r) {
  me = r.user;
  localStorage.setItem('cb_token', r.token);
  $('meName').textContent = me.username;
  renderColors();
  show('lobby');
  setSearching(false);
  loadSocial();
  loadStats();
  if (!weatherStarted) { weatherStarted = true; initWeather(false); }
  else if (myLocation) sendWeather(); // yeniden bağlanınca sunucuya tekrar bildir
}

// ================= Renk =================
function renderColors() {
  $('colors').innerHTML = '';
  PALETTE.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.style.background = c;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-label', 'Renk ' + c);
    b.setAttribute('aria-checked', String(c === me.color));
    b.addEventListener('click', async () => {
      const r = await call('setColor', { color: c });
      if (r.ok) { me.color = c; renderColors(); playTone(660, 0.06); }
    });
    $('colors').appendChild(b);
  });
}

// ================= Eşleştirme =================
function setSearching(on, text = '') {
  $('findBtn').classList.toggle('hidden', on);
  $('cancelBtn').classList.toggle('hidden', !on);
  setMsg($('status'), text, on);
}
$('findBtn').addEventListener('click', async () => {
  const r = await call('findMatch', { duration: duration() });
  if (!r.ok) return setMsg($('status'), r.error);
  setSearching(true, `${r.duration / 60} dakikalık maç için rakip aranıyor...`);
});
$('cancelBtn').addEventListener('click', async () => { await call('cancelFind'); setSearching(false); });

// ================= Arkadaşlar =================
async function loadSocial() {
  if (!me) return;
  const r = await call('social:get');
  if (!r.ok) return;
  $('incomingWrap').classList.toggle('hidden', !r.incoming.length);
  $('incoming').innerHTML = r.incoming.map(u => `<li><span class="name">${esc(u.username)}</span>
    <button type="button" data-act="accept" data-id="${u.id}">Kabul</button>
    <button type="button" class="secondary" data-act="decline" data-id="${u.id}">Reddet</button></li>`).join('');
  $('outgoingWrap').classList.toggle('hidden', !r.outgoing.length);
  $('outgoing').innerHTML = r.outgoing.map(u => `<li><span class="name muted">${esc(u.username)} (bekliyor)</span>
    <button type="button" class="secondary" data-act="remove" data-id="${u.id}">İptal</button></li>`).join('');
  $('friends').innerHTML = r.friends.length ? r.friends.map(f => {
    const st = f.inGame ? 'busy' : f.online ? 'on' : '';
    const label = f.inGame ? 'maçta' : f.online ? 'çevrimiçi' : 'çevrimdışı';
    return `<li><span class="dot ${st}" title="${label}"></span><span class="name">${esc(f.username)} <small class="muted">${label}</small></span>
      <button type="button" data-act="invite" data-id="${f.id}" data-name="${esc(f.username)}" ${f.online && !f.inGame ? '' : 'disabled'}>Davet Et</button>
      <button type="button" class="secondary" data-act="remove" data-id="${f.id}" aria-label="${esc(f.username)} arkadaşlıktan çıkar">✕</button></li>`;
  }).join('') : '<li class="muted">Henüz arkadaşın yok. Yukarıdan kullanıcı adıyla ekle.</li>';
}
socket.on('social:changed', () => { if (!state) loadSocial(); });

$('addFriendForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('friendName').value.trim();
  if (!username) return;
  const r = await call('friend:add', { username });
  setMsg($('friendMsg'), r.ok ? r.message : r.error, r.ok);
  if (r.ok) { $('friendName').value = ''; loadSocial(); }
});
for (const id of ['incoming', 'outgoing', 'friends']) {
  $(id).addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const userId = Number(b.dataset.id), act = b.dataset.act;
    let r;
    if (act === 'accept' || act === 'decline') r = await call('friend:respond', { userId, accept: act === 'accept' });
    else if (act === 'remove') {
      if (b.closest('#friends') && !confirm('Arkadaşlıktan çıkarılsın mı?')) return;
      r = await call('friend:remove', { userId });
    } else if (act === 'invite') {
      r = await call('invite:send', { userId, duration: duration() });
      if (r.ok) setMsg($('friendMsg'), `${b.dataset.name} davet edildi (${duration() / 60} dk). Yanıt bekleniyor...`, true);
    }
    if (r && !r.ok) setMsg($('friendMsg'), r.error);
    loadSocial();
  });
}

// ================= Davetler =================
socket.on('invite:received', inv => {
  currentInvite = inv;
  $('inviteText').innerHTML = `<b>${esc(inv.from)}</b> seni ${inv.duration / 60} dakikalık bir maça davet ediyor!`;
  $('inviteModal').classList.remove('hidden');
  SOUNDS.invite();
});
async function answerInvite(accept) {
  if (!currentInvite) return;
  const inv = currentInvite; currentInvite = null;
  $('inviteModal').classList.add('hidden');
  const r = await call('invite:respond', { inviteId: inv.inviteId, accept });
  if (!r.ok) toast(r.error);
}
$('inviteAccept').addEventListener('click', () => answerInvite(true));
$('inviteDecline').addEventListener('click', () => answerInvite(false));
socket.on('invite:cancelled', ({ inviteId }) => {
  if (currentInvite && currentInvite.inviteId === inviteId) { currentInvite = null; $('inviteModal').classList.add('hidden'); toast('Davet iptal oldu.'); }
});
socket.on('invite:declined', ({ by }) => setMsg($('friendMsg'), `${by} daveti reddetti.`));
socket.on('invite:expired', () => setMsg($('friendMsg'), 'Davete yanıt gelmedi.'));

// ================= Skorlar =================
async function loadStats() {
  const r = await call('stats:get');
  if (!r.ok) return;
  const s = r.stats;
  $('myStats').innerHTML = [['Maç', s.games], ['Galibiyet', s.wins], ['Mağlubiyet', s.losses], ['Toplam sayı', s.points], ['En iyi maç', s.best],
    ['Kazanma %', s.games ? Math.round(100 * s.wins / s.games) : 0]].map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
  $('recent').innerHTML = r.recent.length ? r.recent.map(m =>
    `<li><span class="${m.won ? 'win' : 'loss'}">${m.won ? 'G' : 'M'}</span><span class="name">${esc(m.opponent)}</span><b>${m.myScore} - ${m.oppScore}</b><small class="muted">${m.duration / 60} dk</small></li>`).join('')
    : '<li class="muted">Henüz maç yok.</li>';
  $('leaderboard').innerHTML = r.leaderboard.length ? r.leaderboard.map(u => `<li>${esc(u.username)} — <b>${u.wins}</b> galibiyet</li>`).join('')
    : '<li class="muted">Henüz kimse kazanmadı.</li>';
}

// ================= Konum ve hava durumu =================
// Sıra: GPS → IP konumu (BigDataCloud) → IP konumu (GeoJS) → İstanbul.
// Hava verisini tarayıcı çeker (Open-Meteo), olmazsa sunucu dener.
let myLocation = null, wxLoading = false;
const DEFAULT_LOC = { lat: 41.01, lon: 28.98, city: 'İstanbul', source: 'default' };

function fetchJSON(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .finally(() => clearTimeout(t));
}
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Tarayıcı konum desteklemiyor'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      err => reject(new Error(err.code === 1 ? 'Konum izni verilmedi' : 'Konum alınamadı')),
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 10 * 60 * 1000 });
  });
}
async function cityName(lat, lon) {
  try {
    const d = await fetchJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=tr`, 5000);
    return [d.city || d.locality, d.countryName].filter(Boolean).join(', ');
  } catch (e) { return ''; }
}
async function ipLocation() {
  try {
    const d = await fetchJSON('https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=tr', 5000);
    if (Number.isFinite(d.latitude)) return { lat: d.latitude, lon: d.longitude, city: [d.city || d.locality, d.countryName].filter(Boolean).join(', '), source: 'ip' };
  } catch (e) {}
  const g = await fetchJSON('https://get.geojs.io/v1/ip/geo.json', 5000);
  return { lat: parseFloat(g.latitude), lon: parseFloat(g.longitude), city: [g.city, g.country].filter(Boolean).join(', '), source: 'ip' };
}
async function locate(useGps) {
  let gpsError = '';
  if (useGps) {
    try { const p = await getPosition(); return { ...p, city: await cityName(p.lat, p.lon), source: 'gps' }; }
    catch (e) { gpsError = e.message; }
  }
  try { const l = await ipLocation(); if (Number.isFinite(l.lat)) return { ...l, gpsError }; } catch (e) {}
  return { ...DEFAULT_LOC, gpsError };
}
async function browserWeather(lat, lon) {
  try {
    const d = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,weather_code,is_day,wind_speed_10m&timezone=auto`);
    const c = d.current;
    return { code: c.weather_code, isDay: c.is_day === 1, temp: c.temperature_2m, wind: c.wind_speed_10m };
  } catch (e) { return null; }
}
async function sendWeather() {
  const raw = await browserWeather(myLocation.lat, myLocation.lon);
  const r = await call('weather:set', { ...myLocation, raw });
  if (!r.ok) throw new Error(r.error);
  if ($('wxDemo').value) await applyDemo(); else setMyWeather(r.weather);
}
// useGps: kullanıcı düğmeye bastığında GPS izni istenir (Safari için en sağlıklısı)
async function initWeather(useGps) {
  if (wxLoading) return;
  wxLoading = true;
  $('wxMain').textContent = '📍 Konum alınıyor...';
  $('wxSub').textContent = useGps ? 'Konum izni istenirse "İzin Ver" de.' : '';
  try {
    myLocation = await locate(useGps);
    await sendWeather();
  } catch (e) {
    $('wxMain').textContent = '⚠️ Hava durumu alınamadı';
    $('wxSub').textContent = e.message + ' — harita varsayılan temayla açılır. Sunum modundan tema seçebilirsin.';
  }
  wxLoading = false;
}
function setMyWeather(w) {
  if (!w) return;
  const src = { gps: 'GPS konumu', ip: 'yaklaşık konum (IP)', default: 'varsayılan konum' }[myLocation.source];
  $('wxMain').textContent = `${w.icon} ${w.label}${w.temp !== undefined ? ', ' + w.temp + '°C' : ''}${w.demo ? ' (sunum modu)' : ''}`;
  let sub = `📍 ${w.city || 'Bilinmeyen konum'} · ${src}`;
  if (myLocation.source !== 'gps') sub += myLocation.gpsError
    ? ` · ${myLocation.gpsError}. iPhone'da: Ayarlar › Gizlilik › Konum Servisleri › Safari › "Sorulsun" seç.`
    : ' · Tam konum için "Konumumu kullan"a bas.';
  $('wxSub').textContent = sub;
}
async function applyDemo() {
  const r = await call('weather:demo', { theme: $('wxDemo').value });
  if (r.ok && r.weather) setMyWeather(r.weather);
}
$('wxRefresh').addEventListener('click', () => initWeather(true));
$('wxDemo').addEventListener('change', applyDemo);
const wxText = w => w ? `${w.icon} ${w.city ? w.city.split(',')[0] + ' · ' : ''}${w.label}${w.temp !== undefined ? ' ' + w.temp + '°C' : ''}` : '';

// ================= Çizim katmanları (performans için önbellekli) =================
// 1) Arka plan + ızgara + sabit hava süsleri tek seferde ayrı bir canvas'a çizilir.
// 2) Yem görselleri bir kez çizilip önbellekten kopyalanır.
// 3) Her karede sadece: arka plan kopyası + yemler + yılanlar + hafif parçacıklar.
const SCENES = {
  sunny:  ['#14532d', '#166534'], night: ['#020617', '#0b1338'], cloudy: ['#1f2937', '#374151'],
  fog:    ['#334155', '#475569'], rain:  ['#0c1a2e', '#1e3a5f'], snow:   ['#1e293b', '#3b4f6b'],
  storm:  ['#030712', '#1e1b4b'], none:  ['#111827', '#111827']
};
let theme = 'none', bgLayer = null, cloudSprite = null, parts = [], flash = 0, frame = 0;
const foodCache = new Map();
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

function buildBackground() {
  const W = cols * cell, H = rows * cell;
  bgLayer = mkCanvas(Math.round(W * dpr), Math.round(H * dpr));
  const b = bgLayer.getContext('2d');
  b.scale(dpr, dpr);
  const [c1, c2] = SCENES[theme];
  const g = b.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, c1); g.addColorStop(1, c2);
  b.fillStyle = g; b.fillRect(0, 0, W, H);
  if (theme === 'sunny') {
    const rg = b.createRadialGradient(W * 0.85, H * 0.06, 4, W * 0.85, H * 0.06, H * 0.7);
    rg.addColorStop(0, 'rgba(253,224,71,0.45)'); rg.addColorStop(1, 'rgba(253,224,71,0)');
    b.fillStyle = rg; b.fillRect(0, 0, W, H);
    b.save(); b.translate(W * 0.85, H * 0.06); b.strokeStyle = 'rgba(253,224,71,0.13)'; b.lineWidth = cell * 0.6;
    for (let i = 0; i < 10; i++) { b.rotate(Math.PI / 5); b.beginPath(); b.moveTo(cell * 2, 0); b.lineTo(H * 0.55, 0); b.stroke(); }
    b.restore();
  } else if (theme === 'night') {
    b.fillStyle = '#fff';
    for (let i = 0; i < 70; i++) { b.globalAlpha = 0.3 + Math.random() * 0.7; b.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5); }
    b.globalAlpha = 1;
    b.fillStyle = 'rgba(254,249,195,0.85)'; b.beginPath(); b.arc(W * 0.82, H * 0.08, cell * 1.1, 0, 7); b.fill();
  } else if (theme === 'snow') {
    b.fillStyle = 'rgba(255,255,255,0.12)'; b.fillRect(0, H - cell, W, cell);
  } else if (theme === 'fog') {
    b.fillStyle = 'rgba(226,232,240,0.10)'; b.fillRect(0, 0, W, H);
  }
  // Izgara: tek path, tek stroke
  b.strokeStyle = 'rgba(255,255,255,0.06)'; b.lineWidth = 1;
  b.beginPath();
  for (let x = 0; x <= cols; x++) { b.moveTo(x * cell + 0.5, 0); b.lineTo(x * cell + 0.5, H); }
  for (let y = 0; y <= rows; y++) { b.moveTo(0, y * cell + 0.5); b.lineTo(W, y * cell + 0.5); }
  b.stroke();

  // Bulut / sis sprite'ı (bir kez)
  const R = Math.round(cell * 5 * dpr);
  cloudSprite = mkCanvas(R * 2, R * 2);
  const cg = cloudSprite.getContext('2d');
  const gr = cg.createRadialGradient(R, R, 0, R, R, R);
  gr.addColorStop(0, `rgba(226,232,240,${theme === 'fog' ? 0.28 : 0.16})`); gr.addColorStop(1, 'rgba(226,232,240,0)');
  cg.fillStyle = gr; cg.fillRect(0, 0, R * 2, R * 2);

  // Parçacıklar: alana göre ölçeklenir
  const area = cols * rows, Rn = Math.random;
  const n = { rain: area * 0.22, storm: area * 0.3, snow: area * 0.14, cloudy: 5, fog: 6 }[theme] || 0;
  parts = [];
  for (let i = 0; i < n; i++) {
    if (theme === 'rain' || theme === 'storm') parts.push({ x: Rn() * W, y: Rn() * H, v: (0.5 + Rn() * 0.4) * cell, l: (0.5 + Rn() * 0.5) * cell });
    else if (theme === 'snow') parts.push({ x: Rn() * W, y: Rn() * H, v: 0.05 * cell + Rn() * 0.06 * cell, r: 1.5 + Rn() * 2, p: Rn() * 6 });
    else parts.push({ x: Rn() * W, y: Rn() * H, v: 0.02 * cell + Rn() * 0.03 * cell });
  }
  foodCache.clear();
}

const FOOD_STYLE = {
  num:   { bg: '#f8fafc', fg: '#0f172a' },
  op:    { bg: '#f97316', fg: '#ffffff' },
  reset: { bg: '#a855f7', fg: '#ffffff' },
  zap:   { bg: '#dc2626', fg: '#fde047' }
};
function foodSprite(f, dim) {
  const label = f.type === 'num' ? String(f.value) : f.type === 'op' ? OP_SYMBOL[f.value] : f.type === 'reset' ? '⟲' : '⚡';
  const key = f.type + label + (dim ? 'd' : '');
  let c = foodCache.get(key);
  if (c) return c;
  const S = Math.round(cell * dpr);
  c = mkCanvas(S, S);
  const g = c.getContext('2d');
  const st = FOOD_STYLE[f.type];
  g.globalAlpha = dim ? 0.3 : 1;
  g.fillStyle = st.bg;
  g.beginPath(); g.arc(S / 2, S / 2, S * 0.48, 0, 7); g.fill();
  if (f.type === 'zap' || f.type === 'reset') { g.lineWidth = Math.max(1, S * 0.07); g.strokeStyle = '#fff'; g.stroke(); }
  g.fillStyle = st.fg;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `900 ${Math.round(S * (label.length > 1 ? 0.52 : 0.68))}px -apple-system, system-ui, sans-serif`;
  g.fillText(label, S / 2, S / 2 + S * 0.04);
  foodCache.set(key, c);
  return c;
}

function drawWeatherFx(W, H) {
  if (theme === 'rain' || theme === 'storm') {
    ctx.strokeStyle = theme === 'storm' ? 'rgba(199,210,254,0.4)' : 'rgba(147,197,253,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of parts) {
      p.y += p.v; p.x -= p.v * 0.2;
      if (p.y > H) { p.y = -p.l; p.x = Math.random() * W * 1.2; }
      ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.l * 0.2, p.y - p.l);
    }
    ctx.stroke();
    if (theme === 'storm') {
      if (flash <= 0 && Math.random() < 0.008) flash = 10;
      if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${(flash % 5 > 2 ? 0.3 : 0.1) * flash / 10})`; ctx.fillRect(0, 0, W, H); flash--; }
    }
  } else if (theme === 'snow') {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    for (const p of parts) {
      p.y += p.v; p.x += Math.sin(frame / 20 + p.p) * 0.4;
      if (p.y > H) { p.y = -4; p.x = Math.random() * W; }
      ctx.rect(p.x, p.y, p.r, p.r);
    }
    ctx.fill();
  } else if (theme === 'cloudy' || theme === 'fog') {
    const s = cloudSprite.width / dpr;
    for (const p of parts) {
      p.x += p.v; if (p.x - s / 2 > W) p.x = -s / 2;
      ctx.drawImage(cloudSprite, p.x - s / 2, p.y - s / 2, s, s);
    }
  }
}

// Ekranda kısa süreli uyarılar (ör. "⚡ Sıfırlandın!")
let banners = [];
function banner(text, color) { banners.push({ text, color, until: performance.now() + 1400 }); }

function render(now) {
  if (!state || !bgLayer) return;
  const W = cols * cell, H = rows * cell;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(bgLayer, 0, 0, W, H);

  for (const f of foods) {
    ctx.drawImage(foodSprite(f, f.type === 'reset' && state.lock === socket.id), f.x * cell, f.y * cell, cell, cell);
  }

  // Yılanlar (yarı saydam: üst üste geçince ikisi de görünür)
  for (const sn of state.s) {
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = sn.color;
    const pad = Math.max(1, cell * 0.1);
    for (let i = 1; i < sn.body.length; i++) {
      const p = sn.body[i];
      ctx.fillRect(p.x * cell + pad, p.y * cell + pad, cell - pad * 2, cell - pad * 2);
    }
    ctx.globalAlpha = 1;
    const h = sn.body[0];
    ctx.fillRect(h.x * cell, h.y * cell, cell, cell);
    ctx.strokeStyle = sn.id === socket.id ? '#facc15' : '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(h.x * cell + 1, h.y * cell + 1, cell - 2, cell - 2);
  }
  // Baş etiketi: değer ve işlem
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `800 ${Math.round(cell * 0.62)}px -apple-system, system-ui, sans-serif`;
  for (const sn of state.s) {
    const h = sn.body[0];
    const ly = h.y === 0 ? (h.y + 1.6) * cell : (h.y - 0.55) * cell;
    const text = `${sn.value} ${OP_SYMBOL[sn.op]}`;
    const tw = ctx.measureText(text).width + 8;
    ctx.fillStyle = 'rgba(15,23,42,0.8)';
    ctx.fillRect(h.x * cell + cell / 2 - tw / 2, ly - cell * 0.4, tw, cell * 0.8);
    ctx.fillStyle = sn.id === socket.id ? '#facc15' : '#fff';
    ctx.fillText(text, h.x * cell + cell / 2, ly + 1);
  }

  drawWeatherFx(W, H);

  if (banners.length) {
    banners = banners.filter(b => b.until > now);
    banners.forEach((b, i) => {
      ctx.font = `900 ${Math.round(cell * 1.1)}px -apple-system, system-ui, sans-serif`;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(b.text, W / 2, H * 0.3 + i * cell * 1.4);
      ctx.fillStyle = b.color; ctx.fillText(b.text, W / 2, H * 0.3 + i * cell * 1.4);
    });
  }

  if (state.cd > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#facc15'; ctx.font = `900 ${Math.round(cell * 5)}px -apple-system, system-ui, sans-serif`;
    ctx.fillText(state.cd, W / 2, H / 2);
  }
}

// 30 FPS ile sınırlı çizim döngüsü; sekme gizliyken tarayıcı kendisi durdurur
let rafId = null, lastDraw = 0;
function loop(now) {
  rafId = null;
  if (!state || $('game').classList.contains('hidden')) return;
  if (now - lastDraw >= 33) { lastDraw = now; frame++; render(now); }
  rafId = requestAnimationFrame(loop);
}
function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }

// ================= Maç =================
function resize() {
  const wrap = $('boardWrap');
  const availW = Math.min(wrap.clientWidth, 640);
  const availH = wrap.clientHeight;
  cell = Math.max(10, Math.floor(Math.min(availW / cols, availH / rows)));
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = cols * cell + 'px';
  canvas.style.height = rows * cell + 'px';
  canvas.width = Math.round(cols * cell * dpr);
  canvas.height = Math.round(rows * cell * dpr);
  buildBackground();
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state) resize(); }, 150); });

socket.on('matchFound', data => {
  cols = data.cols; rows = data.rows; lastCountdown = 0; foods = []; banners = [];
  matchWeather = data.weather || {};
  $('inviteModal').classList.add('hidden'); currentInvite = null;
  setSearching(false);
  $('overlay').classList.add('hidden');
  $('dpad').classList.toggle('hidden', !isTouch);
  show('game');
  const mine = matchWeather[socket.id];
  theme = mine && SCENES[mine.theme] ? mine.theme : 'none';
  $('wxBadge').textContent = mine ? `Haritan: ${wxText(mine)}` : '';
  hudCache = {};
  requestAnimationFrame(resize); // yerleşim oturduktan sonra ölç
});

socket.on('state', s => {
  if (s.f) foods = s.f;
  for (const ev of s.ev || []) {
    const mine = ev.id === socket.id;
    if (SOUNDS[ev.type]) SOUNDS[ev.type](mine);
    if (ev.type === 'score') banner(mine ? '+1 PUAN!' : 'Rakip sayı yaptı', mine ? '#86efac' : '#fca5a5');
    else if (ev.type === 'zap') banner(mine ? '⚡ Rakibi sıfırladın!' : '⚡ Sıfırlandın!', mine ? '#fde047' : '#f87171');
    else if (ev.type === 'reset') banner('⟲ Yeni hedef!', '#c4b5fd');
    if (ev.type === 'zap' && !mine && navigator.vibrate) navigator.vibrate(150);
  }
  if (s.cd !== lastCountdown) {
    if (s.cd > 0) SOUNDS.tick(false); else if (lastCountdown > 0) SOUNDS.tick(true);
    lastCountdown = s.cd;
  }
  state = s;
  renderHud();
  startLoop();
});

socket.on('gameOver', r => {
  const won = r.winnerId === socket.id;
  $('resultTitle').textContent = won ? '🏆 Kazandın!' : `😔 Kaybettin. Kazanan: ${r.winnerName}`;
  $('resultReason').textContent = r.reason;
  $('resultScores').textContent = r.scores.map(s => `${s.name}: ${s.score}`).join('  |  ');
  $('overlay').classList.remove('hidden');
  won ? SOUNDS.win() : SOUNDS.lose();
});
$('backBtn').addEventListener('click', () => {
  state = null;
  $('overlay').classList.add('hidden');
  if (!me) return show('auth');
  show('lobby');
  loadSocial(); loadStats();
});

// HUD: sadece değişen alanlar güncellenir
let hudCache = {};
function renderHud() {
  setText($('target'), state.t);
  const t = $('timer');
  if (state.ot) setText(t, 'ALTIN GOL!');
  else setText(t, `${Math.floor(state.rem / 60)}:${String(state.rem % 60).padStart(2, '0')}`);
  t.classList.toggle('ot', state.ot);
  state.s.forEach((sn, i) => {
    const el = $('p' + i), mine = sn.id === socket.id;
    if (hudCache['c' + i] !== sn.color + mine) {
      hudCache['c' + i] = sn.color + mine;
      el.classList.toggle('me', mine);
      const n = el.querySelector('.pname');
      n.textContent = sn.name + (mine ? ' (sen)' : ''); n.style.color = sn.color;
    }
    setText(el.querySelector('.pscore'), sn.score);
    const w = matchWeather[sn.id];
    setText(el.querySelector('.pval'), `${sn.value} ${OP_SYMBOL[sn.op]}${w ? ' · ' + w.icon + (w.temp !== undefined ? w.temp + '°' : '') : ''}`);
    if (mine) { setText($('myVal'), sn.value); setText($('myOp'), OP_SYMBOL[sn.op]); }
  });
  setText($('resetInfo'), !state.lock ? '⟲ ikinizde' : state.lock === socket.id ? '⟲ rakipte' : '⟲ sende');
}

// ================= Kontroller =================
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
let lastDir = null;
function sendDir(dir) { if (state) { socket.emit('dir', dir); lastDir = dir; } }
document.addEventListener('keydown', e => {
  if (!state || $('game').classList.contains('hidden')) return;
  const dir = KEYS[e.key];
  if (dir) { e.preventDefault(); sendDir(dir); }
});
// Ekran yön tuşları: pointerdown ile anında tepki
$('dpad').addEventListener('pointerdown', e => {
  const b = e.target.closest('button[data-dir]');
  if (!b) return;
  e.preventDefault();
  sendDir(b.dataset.dir);
  b.classList.add('on'); setTimeout(() => b.classList.remove('on'), 120);
});
// Kaydırma: parmak hareket ederken de yön değişir
let touchStart = null;
const boardWrap = $('boardWrap');
boardWrap.addEventListener('touchstart', e => { const t = e.touches[0]; touchStart = { x: t.clientX, y: t.clientY }; }, { passive: true });
boardWrap.addEventListener('touchmove', e => {
  e.preventDefault();
  if (!touchStart) return;
  const t = e.touches[0], dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
  sendDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: false });
boardWrap.addEventListener('touchend', () => { touchStart = null; });
