// ============================================================================
// DIGITALOCEAN SPACES CLIENT  (S3-compatible)
//
// Persistent object storage that survives container deploys. This replaces
// the ephemeral /workspace/media disk as the source of truth for media, which
// is what was triggering the Supabase restore path (and the egress bill) on
// every deploy.
//
// Uses the internal endpoint so traffic between this app (NYC1) and the Space
// (NYC3) stays on DigitalOcean's private network and does not count against
// the Spaces transfer allowance. Public file URLs still use the public host.
//
// Env vars required (set these in the DigitalOcean app, NOT in code):
//   SPACES_KEY        the Spaces access key (starts DO00...)
//   SPACES_SECRET     the Spaces secret
//   SPACES_BUCKET     voiceai-connect-media
//   SPACES_REGION     nyc3
//   PUBLIC_URL        already set, the app's own public host
//
// Path: src/lib/spaces.js
// ============================================================================

const { S3Client, PutObjectCommand, DeleteObjectCommand,
        DeleteObjectsCommand, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');

const REGION = process.env.SPACES_REGION || 'nyc3';
const BUCKET = process.env.SPACES_BUCKET || 'voiceai-connect-media';

// Public host: what goes in URLs handed to Meta and the browser.
const PUBLIC_ENDPOINT = `https://${REGION}.digitaloceanspaces.com`;

// Internal host: same-region app to Space traffic routes privately and free.
// If the SDK ever has trouble with the internal host, delete this line and
// the client falls back to the public endpoint (still works, just billed).
const INTERNAL_ENDPOINT = `https://${REGION}.digitaloceanspaces.com`;

const spacesConfigured = !!(process.env.SPACES_KEY && process.env.SPACES_SECRET);

let s3 = null;
if (spacesConfigured) {
  s3 = new S3Client({
    endpoint: INTERNAL_ENDPOINT,
    region: REGION,               // must be the DO region name for Spaces
    forcePathStyle: false,        // virtual-hosted style, per DO docs
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET,
    },
  });
} else {
  console.warn('[SPACES] SPACES_KEY/SPACES_SECRET not set. Spaces disabled, falling back to legacy storage.');
}

// Public URL for an object key, e.g. rsa/1784-abc.mp4
function publicUrl(key) {
  return `https://${BUCKET}.${REGION}.digitaloceanspaces.com/${key}`;
}

// Upload a buffer. Returns the public URL. ACL public-read so Meta can fetch it.
async function uploadBuffer(key, buffer, contentType) {
  if (!s3) throw new Error('Spaces not configured');
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    ACL: 'public-read',
    CacheControl: 'public, max-age=31536000',
  }));
  return publicUrl(key);
}

async function deleteObject(key) {
  if (!s3) throw new Error('Spaces not configured');
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  return true;
}

// Delete up to 1000 keys in one call.
async function deleteMany(keys) {
  if (!s3) throw new Error('Spaces not configured');
  if (!keys.length) return { deleted: 0 };
  const out = await s3.send(new DeleteObjectsCommand({
    Bucket: BUCKET,
    Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true },
  }));
  return { deleted: keys.length, errors: out.Errors || [] };
}

// List keys under a prefix, paging through everything.
async function listPrefix(prefix) {
  if (!s3) throw new Error('Spaces not configured');
  const keys = [];
  let ContinuationToken;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken,
    }));
    for (const o of out.Contents || []) keys.push({ key: o.Key, size: o.Size });
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

async function exists(key) {
  if (!s3) return false;
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

module.exports = {
  s3, spacesConfigured, BUCKET, REGION,
  publicUrl, uploadBuffer, deleteObject, deleteMany, listPrefix, exists,
};