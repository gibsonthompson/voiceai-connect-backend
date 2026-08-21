/**
 * Media Upload Service - v3, DigitalOcean Spaces
 *
 * WHY THIS CHANGED
 * The previous version wrote each file to the container's local disk (fast to
 * serve) and to Supabase Storage (a backup). The container disk is ephemeral:
 * every deploy wiped /workspace/media, so the process cron had to re-download
 * each pending video from Supabase before publishing. Heavy deploy activity
 * turned that restore path into 11 GB of Supabase egress and blew the cap.
 *
 * Now Spaces is the single source of truth. Files live in the Space, which
 * survives deploys, so nothing ever needs restoring and Supabase is out of the
 * media path entirely. The media_url handed to Meta points straight at the
 * Space's public URL.
 *
 * BACKWARD COMPATIBILITY
 * - The response shape is unchanged (url, backupUrl, filename, storagePath...),
 *   so the uploads route and cron that consume it keep working. backupUrl now
 *   equals the Spaces URL rather than a Supabase URL.
 * - /thumbnail still works. It pulls the source video from the Space to a temp
 *   file, runs ffmpeg, returns the frame. It no longer assumes the video is on
 *   local disk (which was the other thing breaking after a deploy).
 * - /restore is kept as a harmless no-op that reports the Spaces URL, so any
 *   old caller still gets a 200 instead of erroring. It no longer downloads
 *   anything, which is the whole point.
 * - If SPACES_KEY is somehow unset, every route fails loudly rather than
 *   silently falling back to the disk-and-Supabase behavior we are removing.
 *
 * Path: src/media-upload.js
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const spaces = require('./lib/spaces');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'video/mp4', 'video/quicktime'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

// ── Upload single file (Spaces only) ───────────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!spaces.spacesConfigured) {
      return res.status(500).json({ error: 'Spaces not configured (SPACES_KEY/SPACES_SECRET missing)' });
    }
    const { slug } = req.body;
    if (!slug || !req.file) {
      return res.status(400).json({ error: 'slug and file are required' });
    }

    const cleanSlug = slug.replace(/[^a-z0-9-]/gi, '').toLowerCase();
    const ext = path.extname(req.file.originalname).toLowerCase() ||
                (req.file.mimetype.includes('video') ? '.mp4' : '.png');
    const hash = crypto.randomBytes(6).toString('hex');
    const filename = `${Date.now()}-${hash}${ext}`;
    const storagePath = `${cleanSlug}/${filename}`;

    // Single write: straight to the Space.
    const url = await spaces.uploadBuffer(storagePath, req.file.buffer, req.file.mimetype);

    console.log(`[MEDIA] Uploaded to Spaces: ${url} (${(req.file.size / 1024).toFixed(0)}KB)`);

    // backupUrl mirrors url now (same durable store). Kept in the response so
    // downstream code that reads backup_url still gets a valid URL.
    res.json({
      url,
      backupUrl: url,
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

// ── Restore (no-op) ─────────────────────────────────────────────
// Spaces is durable, so there is nothing to restore. Old callers (the process
// cron's HEAD-check fallback) still get a 200 with the current URL so nothing
// breaks, but no bytes move. This is the call that used to cost egress.
router.post('/restore', async (req, res) => {
  try {
    const { storage_path } = req.body;
    if (!storage_path) return res.status(400).json({ error: 'storage_path required' });
    const url = spaces.publicUrl(storage_path);
    const present = await spaces.exists(storage_path);
    console.log(`[MEDIA] Restore no-op for ${storage_path} (present=${present})`);
    res.json({ restored: present, url, note: 'Spaces is durable; no restore needed' });
  } catch (err) {
    console.error('[MEDIA] Restore error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Extract video thumbnail ─────────────────────────────────────
// Pulls the source video from the Space to a temp file (this is same-region
// private traffic, effectively free), runs ffmpeg, returns the frame as base64.
router.post('/thumbnail', async (req, res) => {
  let tmpVideo = null;
  let thumbPath = null;
  try {
    const { video_path, timestamp } = req.body;
    if (!video_path) return res.status(400).json({ error: 'video_path required' });
    if (!spaces.spacesConfigured) {
      return res.status(500).json({ error: 'Spaces not configured' });
    }

    // Download the source video from the Space to a temp file.
    const url = spaces.publicUrl(video_path);
    const resp = await fetch(url);
    if (!resp.ok) return res.status(404).json({ error: `Video not found in Spaces: ${video_path} (${resp.status})` });
    const videoBuf = Buffer.from(await resp.arrayBuffer());

    const tmpDir = os.tmpdir();
    tmpVideo = path.join(tmpDir, `src-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(video_path) || '.mp4'}`);
    fs.writeFileSync(tmpVideo, videoBuf);

    thumbPath = path.join(tmpDir, `thumb-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`);
    const seekTime = timestamp || '1';

    const tryExtract = (time) => new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-ss', time, '-i', tmpVideo, '-vframes', '1', '-q:v', '2', '-y', thumbPath]);
      let stderr = '';
      ff.stderr.on('data', d => stderr += d.toString());
      ff.on('close', code => {
        if (code === 0 && fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}`));
      });
      ff.on('error', reject);
    });

    try { await tryExtract(seekTime); } catch { await tryExtract('0'); }

    const thumbBuffer = fs.readFileSync(thumbPath);
    const base64 = thumbBuffer.toString('base64');

    console.log(`[MEDIA] Thumbnail extracted for ${video_path}`);
    res.json({ base64: `data:image/jpeg;base64,${base64}` });
  } catch (err) {
    console.error('[MEDIA] Thumbnail error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { if (tmpVideo && fs.existsSync(tmpVideo)) fs.unlinkSync(tmpVideo); } catch {}
    try { if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath); } catch {}
  }
});

// ── Delete a media object from the Space ────────────────────────
// Used by the cleanup cron. Deleting the source once a post is published is
// safe and keeps the Space small.
router.post('/delete', async (req, res) => {
  try {
    const { storage_path } = req.body;
    if (!storage_path) return res.status(400).json({ error: 'storage_path required' });
    await spaces.deleteObject(storage_path);
    res.json({ deleted: true, storage_path });
  } catch (err) {
    console.error('[MEDIA] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'media-upload', store: 'spaces', bucket: spaces.BUCKET, configured: spaces.spacesConfigured });
});

module.exports = router;