// ============================================================================
// RESTORATION PLATFORM ROUTES  (mounted at /api/resto)
// Lives in voiceai-connect-backend/src/routes/. Reuses the existing Supabase
// service client and CORS. /report, /drying-log, /mold-scan, /ocr, /doc-scan,
// /scope, /esx are implemented.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { supabase } = require('../lib/supabase'); // service-role client (bypasses RLS)

// Verify the caller's Supabase JWT and confirm they belong to the claim's org.
// Returns { user, claim } or sends an error response and returns null.
async function authClaim(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'missing token' }); return null; }

  const { data: { user } = {}, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !user) { res.status(401).json({ error: 'invalid token' }); return null; }

  const { claimId } = req.body || {};
  if (!claimId) { res.status(400).json({ error: 'claimId required' }); return null; }

  const { data: claim } = await supabase
    .from('resto_claims').select('id, org_id, policyholder_name').eq('id', claimId).single();
  if (!claim) { res.status(404).json({ error: 'claim not found' }); return null; }

  const { data: member } = await supabase
    .from('resto_org_members').select('role')
    .eq('org_id', claim.org_id).eq('user_id', user.id).maybeSingle();
  if (!member) { res.status(403).json({ error: 'forbidden' }); return null; }

  return { user, claim };
}

// POST /api/resto/report  { claimId } -> generates the full carrier-ready PDF,
// stores it, records a resto_documents row, returns the document.
router.post('/report', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;

    const { buildClaimReport } = require('../lib/resto-report');
    const { pdf } = await buildClaimReport(claim.id);

    const path = `${claim.org_id}/${claim.id}/reports/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage.from('resto-media')
      .upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (upErr) { console.error('resto report upload failed:', upErr.message); return res.status(500).json({ error: 'upload failed' }); }

    const title = `Full Report - ${claim.policyholder_name || 'Claim'}`;
    const { data: doc } = await supabase.from('resto_documents').insert({
      org_id: claim.org_id, claim_id: claim.id, type: 'full_export',
      storage_path: path, title, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    }).select('*').single();

    await supabase.from('resto_job_events').insert({
      org_id: claim.org_id, claim_id: claim.id, kind: 'report',
      message: 'Full report generated', meta: {}
    }).then(() => {}, () => {}); // best-effort activity log

    res.json({ ok: true, document: doc });
  } catch (e) {
    console.error('resto report error:', e.message);
    res.status(500).json({ error: 'report generation failed' });
  }
});

// POST /api/resto/drying-log  { claimId } -> generates the Daily Drying Log /
// Moisture Log PDF (cover + one page per chamber) from Hydro data, stores it,
// records a resto_documents row, returns the document.
router.post('/drying-log', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;

    const { buildDryingLog } = require('../lib/resto-drying-log');
    const { pdf } = await buildDryingLog(claim.id);

    const path = `${claim.org_id}/${claim.id}/reports/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage.from('resto-media')
      .upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (upErr) { console.error('resto drying-log upload failed:', upErr.message); return res.status(500).json({ error: 'upload failed' }); }

    const title = `Daily Drying Log - ${claim.policyholder_name || 'Claim'}`;
    const { data: doc } = await supabase.from('resto_documents').insert({
      org_id: claim.org_id, claim_id: claim.id, type: 'drying_report',
      storage_path: path, title, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    }).select('*').single();

    await supabase.from('resto_job_events').insert({
      org_id: claim.org_id, claim_id: claim.id, kind: 'report',
      message: 'Daily drying log generated', meta: {}
    }).then(() => {}, () => {}); // best-effort activity log

    res.json({ ok: true, document: doc });
  } catch (e) {
    console.error('resto drying-log error:', e.message);
    res.status(500).json({ error: 'drying log generation failed' });
  }
});

