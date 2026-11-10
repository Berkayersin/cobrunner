// Hava durumu: tarayıcı Open-Meteo'dan veriyi kendisi çeker, sunucu doğrular ve temaya çevirir.
// Tarayıcı çekemezse sunucu yedek olarak dener. Kaynak: Open-Meteo (https://open-meteo.com)
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

const THEMES = {
  sunny:  { label: 'Güneşli',               icon: '☀️' },
  night:  { label: 'Açık gece',             icon: '🌙' },
  cloudy: { label: 'Bulutlu',               icon: '☁️' },
  fog:    { label: 'Sisli',                 icon: '🌫️' },
  rain:   { label: 'Yağmurlu',              icon: '🌧️' },
  snow:   { label: 'Karlı',                 icon: '❄️' },
  storm:  { label: 'Gök gürültülü fırtına', icon: '⛈️' }
};

function themeFromCode(code, isDay) {
  if (code === 0 || code === 1) return isDay ? 'sunny' : 'night';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return isDay ? 'sunny' : 'night';
}
function build(code, isDay, temp, wind) {
  const theme = themeFromCode(code, isDay);
  return { theme, ...THEMES[theme], code, isDay, temp: Math.round(temp), wind: Math.round(wind) };
}
function fromRaw(raw) {
  if (!raw) return null;
  const code = Number(raw.code), temp = Number(raw.temp), wind = Number(raw.wind);
  if (!Number.isInteger(code) || code < 0 || code > 99) return null;
  if (!Number.isFinite(temp) || temp < -90 || temp > 70) return null;
  return build(code, !!raw.isDay, temp, Number.isFinite(wind) ? wind : 0);
}
async function fetchServer(lat, lon) {
  const key = lat.toFixed(2) + ',' + lon.toFixed(2);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3) +
    '&current=temperature_2m,weather_code,is_day,wind_speed_10m&timezone=auto';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'cobrunner-game' } });
    if (!res.ok) throw new Error('Hava servisi ' + res.status + ' döndü');
    const c = (await res.json()).current;
    const data = build(c.weather_code, c.is_day === 1, c.temperature_2m, c.wind_speed_10m);
    cache.set(key, { at: Date.now(), data });
    return data;
  } finally { clearTimeout(timer); }
}
function withDemo(real, demoTheme) {
  if (!demoTheme || !THEMES[demoTheme]) return real;
  return { ...(real || {}), theme: demoTheme, ...THEMES[demoTheme], demo: true };
}
module.exports = { fromRaw, fetchServer, withDemo, THEMES };
