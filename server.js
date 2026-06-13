const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');
const path     = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BAND_KEY    = 'band_a_1780742646_tSsWs9F10mNPRp-4SuHJkrsyB1jK0Y4R4';
const BAND_URL    = 'https://band.ai/api/v1/agents/run';
const WEATHER_KEY = 'fdae759e-cfff-49d9-9846-8d2fd759780b'; // WeatherAPI key

// إحداثيات الحقل — رليزان الجزائر
const FIELD_LAT = 35.6841;
const FIELD_LON = 0.6324;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let latest     = null;
let weatherCache = null;
let weatherTime  = 0;

// ── جلب بيانات الطقس الحقيقية ─────────────────────
async function getRealWeather(lat, lon) {
  // كاش لمدة 10 دقائق
  if (weatherCache && Date.now() - weatherTime < 600000) {
    return weatherCache;
  }
  try {
    // جرب WeatherAPI أولاً
    const url = `https://api.weatherapi.com/v1/current.json?key=${WEATHER_KEY}&q=${lat},${lon}&aqi=no`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      weatherCache = {
        temperature : data.current.temp_c,
        humidity    : data.current.humidity,
        wind_kph    : data.current.wind_kph,
        condition   : data.current.condition?.text || '',
        altitude    : 0,
        gps         : { lat, lon },
        zone        : data.current.humidity > 60 ? 'ZONE-D' : 'ZONE-N',
        source      : 'WeatherAPI'
      };
      weatherTime = Date.now();
      console.log(`[Weather] ${weatherCache.temperature}°C ${weatherCache.humidity}%`);
      return weatherCache;
    }
  } catch (e) {
    console.error('[Weather error]', e.message);
  }

  // Fallback — OpenWeatherMap
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_KEY}&units=metric`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      weatherCache = {
        temperature : data.main.temp,
        humidity    : data.main.humidity,
        wind_kph    : (data.wind?.speed || 0) * 3.6,
        condition   : data.weather?.[0]?.description || '',
        altitude    : 0,
        gps         : { lat, lon },
        zone        : data.main.humidity > 60 ? 'ZONE-D' : 'ZONE-N',
        source      : 'OpenWeatherMap'
      };
      weatherTime = Date.now();
      return weatherCache;
    }
  } catch (e) {
    console.error('[OWM error]', e.message);
  }

  // إذا فشل كل شيء — قيم افتراضية
  return {
    temperature : 28.0,
    humidity    : 55,
    wind_kph    : 10,
    condition   : 'Unknown',
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

// ── GET /weather → بيانات الطقس مباشرة ───────────
app.get('/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat) || FIELD_LAT;
  const lon = parseFloat(req.query.lon) || FIELD_LON;
  const weather = await getRealWeather(lat, lon);
  res.json(weather);
});

// ── GET /drone/latest → التطبيق يقرأ من هنا ──────
app.get('/drone/latest', (req, res) => {
  if (!latest) {
    return res.status(404).json({ error: 'No drone data yet' });
  }
  res.json(latest);
});

// ── POST /proxy → يستقبل من المنصة ────────────────
app.post('/proxy', upload.any(), async (req, res) => {
  try {
    const ctx = JSON.parse(req.body.context || '{}');

    // جلب الطقس الحقيقي
    const lat = ctx.telemetry?.gps?.lat || ctx.spots?.[0]?.lat || FIELD_LAT;
    const lon = ctx.telemetry?.gps?.lon || ctx.spots?.[0]?.lon || FIELD_LON;
    const realWeather = await getRealWeather(lat, lon);

    // حفظ الصور
    const images = (req.files || []).map((f, i) => ({
      spot  : ctx.spots?.[i]?.spot || `Zone ${String.fromCharCode(65 + i)}`,
      base64: `data:${f.mimetype};base64,${f.buffer.toString('base64')}`,
    }));

    // دمج الطقس الحقيقي مع بيانات المنصة
    const mergedTelemetry = {
      ...realWeather,
      altitude : ctx.telemetry?.altitude || 0,
      zone     : realWeather.zone,
      timestamp: Date.now()
    };

    // حفظ لـ /drone/latest
    latest = {
      source     : ctx.source      || 'WheatField',
      image_count: images.length,
      spots      : ctx.spots       || [],
      telemetry  : mergedTelemetry,
      images     : images,
      system_goal: ctx.system_goal || '',
      timestamp  : Date.now()
    };

    console.log(`[/proxy] ${images.length} images | Temp:${realWeather.temperature}°C Hum:${realWeather.humidity}%`);

    // رد فوري
    res.json({
      status       : 'received',
      image_count  : images.length,
      telemetry    : mergedTelemetry,
      agent4_output: 'Router: data received with real weather',
      agent5_output: `Analyzer: Temp ${realWeather.temperature}°C Humidity ${realWeather.humidity}%`,
      agent6_output: 'Reporter: check /drone/latest for full data',
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
    const updatedCtx = { ...ctx, telemetry: mergedTelemetry };
    form.append('context', JSON.stringify(updatedCtx));

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
  console.log(`  GET  /weather      → real weather data`);
  console.log(`  GET  /drone/latest → latest drone data`);
  console.log(`  POST /proxy        → receive from platform`);
});

module.exports = app;
