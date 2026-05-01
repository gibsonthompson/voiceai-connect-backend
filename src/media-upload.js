/**
 * Media Upload Service — Dual Storage
 * 
 * Saves to DO filesystem for fast serving + Supabase Storage as persistent backup.
 * If DO files get wiped by a deploy, process cron restores from Supabase before publishing.
 * 
 * Path: src/media-upload.js
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { supabase } = require('./lib/supabase');

const router = express.Router();
const MEDIA_DIR = process.env.MEDIA_DIR || '/workspace/media';
const SUPABASE_BUCKET = 'content-media';

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'video/mp4', 'video/quicktime'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

// ── Upload single file (DO + Supabase backup) ──────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { slug } = req.body;
    if (!slug || !req.file) {
      return res.status(400).json({ error: 'slug and file are required' });
    }

    const cleanSlug = slug.replace(/[^a-z0-9-]/gi, '').toLowerCase();
    const dir = path.join(MEDIA_DIR, cleanSlug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const ext = path.extname(req.file.originalname).toLowerCase() ||
                (req.file.mimetype.includes('video') ? '.mp4' : '.png');
    const hash = crypto.randomBytes(6).toString('hex');
    const filename = `${Date.now()}-${hash}${ext}`;
    const filepath = path.join(dir, filename);
    const storagePath = `${cleanSlug}/${filename}`;

    // 1. Save to DO filesystem (fast, for serving)
    fs.writeFileSync(filepath, req.file.buffer);

    const baseUrl = process.env.PUBLIC_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
    const url = `${baseUrl}/media/${storagePath}`;

    // 2. Backup to Supabase Storage (persistent, survives deploys)
    let backupUrl = null;
    try {
      const { error: uploadErr } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(storagePath, req.file.buffer, {
          contentType: req.file.mimetype,
          cacheControl: '31536000',
          upsert: true,
        });

      if (!uploadErr) {
        const { data: urlData } = supabase.storage
          .from(SUPABASE_BUCKET)
          .getPublicUrl(storagePath);
        backupUrl = urlData?.publicUrl || null;
        console.log(`[MEDIA] Backed up to Supabase: ${backupUrl}`);
      } else {
        console.error(`[MEDIA] Supabase backup failed (non-fatal): ${uploadErr.message}`);
      }
    } catch (backupErr) {
      console.error(`[MEDIA] Supabase backup error (non-fatal): ${backupErr.message}`);
    }

    console.log(`[MEDIA] Saved: ${url} (${(req.file.size / 1024).toFixed(0)}KB)`);

    res.json({
      url,
      backupUrl,
      filename,
      originalName: req.file.originalname,
      mediaType: req.file.mimetype,
      size: req.file.size,
      storagePath,
    });
  } catch (err) {
    console.error('[MEDIA] Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Restore file from Supabase backup ───────────────────────────
router.post('/restore', async (req, res) => {
  try {
    const { storage_path, backup_url } = req.body;
    if (!storage_path || !backup_url) {
      return res.status(400).json({ error: 'storage_path and backup_url required' });
    }

    const filepath = path.join(MEDIA_DIR, storage_path);
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Download from Supabase
    const resp = await fetch(backup_url);
    if (!resp.ok) throw new Error(`Failed to fetch backup: ${resp.status}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(filepath, buffer);

    const baseUrl = process.env.PUBLIC_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
    const url = `${baseUrl}/media/${storage_path}`;

    console.log(`[MEDIA] Restored from backup: ${url} (${(buffer.length / 1024).toFixed(0)}KB)`);
    res.json({ restored: true, url });
  } catch (err) {
    console.error('[MEDIA] Restore error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Extract video thumbnail ─────────────────────────────────────
router.post('/thumbnail', async (req, res) => {
  try {
    const { video_path, timestamp } = req.body;
    if (!video_path) return res.status(400).json({ error: 'video_path required' });

    const { spawn } = require('child_process');
    const videoFile = path.join(MEDIA_DIR, video_path);

    if (!fs.existsSync(videoFile)) {
      return res.status(404).json({ error: `Video not found: ${video_path}` });
    }

    const thumbDir = '/workspace/thumbnails';
    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

    const thumbFilename = `thumb-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
    const thumbPath = path.join(thumbDir, thumbFilename);
    const seekTime = timestamp || '1';

    const tryExtract = (time) => new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-ss', time, '-i', videoFile, '-vframes', '1', '-q:v', '2', '-y', thumbPath,
      ]);
      let stderr = '';
      ffmpeg.stderr.on('data', d => stderr += d.toString());
      ffmpeg.on('close', code => {
        if (code === 0 && fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}`));
      });
      ffmpeg.on('error', reject);
    });

    try { await tryExtract(seekTime); } catch { await tryExtract('0'); }

    const thumbBuffer = fs.readFileSync(thumbPath);
    const base64 = thumbBuffer.toString('base64');
    const baseUrl = process.env.PUBLIC_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
    const thumbUrl = `${baseUrl}/thumbnails/${thumbFilename}`;

    setTimeout(() => { try { fs.unlinkSync(thumbPath); } catch {} }, 3600000);

    console.log(`[MEDIA] Thumbnail extracted: ${thumbUrl}`);
    res.json({ base64: `data:image/jpeg;base64,${base64}`, url: thumbUrl, filename: thumbFilename });
  } catch (err) {
    console.error('[MEDIA] Thumbnail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'media-upload', mediaDir: MEDIA_DIR });
});

module.exports = router;