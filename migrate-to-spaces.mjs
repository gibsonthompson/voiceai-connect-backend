/**
 * One-time migration: Supabase content-media  ->  DigitalOcean Space
 *
 * WHAT IT DOES
 * For every file in the Supabase content-media bucket, copies it into the new
 * Space at the same key, then (optionally) rewrites the matching
 * cf_content_uploads rows so media_url and backup_url point at the Space.
 *
 * WHY
 * Existing posts still reference urchin-app.../media/... (local disk, wiped on
 * deploy) with a Supabase backup_url. After this runs, both point at the Space,
 * which is durable, so the restore path never fires again.
 *
 * SAFE BY DEFAULT
 * DRY_RUN is true. It reports what it would copy and repoint, and changes
 * nothing. Set DRY_RUN=false to execute. Copies are idempotent (upsert), so
 * re-running is safe.
 *
 * DELETES NOTHING. The Supabase originals stay until you confirm the Space has
 * everything and delete them separately (cleanup-storage.mjs).
 *
 * RUN
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *   SPACES_KEY=... SPACES_SECRET=... SPACES_BUCKET=voiceai-connect-media \
 *   SPACES_REGION=nyc3 \
 *   node migrate-to-spaces.mjs
 *
 * Requires: npm i @supabase/supabase-js @aws-sdk/client-s3
 */

import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const DRY_RUN = true;            // set false to execute
const SUPA_BUCKET = 'content-media';
const REPOINT_DB = true;         // rewrite cf_content_uploads URLs after copy
const FOLDERS = ['rsa', 'callbird', 'gtc'];  // skip 'thumbnails', they regenerate

const supaUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supaKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const REGION = process.env.SPACES_REGION || 'nyc3';
const BUCKET = process.env.SPACES_BUCKET || 'voiceai-connect-media';

for (const [k, v] of Object.entries({ SUPABASE_URL: supaUrl, SUPABASE_SERVICE_KEY: supaKey, SPACES_KEY: process.env.SPACES_KEY, SPACES_SECRET: process.env.SPACES_SECRET })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

const supabase = createClient(supaUrl, supaKey);
const s3 = new S3Client({
  endpoint: `https://${REGION}.digitaloceanspaces.com`,
  region: REGION,
  forcePathStyle: false,
  credentials: { accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET },
});

const spaceUrl = (key) => `https://${BUCKET}.${REGION}.digitaloceanspaces.com/${key}`;

async function listSupabaseFolder(folder) {
  const all = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(SUPA_BUCKET)
      .list(folder, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`list ${folder}: ${error.message}`);
    if (!data?.length) break;
    for (const o of data) if (o.id) all.push(`${folder}/${o.name}`);
    if (data.length < 100) break;
    offset += 100;
  }
  return all;
}

async function existsInSpace(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

function human(b) { const u=['B','KB','MB','GB']; let n=b,i=0; while(n>=1024&&i<3){n/=1024;i++;} return `${n.toFixed(1)} ${u[i]}`; }

async function main() {
  console.log(`Migration ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}  Supabase/${SUPA_BUCKET} -> Space/${BUCKET} @ ${REGION}\n`);

  let copied = 0, skipped = 0, bytes = 0, repointed = 0;

  for (const folder of FOLDERS) {
    let keys;
    try { keys = await listSupabaseFolder(folder); }
    catch (e) { console.log(`  ${folder}: ${e.message}`); continue; }
    console.log(`${folder}/  ${keys.length} files`);

    for (const key of keys) {
      // Already in the Space? skip the copy.
      if (await existsInSpace(key)) { skipped++; continue; }

      // Download from Supabase (public URL) and put to Space.
      const { data: pub } = supabase.storage.from(SUPA_BUCKET).getPublicUrl(key);
      const publicUrl = pub?.publicUrl;

      if (DRY_RUN) {
        console.log(`  would copy  ${key}`);
        copied++;
        continue;
      }

      const resp = await fetch(publicUrl);
      if (!resp.ok) { console.log(`  FAIL fetch ${key} (${resp.status})`); continue; }
      const buf = Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get('content-type') || 'application/octet-stream';

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: buf, ContentType: ct,
        ACL: 'public-read', CacheControl: 'public, max-age=31536000',
      }));
      copied++; bytes += buf.length;
      console.log(`  copied  ${key}  ${human(buf.length)}`);
    }
  }

  console.log(`\nCopied ${copied}, skipped ${skipped} already present, ${human(bytes)} moved.`);

  // ── Repoint database URLs ─────────────────────────────────────
  if (REPOINT_DB) {
    console.log(`\nRepointing cf_content_uploads URLs to the Space...`);
    const { data: rows, error } = await supabase
      .from('cf_content_uploads')
      .select('id, storage_path, media_url, backup_url')
      .not('storage_path', 'is', null);
    if (error) { console.log(`  DB read failed: ${error.message}`); }
    else {
      for (const r of rows) {
        const target = spaceUrl(r.storage_path);
        if (r.media_url === target && r.backup_url === target) continue;
        if (DRY_RUN) { console.log(`  would repoint ${r.storage_path}`); repointed++; continue; }
        const { error: upErr } = await supabase.from('cf_content_uploads')
          .update({ media_url: target, backup_url: target })
          .eq('id', r.id);
        if (upErr) console.log(`  repoint FAIL ${r.id}: ${upErr.message}`);
        else { repointed++; }
      }
      console.log(`  ${DRY_RUN ? 'would repoint' : 'repointed'} ${repointed} rows.`);
    }
  }

  console.log(`\n${DRY_RUN ? 'DRY RUN complete. Set DRY_RUN=false to execute.' : 'Migration complete.'}`);
}

main().catch(e => { console.error(e); process.exit(1); });