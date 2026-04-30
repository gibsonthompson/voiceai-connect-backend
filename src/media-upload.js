/**
 * Media Upload Service
 * Accepts file uploads, saves to /workspace/media/{slug}/, returns public URL.
 * 
 * Mount in server.js:
 *   const mediaUpload = require('./media-upload');
 *   app.use('/api/media', mediaUpload);
 * 
 * Also add static serving:
 *   app.use('/media', express.static(MEDIA_DIR, { maxAge: '30d' }));
 * 
 * Path: src/media-upload.js
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const router = express.Router();
const MEDIA_DIR = process.env.MEDIA_DIR || '/workspace/media';

// Ensure base directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Multer config — store in memory, then write with unique filename
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max (for video)
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'video/mp4', 'video/quicktime'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// ── Upload single file ──────────────────────────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { slug } = req.body;
    if (!slug || !req.file) {
      return res.status(400).json({ error: 'slug and file are required' });
    }

    const cleanSlug = slug.replace(/[^a-z0-9-]/gi, '').toLowerCase();
    const dir = path.join(MEDIA_DIR, cleanSlug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Generate unique filename
    const ext = path.extname(req.file.originalname).toLowerCase() || 
                (req.file.mimetype.includes('video') ? '.mp4' : '.png');
    const hash = crypto.randomBytes(6).toString('hex');
    const filename = `${Date.now()}-${hash}${ext}`;
    const filepath = path.join(dir, filename);

    // Write file
    fs.writeFileSync(filepath, req.file.buffer);

    const baseUrl = process.env.PUBLIC_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
    const url = `${baseUrl}/media/${cleanSlug}/${filename}`;

    console.log(`[MEDIA] Saved: ${url} (${(req.file.size / 1024).toFixed(0)}KB)`);

    res.json({
      url,
      filename,
      originalName: req.file.originalname,
      mediaType: req.file.mimetype,
      size: req.file.size,
      storagePath: `${cleanSlug}/${filename}`,
    });
  } catch (err) {
    console.error('[MEDIA] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Upload multiple files ───────────────────────────────────────
router.post('/upload-batch', upload.array('files', 100), async (req, res) => {
  try {
    const { slug } = req.body;
    if (!slug || !req.files?.length) {
      return res.status(400).json({ error: 'slug and files are required' });
    }

    const cleanSlug = slug.replace(/[^a-z0-9-]/gi, '').toLowerCase();
    const dir = path.join(MEDIA_DIR, cleanSlug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const baseUrl = process.env.PUBLIC_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
    const results = [];

    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase() ||
                  (file.mimetype.includes('video') ? '.mp4' : '.png');
      const hash = crypto.randomBytes(6).toString('hex');
      const filename = `${Date.now()}-${hash}${ext}`;
      const filepath = path.join(dir, filename);

      fs.writeFileSync(filepath, file.buffer);

      results.push({
        url: `${baseUrl}/media/${cleanSlug}/${filename}`,
        filename,
        originalName: file.originalname,
        mediaType: file.mimetype,
        size: file.size,
        storagePath: `${cleanSlug}/${filename}`,
      });
    }

    console.log(`[MEDIA] Batch uploaded: ${results.length} files for ${cleanSlug}`);
    res.json({ files: results, count: results.length });
  } catch (err) {
    console.error('[MEDIA] Batch upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'media-upload', mediaDir: MEDIA_DIR });
});

module.exports = router;