// POST /api/resto/share-link  { claimId } -> mints (or returns) the claim's
// public token. The Share page builds /api/resto/public/{token} from this.
router.post('/share-link', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { claim } = ctx;

    const { data: row } = await supabase.from('resto_claims').select('public_token').eq('id', claim.id).single();
    let token = row && row.public_token;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      const { error } = await supabase.from('resto_claims').update({ public_token: token }).eq('id', claim.id);
      if (error) { console.error('resto share-link update failed:', error.message); return res.status(500).json({ error: 'share link failed' }); }
    }
    res.json({ ok: true, token });
  } catch (e) {
    console.error('resto share-link error:', e.message);
    res.status(500).json({ error: 'share link failed' });
  }
});

// GET /api/resto/public/:token -> serves the claim's carrier-ready report PDF
// publicly (no login). The token is an unguessable secret; anyone with the link
// can view the report. Generated fresh so the recipient always sees the latest.
router.get('/public/:token/:name?', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).send('missing token');

    const { data: claim } = await supabase.from('resto_claims').select('id, policyholder_name').eq('public_token', token).maybeSingle();
    if (!claim) return res.status(404).send('report not found');

    const { buildClaimReport } = require('../lib/resto-report');
    const { pdf } = await buildClaimReport(claim.id);

    const cleanName = (claim.policyholder_name || 'Report').replace(/[^\w]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const fname = `Restoration-Report-${cleanName}.pdf`;
    const asDownload = req.query.download === '1' || req.query.download === 'true';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${asDownload ? 'attachment' : 'inline'}; filename="${fname}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (e) {
    console.error('resto public error:', e.message);
    res.status(500).send('report unavailable');
  }
});

// GET /api/resto/document/:id/:name? — streams a stored report PDF from OUR domain
// (via the Vercel /api proxy) with a clean filename, so the Supabase storage host
// and its random object name are never exposed when viewing/sharing. Authed with
// the session token in ?t= because the in-app PDF viewer and download anchors
// can't send an Authorization header.
router.get('/document/:id/:name?', async (req, res) => {
  try {
    const token = req.query.t;
    if (!token) return res.status(401).send('unauthorized');
    const { data: { user } = {} } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).send('unauthorized');

    const { data: doc } = await supabase.from('resto_documents')
      .select('org_id, storage_path, title').eq('id', req.params.id).maybeSingle();
    if (!doc || !doc.storage_path) return res.status(404).send('not found');

    const { data: member } = await supabase.from('resto_org_members')
      .select('role').eq('org_id', doc.org_id).eq('user_id', user.id).maybeSingle();
    if (!member) return res.status(403).send('forbidden');

    const { data: file, error } = await supabase.storage.from('resto-media').download(doc.storage_path);
    if (error || !file) return res.status(404).send('file not found');
    const buf = Buffer.from(await file.arrayBuffer());

    const clean = (doc.title || 'Report').replace(/[^\w]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const asDownload = req.query.download === '1' || req.query.download === 'true';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${asDownload ? 'attachment' : 'inline'}; filename="${clean}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch (e) {
    console.error('resto document error:', e.message);
    res.status(500).send('unavailable');
  }
});

// POST /api/resto/mold-scan  { claimId, mediaId } -> Claude-vision mold screening
// of one photo. Records a resto_mold_scans row and returns it.
router.post('/mold-scan', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;

    const { mediaId } = req.body || {};
    if (!mediaId) return res.status(400).json({ error: 'mediaId required' });

    const { scanMedia } = require('../lib/resto-mold');
    const scan = await scanMedia({ mediaId, orgId: claim.org_id, userId: user.id });
    res.json({ ok: true, scan });
  } catch (e) {
    const msg = e.message || 'mold scan failed';
    const code = msg === 'forbidden' ? 403
      : msg === 'media not found' || msg === 'not a photo' ? 400
      : msg === 'mold scanner not configured' ? 503 : 500;
    if (code === 500) console.error('resto mold-scan error:', msg);
    res.status(code).json({ error: msg });
  }
});

