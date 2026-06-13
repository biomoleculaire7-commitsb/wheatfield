
const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const cors     = require('cors');
const path     = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BAND_ENDPOINT = 'https://band.ai/api/v1/agents/run';
const BAND_KEY      = 'band_a_1780742646_tSsWs9F10mNPRp-4SuHJkrsyB1jK0Y4R4';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── تخزين مؤقت لآخر بيانات مرسلة من WheatField ──
let latestDroneData = null;

// ── Health check ──────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'WheatField backend online' });
});

// ── GET /drone/latest → يرجع للتطبيق آخر بيانات ──
app.get('/drone/latest', (req, res) => {
  if (!latestDroneData) {
    return res.status(404).json({
      error: 'No drone data yet. WheatField platform has not sent any data.'
    });
  }
  res.json(latestDroneData);
});

// ── POST /proxy → يستقبل من WheatField ويرسل لـ Band ──
app.post('/proxy', upload.fields([
  { name: 'image_0' }, { name: 'image_1' }, { name: 'image_2' },
  { name: 'image_3' }, { name: 'image_4' }, { name: 'image_5' },
  { name: 'image'   }  // صورة واحدة
]), async (req, res) => {
  try {
    const contextStr = req.body.context || '{}';
    const context    = JSON.parse(contextStr);

    // جمع الصور المرسلة
    const images = [];
    const files  = req.files || {};

    // عدة صور (image_0, image_1, ...)
    for (let i = 0; i <= 5; i++) {
      const key  = `image_${i}`;
      const file = files[key]?.[0];
      if (file) {
        images.push({
          spot   : context.spots?.[i]?.spot || `Zone ${String.fromCharCode(65 + i)}`,
          base64 : `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
          size   : file.size
        });
      }
    }

    // صورة واحدة (image)
    const singleImg = files['image']?.[0];
    if (singleImg && images.length === 0) {
      images.push({
        spot   : 'Zone A',
        base64 : `data:${singleImg.mimetype};base64,${singleImg.buffer.toString('base64')}`,
        size   : singleImg.size
      });
    }

    // حفظ البيانات لـ GET /drone/latest
    latestDroneData = {
      source      : context.source      || 'WheatField',
      image_count : images.length,
      spots       : context.spots       || [],
      telemetry   : context.telemetry   || {},
      images      : images,
      system_goal : context.system_goal || '',
      timestamp   : Date.now()
    };

    console.log(`[POST /proxy] Received ${images.length} images from WheatField`);
    console.log(`[POST /proxy] Telemetry:`, context.telemetry);

    // إعادة الإرسال إلى Band
    const form = new FormData();

    if (singleImg && images.length === 1) {
      form.append('image', singleImg.buffer, {
        filename    : 'wheat_field.jpg',
        contentType : singleImg.mimetype || 'image/jpeg',
      });
    } else {
      Object.keys(files).forEach(key => {
        const file = files[key]?.[0];
        if (file) {
          form.append(key, file.buffer, {
            filename    : file.originalname || `${key}.jpg`,
            contentType : file.mimetype     || 'image/jpeg',
          });
        }
      });
    }

    form.append('context', contextStr);

    const bandResp = await fetch(BAND_ENDPOINT, {
      method  : 'POST',
      headers : { 'Authorization': `Bearer ${BAND_KEY}`, ...form.getHeaders() },
      body    : form,
    });

    const rawText = await bandResp.text();
    console.log(`[Band API] Status: ${bandResp.status}`);

    let parsed;
    try   { parsed = JSON.parse(rawText); }
    catch { parsed = { raw: rawText };    }

    res.status(bandResp.status).json(parsed);

  } catch (err) {
    console.error('[Proxy Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`WheatField backend running on port ${PORT}`);
  console.log(`GET  /drone/latest → returns latest drone data`);
  console.log(`POST /proxy        → receives from WheatField, forwards to Band`);
});

module.exports = app;
