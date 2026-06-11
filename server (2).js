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
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'WheatField online', proxy: BAND_ENDPOINT });
});

app.post('/proxy', upload.single('image'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('image', req.file.buffer, {
      filename    : 'wheat_field.jpg',
      contentType : req.file.mimetype || 'image/jpeg',
    });
    form.append('context', req.body.context);

    const bandResp = await fetch(BAND_ENDPOINT, {
      method  : 'POST',
      headers : { 'Authorization': `Bearer ${BAND_KEY}`, ...form.getHeaders() },
      body    : form,
    });

    const rawText = await bandResp.text();
    let parsed;
    try   { parsed = JSON.parse(rawText); }
    catch { parsed = { raw: rawText };    }

    res.status(bandResp.status).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`WheatField running on port ${PORT}`));

module.exports = app;
