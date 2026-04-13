// ============================================================================
// UPLOAD ROUTES - Logo upload via Supabase Storage
// Bucket: agency-logos (already exists, public)
// Path: clients/{clientId}/logo.{ext} for client logos
// Requires: npm install multer
// Mount in server.js: app.use('/api/upload', require('./routes/upload'));
// ============================================================================
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase } = require('../lib/supabase');

// Multer: memory storage, 5MB limit, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

const BUCKET = 'agency-logos';

// ============================================================================
// POST /api/upload/logo - Upload a logo for a client (or agency)
// Body (multipart): logo (file), clientId (string)
// Returns: { success: true, url: "https://..." }
// ============================================================================
router.post('/logo', upload.single('logo'), async (req, res) => {
  try {
    const file = req.file;
    const clientId = req.body.clientId;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    // Build storage path: clients/{clientId}/logo.{ext}
    const ext = file.originalname.split('.').pop()?.toLowerCase() || 'png';
    const allowedExts = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif'];
    const safeExt = allowedExts.includes(ext) ? ext : 'png';
    const storagePath = `clients/${clientId}/logo.${safeExt}`;

    // Upload to Supabase Storage (upsert to replace existing)
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error('❌ Supabase Storage upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload file' });
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    // Append cache-buster so browser doesn't serve stale logo
    const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

    console.log(`✅ Logo uploaded for client ${clientId}: ${publicUrl}`);

    res.json({ success: true, url: publicUrl });
  } catch (error) {
    console.error('❌ Logo upload error:', error);

    // Multer file size error
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File must be under 5MB' });
    }

    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

module.exports = router;