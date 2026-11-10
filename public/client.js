const socket = io();
const $ = id => document.getElementById(id);
const canvas = $('board'), ctx = canvas.getContext('2d');
const PALETTE = ['#22c55e', '#3b82f6', '#ef4444', '#eab308', '#a855f7', '#ec4899', '#f97316', '#06b6d4'];
const OP_SYMBOL = { '+': '+', '-': '−', 'x': '×', '/': '÷' };
let me = null, state = null, cols = 40, rows = 28, cell = 20, lastCountdown = 0;
let authMode = 'login', currentInvite = null, searching = false;

const call = (event, data = {}) => new Promise(res => socket.emit(event, data, res));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const duration = () => Number(document.querySelector('input[name=dur]:checked').value);
function show(id) {
  for (const s of ['loading', 'auth', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== id);
}
function setMsg(el, text, good = false) { el.textContent = text || ''; el.classList.toggle('ok', good); }
let toastTimer;
function toast(text) {
  $('toast').textContent = text; $('toast').classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3500);
}

// ================= Sesler (Web Audio, dosya gerekmez) =================
let audioCtx = null, muted = localStorage.getItem('sy_muted') === '1';
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
  score: mine => (mine ? [523, 659, 784, 1047] : [392, 330, 262]).forEach((f, i) => playTone(f, 0.14, 'triangle', 0.18, i * 0.1)),
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => playTone(f, 0.2, 'triangle', 0.2, i * 0.13)),
  lose: () => [440, 392, 330, 262].forEach((f, i) => playTone(f, 0.25, 'sine', 0.18, i * 0.16)),
  tick: last => playTone(last ? 1046 : 523, last ? 0.3 : 0.12, 'sine', 0.15),
  invite: () => [660, 880].forEach((f, i) => playTone(f, 0.15, 'triangle', 0.15, i * 0.15))
};
function updateMuteBtn() { $('muteBtn').textContent = muted ? '🔇' : '🔊'; }
$('muteBtn').addEventListener('click', () => { muted = !muted; localStorage.setItem('sy_muted', muted ? '1' : '0'); updateMuteBtn(); });
updateMuteBtn();

// ================= Bağlantı ve oturum =================
socket.on('connect', async () => {
  const token = localStorage.getItem('sy_token');
  if (token) {
    const r = await call('resume', { token });
    if (r.ok) return enterLobby(r);
    localStorage.removeItem('sy_token');
  }
  show('auth');
});
socket.on('disconnect', () => { if (!state) show('loading'); });
socket.on('kicked', msg => { localStorage.removeItem('sy_token'); me = null; show('auth'); setMsg($('authMsg'), msg); });

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
  localStorage.removeItem('sy_token');
  me = null; searching = false;
  show('auth');
});

