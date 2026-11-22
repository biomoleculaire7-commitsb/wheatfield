const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BAND_KEY   = process.env.BAND_KEY || 'band_a_1780742646_tSsWs9F10mNPRp-4SuHJkrsyB1jK0Y4R4';
const BAND_URL   = 'https://band.ai/api/v1/agents/run';
const FIELD_LAT  = 35.6841;
const FIELD_LON  = 0.6324;
const DATA_FILE  = path.join('/tmp', 'drone_latest.json');

app.use(cors());
app.use(express.json());
// النموذج ثقيل: يُخزَّن في المتصفح أسبوعاً فلا يُحمَّل في كل زيارة
app.use('/models', express.static(path.join(__dirname, 'public', 'models'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

let weatherCache = null;
let weatherTime  = 0;

// ── حفظ وقراءة البيانات من ملف ───────────────────
function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch(e) {}
}
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) {}
  return null;
}

// ── Open-Meteo بدون مفتاح ─────────────────────────
function getCondition(code) {
  if (code === 0) return 'Clear sky';
  if (code <= 3)  return 'Partly cloudy';
  if (code <= 49) return 'Foggy';
  if (code <= 67) return 'Rainy';
  if (code <= 77) return 'Snowy';
  if (code <= 82) return 'Showers';
  return 'Thunderstorm';
}

async function getRealWeather(lat, lon) {
  if (weatherCache && Date.now() - weatherTime < 600000) return weatherCache;
  try {
    const url  = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      const cur  = data.current;
      weatherCache = {
        temperature : cur.temperature_2m,
        humidity    : cur.relative_humidity_2m,
        wind_kph    : cur.wind_speed_10m,
        condition   : getCondition(cur.weather_code),
        altitude    : 0,
        gps         : { lat, lon },
        zone        : cur.relative_humidity_2m > 60 ? 'ZONE-D' : 'ZONE-N',
        source      : 'Open-Meteo'
      };
      weatherTime = Date.now();
      return weatherCache;
    }
  } catch(e) { console.error('[Weather]', e.message); }
  return { temperature:28.0, humidity:55, wind_kph:10, condition:'Clear sky',
           altitude:0, gps:{lat,lon}, zone:'ZONE-N', source:'fallback' };
}

// ── GET /health ───────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'WheatField online', hasData: !!loadData() });
});

// ── GET /weather ──────────────────────────────────
app.get('/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat) || FIELD_LAT;
  const lon = parseFloat(req.query.lon) || FIELD_LON;
  res.json(await getRealWeather(lat, lon));
});

// ── GET /drone/latest ─────────────────────────────
app.get('/drone/latest', (req, res) => {
  const data = loadData();
  if (!data) return res.status(404).json({ error: 'No drone data yet' });
  res.json(data);
});

