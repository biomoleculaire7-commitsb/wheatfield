const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');
const path     = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BAND_KEY = 'band_a_1780742646_tSsWs9F10mNPRp-4SuHJkrsyB1jK0Y4R4';
const BAND_URL = 'https://band.ai/api/v1/agents/run';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// آخر بيانات مستلمة من WheatField
let latestDroneData = null;

// ── GET /health ───────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'WheatField online', hasData: !!latestDroneData });
});

// ── GET /drone/latest → التطبيق يقرأ من هنا ──────
app.get('/drone/latest', (req, res) => {
  if (!latestDroneData) {
    return res.status(404).json({
      error: 'No drone data yet. Send from WheatField platform first.'
    });
  }
  res.json(latestDroneData);
});

// ── POST /proxy → يستقبل من المنصة ويرسل لـ Band ─
app.post('/proxy', upload.any(), async (req, res) => {
  try {
    const ctx = JSON.parse(req.body.context || '{}');

    // حفظ الصور كـ base64
    const images = (req.files || []).map((f, i) => ({
      spot  : ctx.spots?.[i]?.spot || `Zone ${String.fromCharCode(65 + i)}`,
      base64: `data:${f.mimetype};base64,${f.buffer.toString('base64')}`,
    }));

    // حفظ لـ GET /drone/latest
    latestDroneData = {
      source     : ctx.source     || 'WheatField',
      image_count: images.length,
      spots      : ctx.spots      || [],
      telemetry  : ctx.telemetry  || {},
      images     : images,
      system_goal: ctx.system_goal|| '',
      timestamp  : Date.now()
    };

    console.log(`[/proxy] Saved ${images.length} images for /drone/latest`);

    // إرسال إلى Band
    const form = new FormData();
    (req.files || []).forEach(f => {
      form.append(f.fieldname, f.buffer, {
        filename   : f.originalname || `${f.fieldname}.jpg`,
        contentType: f.mimetype     || 'image/jpeg'
      });
    });
    form.append('context', req.body.context);

    const bandResp = await fetch(BAND_URL, {
      method : 'POST',
      headers: { 'Authorization': `Bearer ${BAND_KEY}`, ...form.getHeaders() },
      body   : form
    });

    const raw = await bandResp.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }

    res.status(bandResp.status).json(parsed);

  } catch (err) {
    console.error('[/proxy error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`WheatField running on port ${PORT}`);
  console.log(`  GET  /health       → status`);
  console.log(`  GET  /drone/latest → latest drone data`);
  console.log(`  POST /proxy        → receive from platform`);
});

module.exports = app;
