const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');
const path     = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BAND_KEY  = 'band_a_1780742646_tSsWs9F10mNPRp-4SuHJkrsyB1jK0Y4R4';
const BAND_URL  = 'https://band.ai/api/v1/agents/run';
const FIELD_LAT = 35.6841;
const FIELD_LON = 0.6324;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let latest       = null;
let weatherCache = null;
let weatherTime  = 0;

// ── Open-Meteo — مجاني بدون مفتاح ────────────────
function getCondition(code) {
  if (code === 0)  return 'Clear sky';
  if (code <= 3)   return 'Partly cloudy';
  if (code <= 49)  return 'Foggy';
  if (code <= 67)  return 'Rainy';
  if (code <= 77)  return 'Snowy';
  if (code <= 82)  return 'Showers';
  return 'Thunderstorm';
}

async function getRealWeather(lat, lon) {
  if (weatherCache && Date.now() - weatherTime < 600000) {
    return weatherCache;
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`;
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
      console.log(`[Weather] ${weatherCache.temperature}°C ${weatherCache.humidity}% ${weatherCache.condition}`);
      return weatherCache;
    }
  } catch (e) {
    console.error('[Weather error]', e.message);
  }
  return {
    temperature : 28.0,
    humidity    : 55,
    wind_kph    : 10,
    condition   : 'Clear sky',
    altitude    : 0,
    gps         : { lat, lon },
    zone        : 'ZONE-N',
    source      : 'fallback'
  };
}

// ── GET /health ───────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'WheatField online', hasData: !!latest });
});

// ── GET /weather ──────────────────────────────────
app.get('/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat) || FIELD_LAT;
  const lon = parseFloat(req.query.lon) || FIELD_LON;
  const weather = await getRealWeather(lat, lon);
  res.json(weather);
});

// ── GET /drone/latest ─────────────────────────────
app.get('/drone/latest', (req, res) => {
  if (!latest) {
    return res.status(404).json({ error: 'No drone data yet' });
  }
  res.json(latest);
});

// ── POST /proxy ───────────────────────────────────
app.post('/proxy', upload.any(), async (req, res) => {
  try {
    const ctx = JSON.parse(req.body.context || '{}');

    const lat = ctx.spots?.[0]?.lat || FIELD_LAT;
    const lon = ctx.spots?.[0]?.lon || FIELD_LON;
    const realWeather = await getRealWeather(lat, lon);

    const images = (req.files || []).map((f, i) => ({
      spot  : ctx.spots?.[i]?.spot || `Zone ${String.fromCharCode(65 + i)}`,
      base64: `data:${f.mimetype};base64,${f.buffer.toString('base64')}`,
    }));

    const mergedTelemetry = {
      ...realWeather,
      altitude  : ctx.telemetry?.altitude || 0,
      timestamp : Date.now()
    };

    latest = {
      source     : ctx.source      || 'WheatField',
      image_count: images.length,
      spots      : ctx.spots       || [],
      telemetry  : mergedTelemetry,
      images     : images,
      system_goal: ctx.system_goal || '',
      timestamp  : Date.now()
    };

    console.log(`[/proxy] ${images.length} images | ${realWeather.temperature}°C ${realWeather.humidity}% ${realWeather.condition}`);

    // رد فوري
    res.json({
      status       : 'received',
      image_count  : images.length,
      telemetry    : mergedTelemetry,
      agent4_output: `Router: ${images.length} zones received`,
      agent5_output: `Analyzer: Temp ${realWeather.temperature}°C Humidity ${realWeather.humidity}% ${realWeather.condition}`,
      agent6_output: `Reporter: Field analysis complete — ${realWeather.zone}`,
      timestamp    : Date.now()
    });

    // إرسال لـ Band في الخلفية
    const form = new FormData();
    (req.files || []).forEach(f => {
      form.append(f.fieldname, f.buffer, {
        filename   : f.originalname || `${f.fieldname}.jpg`,
        contentType: f.mimetype     || 'image/jpeg'
      });
    });
    form.append('context', JSON.stringify({ ...ctx, telemetry: mergedTelemetry }));

    fetch(BAND_URL, {
      method : 'POST',
      headers: { 'Authorization': `Bearer ${BAND_KEY}`, ...form.getHeaders() },
      body   : form
    }).catch(e => console.error('[Band error]', e.message));

  } catch (err) {
    console.error('[/proxy error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`WheatField running on port ${PORT}`);
  console.log(`  GET  /health       → status`);
  console.log(`  GET  /weather      → Open-Meteo real weather`);
  console.log(`  GET  /drone/latest → latest drone data`);
  console.log(`  POST /proxy        → receive from platform`);
});

module.exports = app;

