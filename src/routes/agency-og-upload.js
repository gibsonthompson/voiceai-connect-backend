// ============================================================================
// AGENCY OG IMAGE UPLOAD. Agencies upload a real photo for their shared-link
// (OG) card instead of pasting a hosted URL. The file arrives as a base64 data
// URL (the browser reads it client-side), we decode it and store it in the
// public content-media bucket, and return the public URL. That URL is saved to
// agencies.og_image_url via the normal settings PUT, and /api/agency-og
// re-serves it. Storing a URL (not the base64 blob) keeps the agency row lean
// and keeps og:image fetchable by external crawlers (iMessage, Slack, etc.).
//
//   POST /api/agency/:agencyId/og-image   { dataUrl }  ->  { url }
//
// Mounted in server.js:  app.use('/api/agency', require('./routes/agency-og-upload'));
// Destination: src/routes/agency-og-upload.js (NEW FILE)
// ============================================================================
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

const BUCKET = 'content-media';
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const router = express.Router();

router.post('/:agencyId/og-image', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'Expected a base64 image.' });

    const contentType = m[1].toLowerCase();
    const ext = MIME_EXT[contentType];
    if (!ext) return res.status(400).json({ error: 'Unsupported image type. Use PNG, JPG, WEBP, or GIF.' });

    const buffer = Buffer.from(m[2], 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Image is empty.' });
    if (buffer.length > MAX_BYTES) return res.status(400).json({ error: 'Image is too large (max 5MB).' });

    const key = `agency-og/${req.params.agencyId}-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(key, buffer, { contentType, upsert: true });
    if (upErr) throw upErr;

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(key);
    if (!pub || !pub.publicUrl) throw new Error('No public URL returned');

    res.json({ url: pub.publicUrl });
  } catch (e) {
    console.error('OG image upload error:', e.message);
    res.status(500).json({ error: 'Failed to upload image. Please try again.' });
  }
});

module.exports = router;
