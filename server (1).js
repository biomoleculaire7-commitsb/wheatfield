/**
 * WheatField → Band API Proxy
 * يحل مشكلة CORS ويعيد إرسال الطلب لـ Band
 * 
 * تشغيل:
 *   npm install
 *   node server.js
 * 
 * ثم في المنصة غيّر BAND_ENDPOINT إلى:
 *   http://localhost:3001/proxy
 */

const express   = require('express');
const multer    = require('multer');
const fetch     = require('node-fetch');
const FormData  = require('form-data');
const cors      = require('cors');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BAND_ENDPOINT = 'https://band.ai/api/v1/agents/run';
const BAND_KEY      = 'band_a_1780742646_tSsWs9F10mNPRp-4SuHJkrsyB1jK0Y4R4';

// Allow all origins (dev only)
app.use(cors());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'WheatField Band Proxy running ✓' });
});

// Main proxy endpoint
app.post('/proxy', upload.single('image'), async (req, res) => {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[Proxy] Received request from WheatField platform');
    console.log('[Proxy] Image size:', req.file?.size, 'bytes');
    console.log('[Proxy] Context:', req.body?.context?.slice(0, 200));

    // Build multipart for Band
    const form = new FormData();
    form.append('image', req.file.buffer, {
      filename    : 'wheat_field.jpg',
      contentType : req.file.mimetype || 'image/jpeg',
    });
    form.append('context', req.body.context);

    console.log('[Proxy] Forwarding to Band API…');

    const bandResp = await fetch(BAND_ENDPOINT, {
      method  : 'POST',
      headers : {
        'Authorization' : `Bearer ${BAND_KEY}`,
        ...form.getHeaders(),
      },
      body : form,
    });

    const rawText = await bandResp.text();
    console.log('[Band API] Status:', bandResp.status);
    console.log('[Band API] Response:', rawText.slice(0, 300));

    let parsed;
    try   { parsed = JSON.parse(rawText); }
    catch { parsed = { raw: rawText };    }

    res.status(bandResp.status).json(parsed);

  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n✅ WheatField Band Proxy started`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Proxy:  http://localhost:${PORT}/proxy`);
  console.log(`   Target: ${BAND_ENDPOINT}\n`);
});