function enterLobby(r) {
  me = r.user;
  localStorage.setItem('sy_token', r.token);
  $('meName').textContent = me.username;
  renderColors();
  show('lobby');
  setSearching(false);
  loadSocial();
  loadStats();
  initWeather();
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
  searching = on;
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
socket.on('social:changed', loadSocial);

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
socket.on('invite:declined', ({ by }) => { setMsg($('friendMsg'), `${by} daveti reddetti.`); });
socket.on('invite:expired', () => { setMsg($('friendMsg'), 'Davete yanıt gelmedi.'); });

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
let myLocation = null, myWeather = null, wxLoading = false;
const BDC = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const DEFAULT_LOC = { lat: 41.01, lon: 28.98, city: 'İstanbul (varsayılan)', source: 'default' };

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Tarayıcı konum desteklemiyor'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      reject, { timeout: 10000, maximumAge: 10 * 60 * 1000 });
  });
}
async function reverseGeocode(coords) {
  // Koordinat verilmezse BigDataCloud IP'ye göre yaklaşık konum döndürür
  const q = coords ? `?latitude=${coords.lat}&longitude=${coords.lon}&localityLanguage=tr` : '?localityLanguage=tr';
  const r = await fetch(BDC + q);
  if (!r.ok) throw new Error('Konum servisi hatası');
  const d = await r.json();
  return { lat: d.latitude, lon: d.longitude, city: [d.city || d.locality, d.countryName].filter(Boolean).join(', ') };
}
async function locate() {
  try {
    const pos = await getPosition();
    let city = '';
    try { city = (await reverseGeocode(pos)).city; } catch (e) {}
    return { ...pos, city, source: 'gps' };
  } catch (e) {
    try { return { ...(await reverseGeocode(null)), source: 'ip' }; }
    catch (e2) { return DEFAULT_LOC; }
  }
}
async function initWeather(force = false) {
  if (wxLoading) return;
  wxLoading = true;
  $('wxMain').textContent = '📍 Konum alınıyor...';
  $('wxSub').textContent = 'Tarayıcı konum izni isterse "İzin ver" de.';
  try {
    if (!myLocation || force) myLocation = await locate();
    const r = await call('weather:set', myLocation);
    if (!r.ok) throw new Error(r.error);
    if ($('wxDemo').value) await applyDemo();
    else setMyWeather(r.weather);
  } catch (e) {
    $('wxMain').textContent = '⚠️ Hava durumu alınamadı';
    $('wxSub').textContent = 'Harita varsayılan temayla açılacak. (' + e.message + ')';
  }
  wxLoading = false;
}
function setMyWeather(w) {
  myWeather = w;
  if (!w) return;
  const src = myLocation.source === 'gps' ? 'GPS konumu' : myLocation.source === 'ip' ? 'yaklaşık konum (IP)' : 'konum izni yok';
  $('wxMain').textContent = `${w.icon} ${w.label}${w.temp !== undefined ? ', ' + w.temp + '°C' : ''}${w.demo ? ' (sunum modu)' : ''}`;
  $('wxSub').textContent = `📍 ${w.city || 'Bilinmeyen konum'} · ${src}${w.wind !== undefined ? ' · rüzgâr ' + w.wind + ' km/sa' : ''}`;
}
async function applyDemo() {
  const r = await call('weather:demo', { theme: $('wxDemo').value });
  if (r.ok) setMyWeather(r.weather);
}
$('wxRefresh').addEventListener('click', () => initWeather(true));
$('wxDemo').addEventListener('change', applyDemo);
const wxText = w => w ? `${w.icon} ${w.city ? w.city.split(',')[0] + ' · ' : ''}${w.label}${w.temp !== undefined ? ' ' + w.temp + '°C' : ''}` : 'Hava bilgisi yok';

