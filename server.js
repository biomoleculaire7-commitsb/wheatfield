
const express = require('express');
const multer  = require('multer');
const fetch   = require('node-fetch');
const FormData= require('form-data');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });
const BAND_KEY = 'band_a_1780742646_tSsWs9F10mNPRp-4SuHJkrsyB1jK0Y4R4';
const BAND_URL = 'https://band.ai/api/v1/agents/run';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let latestDroneData = null;

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/drone/latest', (req, res) => {
  if (!latestDroneData) {
    return res.status(404).json({ error: 'No drone data yet' });
  }
  res.json(latestDroneData);
});

app.post('/proxy', upload.any(), async (req, res) => {
  try {
    const ctx = JSON.parse(req.body.context || '{}');
    const images = (req.files || []).map((f, i) => ({
      spot  : ctx.spots?.[i]?.spot || `Zone ${String.fromCharCode(65+i)}`,
      base64: `data:${f.mimetype};base64,${f.buffer.toString('base64')}`,
    }));

    latestDroneData = {
      source     : ctx.source    || 'WheatField',
      image_count: images.length,
      spots      : ctx.spots     || [],
      telemetry  : ctx.telemetry || {},
      images     : images,
      timestamp  : Date.now()
    };

    const form = new FormData();
    (req.files || []).forEach(f => {
      form.append(f.fieldname, f.buffer, { filename: f.originalname, contentType: f.mimetype });
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

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
module.exports = app;