// POST /api/resto/scope  { claimId } -> AI IICRC scope of work (Haiku draft -> Sonnet final)
router.post('/scope', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;
    const { generateScope } = require('../lib/resto-scope');
    const scope = await generateScope({ claimId: claim.id, orgId: claim.org_id, userId: user.id });
    res.json({ ok: true, scope });
  } catch (e) {
    const msg = e.message || 'scope failed';
    const code = msg === 'scope not configured' ? 503 : msg === 'claim not found' ? 404 : 500;
    if (code === 500) console.error('resto scope error:', msg);
    res.status(code).json({ error: msg });
  }
});

// POST /api/resto/ocr  { claimId, imageBase64, mediaType } -> meter reading OCR
router.post('/ocr', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { imageBase64, mediaType } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'image required' });
    const { scanMeter } = require('../lib/resto-ocr');
    const reading = await scanMeter({ imageBase64, mediaType });
    res.json({ ok: true, reading });
  } catch (e) {
    const msg = e.message || 'ocr failed';
    const code = msg === 'ocr not configured' ? 503 : msg === 'image required' ? 400 : 500;
    if (code === 500) console.error('resto ocr error:', msg);
    res.status(code).json({ error: msg });
  }
});

// POST /api/resto/doc-scan  { claimId, fileBase64, mediaType } -> reads a carrier
// document (assignment sheet, loss notice, declarations page) and returns the claim
// fields found on it. READ ONLY: this never touches resto_claims. The app shows every
// extracted value beside the current one and the tech confirms each field before it is
// saved, because a misread date of loss corrupts the coverage determination and a
// misread policy number goes out on a carrier package.
router.post('/doc-scan', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { fileBase64, mediaType } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: 'file required' });
    const { scanDocument } = require('../lib/resto-doc-scan');
    const extracted = await scanDocument({ fileBase64, mediaType });
    res.json({ ok: true, extracted });
  } catch (e) {
    const msg = e.message || 'doc scan failed';
    const code = msg === 'doc scan not configured' ? 503
      : msg === 'file required' || msg === 'unsupported file type' ? 400 : 500;
    if (code === 500) console.error('resto doc-scan error:', msg);
    res.status(code).json({ error: msg });
  }
});

// POST /api/resto/esx  { claimId } -> Xactimate ESX export (SCAFFOLD: geometry +
// metadata are correct; XML element names are best-guess pending a reference .esx,
// so the file is not import-ready yet). Stored as a resto_documents 'esx' row.
router.post('/esx', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;

    const { buildEsx } = require('../lib/resto-esx');
    const downloadImage = async (path) => {
      const { data } = await supabase.storage.from('resto-media').download(path);
      return data ? Buffer.from(await data.arrayBuffer()) : null;
    };
    const { esx } = await buildEsx(claim.id, downloadImage);

    const path = `${claim.org_id}/${claim.id}/reports/${crypto.randomUUID()}.esx`;
    const { error: upErr } = await supabase.storage.from('resto-media')
      .upload(path, esx, { contentType: 'application/octet-stream', upsert: false });
    if (upErr) { console.error('resto esx upload failed:', upErr.message); return res.status(500).json({ error: 'upload failed' }); }

    const title = `Xactimate Export (.esx) - ${claim.policyholder_name || 'Claim'}`;
    const { data: doc } = await supabase.from('resto_documents').insert({
      org_id: claim.org_id, claim_id: claim.id, type: 'esx',
      storage_path: path, title, status: 'draft',
      generated_at: new Date().toISOString(), created_by: user.id
    }).select('*').single();

    res.json({ ok: true, document: doc });
  } catch (e) {
    console.error('resto esx error:', e.message);
    res.status(500).json({ error: e.message || 'esx generation failed' });
  }
});

router.get('/health', (_req, res) => res.json({ ok: true, scope: 'resto' }));

module.exports = router;