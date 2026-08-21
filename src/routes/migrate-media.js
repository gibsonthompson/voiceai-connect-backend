/**
 * ONE-TIME MIGRATION ROUTE - Supabase content-media -> DigitalOcean Space
 *
 * Runs inside the backend, so it uses the env vars already set on the app
 * (SUPABASE_URL, SUPABASE_SERVICE_KEY, SPACES_KEY, SPACES_SECRET, SPACES_BUCKET,
 * SPACES_REGION). Nothing to set on your laptop. You trigger it from a browser.
 *
 * DELETE THIS FILE once the migration is done.
 *
 * MOUNT (add to server.js near the other app.use lines, then remove later):
 *   app.use('/api/migrate', require('./routes/migrate-media'));
 *
 * USE (in a browser):
 *   Dry run, changes nothing:
 *     /api/migrate/spaces?secret=YOUR_CRON_SECRET
 *   Live, copies files and repoints DB URLs:
 *     /api/migrate/spaces?secret=YOUR_CRON_SECRET&live=true
 *
 * Path: src/routes/migrate-media.js
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const {
  S3Client, PutObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const router = express.Router();

const SUPA_BUCKET = 'content-media';
const FOLDERS = ['rsa', 'callbird', 'gtc']; // skip thumbnails (regenerate) and resto (not ours)

function human(b) { const u = ['B','KB','MB','GB']; let n = b, i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(1)} ${u[i]}`; }

router.get('/spaces', async (req, res) => {
  // Auth: same secret the crons use.
  if (!process.env.CRON_SECRET || req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized. Append ?secret=YOUR_CRON_SECRET' });
  }

  const LIVE = req.query.live === 'true';
  const REGION = process.env.SPACES_REGION || 'nyc3';
  const BUCKET = process.env.SPACES_BUCKET || 'voiceai-connect-media';

  // Guard: make sure everything we need is present before touching anything.
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SPACES_KEY', 'SPACES_SECRET']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: `Missing env vars: ${missing.join(', ')}` });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const s3 = new S3Client({
    endpoint: `https://${REGION}.digitaloceanspaces.com`,
    region: REGION,
    forcePathStyle: false,
    credentials: { accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET },
  });

  const spaceUrl = (key) => `https://${BUCKET}.${REGION}.digitaloceanspaces.com/${key}`;

  const existsInSpace = async (key) => {
    try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
    catch { return false; }
  };

  const listSupabaseFolder = async (folder) => {
    const all = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.storage.from(SUPA_BUCKET)
        .list(folder, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error(`list ${folder}: ${error.message}`);
      if (!data || !data.length) break;
      for (const o of data) if (o.id) all.push(`${folder}/${o.name}`);
      if (data.length < 100) break;
      offset += 100;
    }
    return all;
  };

  const log = [];
  let copied = 0, skipped = 0, failed = 0, bytes = 0, repointed = 0;

  try {
    // ── Copy files ────────────────────────────────────────────
    for (const folder of FOLDERS) {
      let keys = [];
      try { keys = await listSupabaseFolder(folder); }
      catch (e) { log.push(`${folder}: ${e.message}`); continue; }
      log.push(`${folder}/  ${keys.length} files`);

      for (const key of keys) {
        if (await existsInSpace(key)) { skipped++; continue; }

        const { data: pub } = supabase.storage.from(SUPA_BUCKET).getPublicUrl(key);
        const publicUrl = pub && pub.publicUrl;

        if (!LIVE) { copied++; continue; } // dry run just counts

        try {
          const resp = await fetch(publicUrl);
          if (!resp.ok) { failed++; log.push(`  FAIL fetch ${key} (${resp.status})`); continue; }
          const buf = Buffer.from(await resp.arrayBuffer());
          const ct = resp.headers.get('content-type') || 'application/octet-stream';
          await s3.send(new PutObjectCommand({
            Bucket: BUCKET, Key: key, Body: buf, ContentType: ct,
            ACL: 'public-read', CacheControl: 'public, max-age=31536000',
          }));
          copied++; bytes += buf.length;
        } catch (e) {
          failed++; log.push(`  FAIL ${key}: ${e.message}`);
        }
      }
    }

    // ── Repoint DB URLs ───────────────────────────────────────
    const { data: rows, error: readErr } = await supabase
      .from('cf_content_uploads')
      .select('id, storage_path, media_url, backup_url')
      .not('storage_path', 'is', null);

    if (readErr) {
      log.push(`DB read failed: ${readErr.message}`);
    } else {
      for (const r of rows) {
        const target = spaceUrl(r.storage_path);
        if (r.media_url === target && r.backup_url === target) continue;
        if (!LIVE) { repointed++; continue; }
        const { error: upErr } = await supabase.from('cf_content_uploads')
          .update({ media_url: target, backup_url: target })
          .eq('id', r.id);
        if (upErr) { log.push(`repoint FAIL ${r.id}: ${upErr.message}`); }
        else repointed++;
      }
    }

    return res.json({
      mode: LIVE ? 'LIVE' : 'DRY RUN (nothing changed)',
      files_copied: copied,
      files_skipped_already_present: skipped,
      files_failed: failed,
      bytes_moved: human(bytes),
      db_rows_repointed: repointed,
      note: LIVE
        ? 'Migration complete. Verify posts still publish, then delete this route and clean up Supabase.'
        : 'Dry run. Re-run with &live=true to execute.',
      detail: log,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, partial: { copied, skipped, failed, repointed }, detail: log });
  }
});

// ============================================================================
// CLEANUP: delete old copies from the Supabase content-media bucket.
//
// SAFETY: for every file, it first confirms the file EXISTS in the Space before
// deleting it from Supabase. A file that is not confirmed in the Space is left
// alone. So this can never delete something that was not already migrated.
//
// Deletes through the Supabase Storage API (not SQL), so no S3 orphans.
// Skips the resto-media bucket entirely; only touches content-media.
//
// USE (browser):
//   Dry run, counts only:
//     /api/migrate/cleanup?secret=YOUR_CRON_SECRET
//   Live delete:
//     /api/migrate/cleanup?secret=YOUR_CRON_SECRET&live=true
//   Also clear old thumbnails (they regenerate):
//     /api/migrate/cleanup?secret=YOUR_CRON_SECRET&live=true&thumbnails=true
// ============================================================================
router.get('/cleanup', async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized. Append ?secret=YOUR_CRON_SECRET' });
  }

  const LIVE = req.query.live === 'true';
  const INCLUDE_THUMBS = req.query.thumbnails === 'true';
  const REGION = process.env.SPACES_REGION || 'nyc3';
  const BUCKET = process.env.SPACES_BUCKET || 'voiceai-connect-media';

  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SPACES_KEY', 'SPACES_SECRET']
    .filter(k => !process.env[k]);
  if (missing.length) return res.status(500).json({ error: `Missing env vars: ${missing.join(', ')}` });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const s3 = new S3Client({
    endpoint: `https://${REGION}.digitaloceanspaces.com`,
    region: REGION,
    forcePathStyle: false,
    credentials: { accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET },
  });

  const existsInSpace = async (key) => {
    try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
    catch { return false; }
  };

  const listSupabaseFolder = async (folder) => {
    const all = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.storage.from(SUPA_BUCKET)
        .list(folder, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error(`list ${folder}: ${error.message}`);
      if (!data || !data.length) break;
      for (const o of data) if (o.id) all.push(`${folder}/${o.name}`);
      if (data.length < 100) break;
      offset += 100;
    }
    return all;
  };

  const folders = [...FOLDERS];
  if (INCLUDE_THUMBS) folders.push('thumbnails');

  const log = [];
  let deleted = 0, kept_not_in_space = 0, failed = 0;

  try {
    for (const folder of folders) {
      let keys = [];
      try { keys = await listSupabaseFolder(folder); }
      catch (e) { log.push(`${folder}: ${e.message}`); continue; }

      const toDelete = [];
      for (const key of keys) {
        // Thumbnails are regenerable, so we do not require them in the Space.
        if (folder === 'thumbnails') { toDelete.push(key); continue; }
        // Everything else: only delete if we can confirm it is in the Space.
        if (await existsInSpace(key)) toDelete.push(key);
        else { kept_not_in_space++; log.push(`  KEPT (not in Space) ${key}`); }
      }

      log.push(`${folder}/  ${keys.length} files, ${toDelete.length} safe to delete`);

      if (LIVE && toDelete.length) {
        // Supabase remove() accepts up to 100 paths per call.
        for (let i = 0; i < toDelete.length; i += 100) {
          const batch = toDelete.slice(i, i + 100);
          const { data, error } = await supabase.storage.from(SUPA_BUCKET).remove(batch);
          if (error) { failed += batch.length; log.push(`  batch delete failed: ${error.message}`); }
          else deleted += (data ? data.length : batch.length);
        }
      } else if (!LIVE) {
        deleted += toDelete.length; // dry run reports would-delete count
      }
    }

    return res.json({
      mode: LIVE ? 'LIVE' : 'DRY RUN (nothing deleted)',
      files_deleted: deleted,
      files_kept_because_not_in_space: kept_not_in_space,
      files_failed: failed,
      thumbnails_included: INCLUDE_THUMBS,
      note: LIVE
        ? 'Supabase copies removed. Storage gauge updates in a few minutes.'
        : 'Dry run. Re-run with &live=true to delete. Add &thumbnails=true to also clear thumbnails.',
      detail: log,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, partial: { deleted, kept_not_in_space, failed }, detail: log });
  }
});

module.exports = router;