// ── POST /proxy ───────────────────────────────────
app.post('/proxy', upload.any(), async (req, res) => {
  try {
    const ctx         = JSON.parse(req.body.context || '{}');
    const lat         = ctx.field?.center?.[0] || ctx.spots?.[0]?.lat || FIELD_LAT;
    const lon         = ctx.field?.center?.[1] || ctx.spots?.[0]?.lon || FIELD_LON;
    const realWeather = await getRealWeather(lat, lon);

    const images = (req.files || []).map((f, i) => ({
      spot  : ctx.spots?.[i]?.spot || `Zone ${String.fromCharCode(65+i)}`,
      base64: `data:${f.mimetype};base64,${f.buffer.toString('base64')}`,
    }));

    const telemetry = { ...realWeather, altitude: ctx.telemetry?.altitude || 0, timestamp: Date.now() };

    const latest = {
      source     : ctx.source      || 'WheatField',
      image_count: images.length,
      field      : ctx.field       || null,
      spots      : ctx.spots       || [],
      telemetry,
      images,
      system_goal: ctx.system_goal || '',
      timestamp  : Date.now()
    };

    // حفظ في ملف — يبقى حتى بعد إعادة التشغيل
    saveData(latest);
    console.log(`[/proxy] ${images.length} images | ${realWeather.temperature}°C ${realWeather.condition}`);

    res.json({
      status       : 'received',
      image_count  : images.length,
      telemetry,
      agent4_output: `Router: ${images.length} zones received`,
      agent5_output: `Analyzer: ${realWeather.temperature}°C ${realWeather.humidity}% ${realWeather.condition}`,
      agent6_output: `Reporter: Field analysis complete — ${realWeather.zone}`,
      timestamp    : Date.now()
    });

    // Band في الخلفية
    const form = new FormData();
    (req.files||[]).forEach(f => form.append(f.fieldname, f.buffer, {
      filename: f.originalname||`${f.fieldname}.jpg`, contentType: f.mimetype||'image/jpeg'
    }));
    form.append('context', JSON.stringify({...ctx, telemetry}));
    fetch(BAND_URL, {
      method:'POST', headers:{'Authorization':`Bearer ${BAND_KEY}`,...form.getHeaders()}, body:form
    }).catch(e => console.error('[Band]', e.message));

  } catch(err) {
    console.error('[/proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── خريطة صحة الحقل (NDVI) من Sentinel-2 عبر Copernicus Data Space ──
// بيانات الدخول من متغيرات البيئة فقط: CDSE_CLIENT_ID و CDSE_CLIENT_SECRET
const crypto       = require('crypto');
const CDSE_ID      = process.env.CDSE_CLIENT_ID;
const CDSE_SECRET  = process.env.CDSE_CLIENT_SECRET;
const CDSE_TOKEN   = process.env.CDSE_TOKEN_URL || 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const SH_BASE      = process.env.SH_BASE_URL   || 'https://sh.dataspace.copernicus.eu';
let cdseTok = null, cdseExp = 0;
async function cdseToken() {
  if (cdseTok && Date.now() < cdseExp - 60000) return cdseTok;
  const r = await fetch(CDSE_TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CDSE_ID, client_secret: CDSE_SECRET })
  });
  if (!r.ok) { const e = new Error('auth'); e.status = r.status; throw e; }
  const j = await r.json(); cdseTok = j.access_token; cdseExp = Date.now() + (j.expires_in || 300) * 1000; return cdseTok;
}
// NDVI مقيَّد 0..255 (من -0.2 إلى 1.0) في قناة، وقناة ثانية شفافة للغيوم وخارج الحقل
const NDVI_EVALSCRIPT = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","SCL","dataMask"]}],output:{bands:2,sampleType:"UINT8"}};}
function evaluatePixel(s){
  var c=s.SCL;
  if(s.dataMask===0||c===1||c===3||c===8||c===9||c===10||c===11) return [0,0];
  var n=(s.B08-s.B04)/(s.B08+s.B04+0.000001);
  var v=Math.max(0,Math.min(1,(n+0.2)/1.2));
  return [Math.round(v*255),255];
}`;
const ndviCache = new Map(), ndviHits = new Map(); let ndviDay = '', ndviCount = 0;
function ndviLimit(ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== ndviDay) { ndviDay = day; ndviCount = 0; }
  if (ndviCount >= 300) return false;
  const now = Date.now(), arr = (ndviHits.get(ip) || []).filter(t => now - t < 3600000);
  if (arr.length >= 12) { ndviHits.set(ip, arr); return false; }
  arr.push(now); ndviHits.set(ip, arr); ndviCount++; return true;
}
async function shPost(token, urlPaths, body, accept) {
  let last;
  for (const p of urlPaths) {
    const r = await fetch(SH_BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: accept }, body: JSON.stringify(body) });
    if (r.status === 404) { last = r; continue; }
    return r;
  }
  return last;
}
app.post('/ndvi', async (req, res) => {
  try {
    if (!CDSE_ID || !CDSE_SECRET) return res.status(503).json({ error: 'not_configured' });
    const poly = req.body && req.body.polygon;
    if (!Array.isArray(poly) || poly.length < 3 || poly.length > 300 ||
        !poly.every(q => Array.isArray(q) && q.length >= 2 && Number.isFinite(+q[0]) && Number.isFinite(+q[1]) && +q[0] > 18 && +q[0] < 38.6 && +q[1] > -9 && +q[1] < 12.6))
      return res.status(400).json({ error: 'bad_polygon' });
    const pts = poly.map(q => [+q[1], +q[0]]);               // [lng, lat]
    const lngs = pts.map(q => q[0]), lats = pts.map(q => q[1]);
    const w = Math.min(...lngs), e = Math.max(...lngs), s = Math.min(...lats), n = Math.max(...lats);
    const lat0 = (s + n) / 2, wm = (e - w) * 111320 * Math.cos(lat0 * Math.PI / 180), hm = (n - s) * 110540;
    if (wm > 12000 || hm > 12000) return res.status(400).json({ error: 'too_big' });
    if (wm < 20 || hm < 20) return res.status(400).json({ error: 'too_small' });
    const days = Math.max(5, Math.min(60, parseInt(req.body.days) || 30));
    const key = crypto.createHash('sha1').update(JSON.stringify(pts.map(q => q.map(v => +v.toFixed(5)))) + '|' + days + '|' + new Date().toISOString().slice(0, 10)).digest('hex');
    const hit = ndviCache.get(key); if (hit && Date.now() - hit.t < 6 * 3600000) return res.json(hit.v);
    if (!ndviLimit(req.ip)) return res.status(429).json({ error: 'rate_limit' });

    const token = await cdseToken();
    const to = new Date(), from = new Date(Date.now() - days * 86400000);
    let from_s = from.toISOString().slice(0, 19) + 'Z', to_s = to.toISOString().slice(0, 19) + 'Z', date = null, cloud = null;

    // اختيار أفضل مشهد (اختياري): الأحدث بين المشاهد الأقل غيوماً، وإلا الأقل غيوماً
    try {
      const cr = await shPost(token, ['/api/v1/catalog/1.0.0/search'], { collections: ['sentinel-2-l2a'], datetime: from_s + '/' + to_s, bbox: [w, s, e, n], limit: 50 }, 'application/json');
      if (cr && cr.ok) {
        const feats = ((await cr.json()).features || []).map(f => ({ d: f.properties && f.properties.datetime, c: f.properties && f.properties['eo:cloud_cover'] })).filter(f => f.d && Number.isFinite(f.c));
        const clear = feats.filter(f => f.c <= 30).sort((a, b) => b.d.localeCompare(a.d));
        const pick = clear[0] || feats.sort((a, b) => a.c - b.c)[0];
        if (pick) { date = pick.d.slice(0, 10); cloud = Math.round(pick.c); from_s = date + 'T00:00:00Z'; to_s = date + 'T23:59:59Z'; }
      }
    } catch (e) { /* نتابع بدون الكتالوج */ }

    const W = Math.max(16, Math.min(1024, Math.round(wm / 10))), H = Math.max(16, Math.min(1024, Math.round(hm / 10)));
    const ring = pts.slice(); if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
    const body = {
      input: {
        bounds: { properties: { crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' }, bbox: [w, s, e, n], geometry: { type: 'Polygon', coordinates: [ring] } },
        data: [{ type: 'sentinel-2-l2a', dataFilter: { timeRange: { from: from_s, to: to_s }, maxCloudCoverage: 80, mosaickingOrder: 'leastCC' } }]
      },
      output: { width: W, height: H, responses: [{ identifier: 'default', format: { type: 'image/png' } }] },
      evalscript: NDVI_EVALSCRIPT
    };
    const pr = await shPost(token, ['/api/v1/process', '/process/v1'], body, 'image/png');
    if (!pr || !pr.ok) {
      const st = pr ? pr.status : 502; let msg = ''; try { msg = (await pr.text()).slice(0, 200); } catch (e) {}
      console.error('[ndvi] process', st, msg);
      return res.status(st === 401 || st === 403 ? 502 : (st === 429 ? 429 : 502)).json({ error: st === 429 ? 'quota' : 'upstream_' + st });
    }
    const buf = await pr.buffer();
    const out = { png: 'data:image/png;base64,' + buf.toString('base64'), bbox: [w, s, e, n], size: [W, H], date, cloud, source: 'Sentinel-2 L2A' };
    ndviCache.set(key, { t: Date.now(), v: out });
    if (ndviCache.size > 50) ndviCache.delete(ndviCache.keys().next().value);
    console.log(`[ndvi] ${W}x${H} date=${date} cloud=${cloud}`);
    res.json(out);
  } catch (e) {
    console.error('[ndvi]', e.message);
    res.status(e.message === 'auth' ? 502 : 500).json({ error: e.message === 'auth' ? 'auth_failed' : 'server_error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`WheatField on port ${PORT}`));
module.exports = app;
