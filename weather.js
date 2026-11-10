// Gerçek hava durumu: Open-Meteo (ücretsiz, API anahtarı gerekmez) - https://open-meteo.com
const cache = new Map(); // "lat,lon" -> { at, data }
const TTL_MS = 10 * 60 * 1000;

// Tema bilgileri (istemci haritayı buna göre çizer)
const THEMES = {
  sunny:  { label: 'Güneşli',               icon: '☀️' },
  night:  { label: 'Açık gece',             icon: '🌙' },
  cloudy: { label: 'Bulutlu',               icon: '☁️' },
  fog:    { label: 'Sisli',                 icon: '🌫️' },
  rain:   { label: 'Yağmurlu',              icon: '🌧️' },
  snow:   { label: 'Karlı',                 icon: '❄️' },
  storm:  { label: 'Gök gürültülü fırtına', icon: '⛈️' }
};

// WMO hava kodu -> tema
function themeFromCode(code, isDay) {
  if (code === 0 || code === 1) return isDay ? 'sunny' : 'night';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return isDay ? 'sunny' : 'night';
}

async function getWeather(lat, lon) {
  const key = lat.toFixed(2) + ',' + lon.toFixed(2);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&current=temperature_2m,weather_code,is_day,wind_speed_10m,precipitation&timezone=auto';
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error('Hava durumu servisi yanıt vermedi (' + res.status + ')');
  const c = (await res.json()).current;
  const theme = themeFromCode(c.weather_code, c.is_day === 1);
  const data = {
    theme, ...THEMES[theme], code: c.weather_code,
    temp: Math.round(c.temperature_2m), wind: Math.round(c.wind_speed_10m),
    precipitation: c.precipitation, isDay: c.is_day === 1, time: c.time
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Sunum modu: gerçek hava yerine seçilen temayı göster
function withDemo(real, demoTheme) {
  if (!demoTheme || !THEMES[demoTheme]) return real;
  return { ...(real || {}), theme: demoTheme, ...THEMES[demoTheme], demo: true };
}

module.exports = { getWeather, withDemo, THEMES };