// ================= Hava efektleri (harita) =================
const SCENES = {
  sunny:  { bg: ['#14532d', '#166534'], grid: 'rgba(255,255,255,0.06)' },
  night:  { bg: ['#020617', '#0b1338'], grid: 'rgba(255,255,255,0.04)' },
  cloudy: { bg: ['#1f2937', '#374151'], grid: 'rgba(255,255,255,0.05)' },
  fog:    { bg: ['#334155', '#475569'], grid: 'rgba(255,255,255,0.04)' },
  rain:   { bg: ['#0c1a2e', '#1e3a5f'], grid: 'rgba(147,197,253,0.06)' },
  snow:   { bg: ['#1e293b', '#3b4f6b'], grid: 'rgba(255,255,255,0.07)' },
  storm:  { bg: ['#030712', '#1e1b4b'], grid: 'rgba(196,181,253,0.05)' },
  none:   { bg: ['#111827', '#111827'], grid: 'rgba(255,255,255,0.04)' }
};
let fx = { theme: 'none', parts: [], flash: 0, t: 0 };
function initFx(theme) {
  fx = { theme: SCENES[theme] ? theme : 'none', parts: [], flash: 0, t: 0 };
  const W = canvas.width, H = canvas.height, R = Math.random;
  const n = { rain: 160, storm: 220, snow: 120, night: 90, cloudy: 7, fog: 6, sunny: 0 }[fx.theme] || 0;
  for (let i = 0; i < n; i++) {
    if (fx.theme === 'rain' || fx.theme === 'storm') fx.parts.push({ x: R() * W, y: R() * H, v: 9 + R() * 7, l: 10 + R() * 12 });
    else if (fx.theme === 'snow') fx.parts.push({ x: R() * W, y: R() * H, v: 0.6 + R() * 1.2, r: 1.5 + R() * 2.5, p: R() * 6 });
    else if (fx.theme === 'night') fx.parts.push({ x: R() * W, y: R() * H, r: 0.6 + R() * 1.4, p: R() * 6 });
    else fx.parts.push({ x: R() * W, y: R() * H, v: 0.2 + R() * 0.4, w: 120 + R() * 200, h: 50 + R() * 60 });
  }
}
function drawBackground() {
  const s = SCENES[fx.theme], W = canvas.width, H = canvas.height;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, s.bg[0]); g.addColorStop(1, s.bg[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (fx.theme === 'sunny') { // güneş ışıltısı
    const pulse = 0.85 + 0.15 * Math.sin(fx.t / 40);
    const rg = ctx.createRadialGradient(W * 0.9, H * 0.08, 10, W * 0.9, H * 0.08, H * 0.9 * pulse);
    rg.addColorStop(0, 'rgba(253,224,71,0.45)'); rg.addColorStop(1, 'rgba(253,224,71,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(W * 0.9, H * 0.08); ctx.rotate(fx.t / 300);
    ctx.strokeStyle = 'rgba(253,224,71,0.18)'; ctx.lineWidth = cell * 0.6;
    for (let i = 0; i < 12; i++) { ctx.rotate(Math.PI / 6); ctx.beginPath(); ctx.moveTo(cell * 2, 0); ctx.lineTo(H * 0.6, 0); ctx.stroke(); }
    ctx.restore();
  }
  if (fx.theme === 'night') {
    for (const p of fx.parts) {
      ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(fx.t / 50 + p.p));
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (fx.theme === 'snow') { // yerde kar birikintisi
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(0, H - cell * 1.2, W, cell * 1.2);
  }
  ctx.strokeStyle = s.grid;
  for (let x = 0; x <= cols; x++) { ctx.beginPath(); ctx.moveTo(x * cell, 0); ctx.lineTo(x * cell, H); ctx.stroke(); }
  for (let y = 0; y <= rows; y++) { ctx.beginPath(); ctx.moveTo(0, y * cell); ctx.lineTo(W, y * cell); ctx.stroke(); }
}
function drawOverlay() {
  const W = canvas.width, H = canvas.height, th = fx.theme;
  if (th === 'rain' || th === 'storm') {
    ctx.strokeStyle = th === 'storm' ? 'rgba(199,210,254,0.45)' : 'rgba(147,197,253,0.45)'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const p of fx.parts) {
      p.y += p.v; p.x -= p.v * 0.25;
      if (p.y > H) { p.y = -p.l; p.x = Math.random() * W * 1.2; }
      ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.l * 0.25, p.y - p.l);
    }
    ctx.stroke();
    if (th === 'storm') { // şimşek
      if (fx.flash <= 0 && Math.random() < 0.006) fx.flash = 14;
      if (fx.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${(fx.flash % 7 > 3 ? 0.35 : 0.12) * fx.flash / 14})`;
        ctx.fillRect(0, 0, W, H); fx.flash--;
      }
    }
  } else if (th === 'snow') {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const p of fx.parts) {
      p.y += p.v; p.x += Math.sin(fx.t / 30 + p.p) * 0.5;
      if (p.y > H) { p.y = -5; p.x = Math.random() * W; }
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
  } else if (th === 'cloudy' || th === 'fog') {
    for (const p of fx.parts) {
      p.x += p.v; if (p.x - p.w > W) p.x = -p.w;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.w);
      const a = th === 'fog' ? 0.22 : 0.12;
      g.addColorStop(0, `rgba(226,232,240,${a})`); g.addColorStop(1, 'rgba(226,232,240,0)');
      ctx.fillStyle = g; ctx.fillRect(p.x - p.w, p.y - p.w, p.w * 2, p.w * 2);
    }
  }
}
// Sürekli animasyon döngüsü (sunucu durumu 120 ms'de bir gelir, hava efektleri her karede akar)
let rafId = null;
function loop() {
  fx.t++;
  render();
  rafId = state && !$('game').classList.contains('hidden') ? requestAnimationFrame(loop) : null;
}
function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }

// ================= Maç =================
let matchWeather = {};
socket.on('matchFound', data => {
  cols = data.cols; rows = data.rows; lastCountdown = 0;
  matchWeather = data.weather || {};
  $('inviteModal').classList.add('hidden'); currentInvite = null;
  setSearching(false);
  $('overlay').classList.add('hidden');
  show('game');
  resize();
  const mine = matchWeather[socket.id];
  initFx(mine ? mine.theme : 'none');
  $('wxBadge').textContent = mine ? `Haritan: ${wxText(mine)}` : 'Hava bilgisi yok, varsayılan harita';
});
socket.on('state', s => {
  for (const ev of s.events || []) SOUNDS[ev.type] && SOUNDS[ev.type](ev.id === socket.id);
  if (s.countdown !== lastCountdown) {
    if (s.countdown > 0) SOUNDS.tick(false);
    else if (lastCountdown > 0) SOUNDS.tick(true);
    lastCountdown = s.countdown;
  }
  state = s; renderHud(); startLoop();
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

function resize() {
  const maxW = Math.min(window.innerWidth - 20, 1000);
  const maxH = window.innerHeight - 140;
  cell = Math.max(8, Math.floor(Math.min(maxW / cols, maxH / rows)));
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  if (fx.theme !== 'none') initFx(fx.theme);
  render();
}
window.addEventListener('resize', () => { if (state) resize(); });

// ---- Kontroller ----
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
document.addEventListener('keydown', e => {
  if (!state || $('game').classList.contains('hidden')) return;
  const dir = KEYS[e.key];
  if (dir) { e.preventDefault(); socket.emit('dir', dir); }
});
let touchStart = null;
canvas.addEventListener('touchstart', e => { const t = e.touches[0]; touchStart = { x: t.clientX, y: t.clientY }; }, { passive: true });
canvas.addEventListener('touchend', e => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) > 20) {
    socket.emit('dir', Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  }
  touchStart = null;
});

// ---- Çizim ----
function renderHud() {
  $('target').textContent = state.target;
  const t = $('timer');
  if (state.overtime) { t.textContent = 'ALTIN GOL!'; t.classList.add('ot'); }
  else {
    const m = Math.floor(state.remaining / 60), s = String(state.remaining % 60).padStart(2, '0');
    t.textContent = `${m}:${s}`; t.classList.remove('ot');
  }
  const locked = state.resetLockedFor;
  $('resetInfo').textContent = !locked ? '⟲ hakkı: ikinizde' : locked === socket.id ? '⟲ hakkı: rakipte' : '⟲ hakkı: sende';
  state.snakes.forEach((sn, i) => {
    const el = $('p' + i), mine = sn.id === socket.id;
    el.classList.toggle('me', mine);
    el.innerHTML = `<div style="color:${sn.color};font-weight:700">${esc(sn.name)}${mine ? ' (SEN)' : ''}</div>
      <div class="score">${sn.score}</div>
      <div>Değer: <b>${sn.value}</b> &nbsp; Sıradaki işlem: <b>${OP_SYMBOL[sn.op]}</b></div>
      <div class="wx">${esc(wxText(matchWeather[sn.id]))}</div>`;
  });
}

function render() {
  if (!state) return;
  drawBackground();

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const f of state.foods) {
    const cx = f.x * cell + cell / 2, cy = f.y * cell + cell / 2;
    ctx.globalAlpha = f.type === 'reset' && state.resetLockedFor === socket.id ? 0.35 : 1; // kullanamadığın ⟲ soluk
    ctx.fillStyle = f.type === 'num' ? '#e2e8f0' : f.type === 'op' ? '#f97316' : '#a855f7';
    ctx.beginPath(); ctx.arc(cx, cy, cell * 0.48, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = f.type === 'num' ? '#0f172a' : '#fff';
    const label = f.type === 'num' ? String(f.value) : f.type === 'op' ? OP_SYMBOL[f.value] : '⟲';
    ctx.font = `bold ${Math.floor(cell * (label.length > 1 ? 0.5 : 0.65))}px system-ui`;
    ctx.fillText(label, cx, cy + 1);
    ctx.globalAlpha = 1;
  }

  for (const sn of state.snakes) {
    ctx.globalAlpha = 0.85; // yarı saydam: üst üste geçince ikisi de görünür
    sn.body.forEach((p, i) => {
      ctx.fillStyle = sn.color;
      const pad = i === 0 ? 0 : 2;
      ctx.fillRect(p.x * cell + pad, p.y * cell + pad, cell - pad * 2, cell - pad * 2);
    });
    ctx.globalAlpha = 1;
    const h = sn.body[0];
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.floor(cell * 0.6)}px system-ui`;
    ctx.fillText(sn.value, h.x * cell + cell / 2, h.y * cell - cell * 0.4 < 0 ? h.y * cell + cell * 1.5 : h.y * cell - cell * 0.4);
  }

  drawOverlay();

  if (state.countdown > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#facc15'; ctx.font = `bold ${cell * 5}px system-ui`;
    ctx.fillText(state.countdown, canvas.width / 2, canvas.height / 2);
  }
}
