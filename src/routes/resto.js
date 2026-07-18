// ============================================================================
// RESTORATION PLATFORM ROUTES  (mounted at /api/resto)
// Lives in voiceai-connect-backend/src/routes/. Reuses the existing Supabase
// service client and CORS. /report, /drying-log, /mold-scan, /ocr, /doc-scan,
// /scope, /form-pdf, /client-pack, /measurements, /esx, /underlay, /entry-sheet
// are implemented.
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

// Insert the resto_documents row and THROW if the database refuses it.
//
// Every generator route used to write this as:
//   const { data: doc } = await supabase.from('resto_documents').insert(...)
// with no look at `error`. A check-constraint violation on `type` therefore
// produced data:null, error:<violation>, and the route still answered
// { ok: true, document: null }. The PDF sat in storage, no row existed, and the
// button reported success while the Documents list stayed empty. A generator
// that cannot record its output has failed, so it now says so.
async function insertDocument(row) {
  const { data, error } = await supabase.from('resto_documents').insert(row).select('*').single();
  if (error) throw new Error('could not record the document: ' + error.message);
  if (!data) throw new Error('could not record the document');
  return data;
}

// Best-effort activity log. Never allowed to fail a generation.
function logEvent(claim, message) {
  return supabase.from('resto_job_events').insert({
    org_id: claim.org_id, claim_id: claim.id, kind: 'report', message, meta: {}
  }).then(() => {}, () => {});
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

    const doc = await insertDocument({
      org_id: claim.org_id, claim_id: claim.id, type: 'full_export',
      storage_path: path, title: `Full Report - ${claim.policyholder_name || 'Claim'}`, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    });

    await logEvent(claim, 'Full report generated');

    res.json({ ok: true, document: doc });
  } catch (e) {
    console.error('resto report error:', e.message);
    res.status(500).json({ error: e.message || 'report generation failed' });
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

    const doc = await insertDocument({
      org_id: claim.org_id, claim_id: claim.id, type: 'drying_report',
      storage_path: path, title: `Daily Drying Log - ${claim.policyholder_name || 'Claim'}`, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    });

    await logEvent(claim, 'Daily drying log generated');

    res.json({ ok: true, document: doc });
  } catch (e) {
    console.error('resto drying-log error:', e.message);
    res.status(500).json({ error: e.message || 'drying log generation failed' });
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

// GET /api/resto/document/:id/:name? streams a stored document from OUR domain
// (via the Vercel /api proxy) with a clean filename, so the Supabase storage host
// and its random object name are never exposed when viewing/sharing. Authed with
// the session token in ?t= because the in-app viewer and download anchors can't
// send an Authorization header.
//
// The content type and filename extension are taken from the stored object's own
// extension, not hardcoded to PDF. Reports and the entry sheet are PDFs, the
// Xactimate underlay is a PNG. Serving a PNG as application/pdf made the in-app
// viewer choke, so the type now follows the file.
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

    const ext = (doc.storage_path.split('.').pop() || 'pdf').toLowerCase();
    const CT = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
    const contentType = CT[ext] || 'application/octet-stream';
    const outExt = ext === 'jpeg' ? 'jpg' : ext;

    const clean = (doc.title || 'Report').replace(/[^\w]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const asDownload = req.query.download === '1' || req.query.download === 'true';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `${asDownload ? 'attachment' : 'inline'}; filename="${clean}.${outExt}"`);
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

// POST /api/resto/form-pdf  { claimId, signatureId } -> one signed form as its own
// downloadable PDF. Renders the signature's doc_snapshot (the terms as they stood
// when it was signed), never a live template.
//
// The snapshot is frozen at signing time and re-signing INSERTS a new signature row,
// so one signatureId can only ever produce one PDF. If we already built it, hand back
// the same document instead of uploading a byte-identical file and creating a second
// row that clutters the Documents list.
router.post('/form-pdf', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;

    const { signatureId } = req.body || {};
    if (!signatureId) return res.status(400).json({ error: 'signatureId required' });

    const { data: existing } = await supabase.from('resto_documents')
      .select('*').eq('signature_id', signatureId).eq('claim_id', claim.id).maybeSingle();
    if (existing && existing.storage_path) {
      return res.json({ ok: true, document: existing, cached: true });
    }

    const { buildFormPdf } = require('../lib/resto-form-pdf');
    const { pdf, title } = await buildFormPdf(claim.id, signatureId);

    const path = `${claim.org_id}/${claim.id}/forms/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage.from('resto-media')
      .upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (upErr) { console.error('resto form-pdf upload failed:', upErr.message); return res.status(500).json({ error: 'upload failed' }); }

    const doc = await insertDocument({
      org_id: claim.org_id, claim_id: claim.id, type: 'form', signature_id: signatureId,
      storage_path: path, title: `${title} - ${claim.policyholder_name || 'Claim'}`, status: 'signed',
      generated_at: new Date().toISOString(), created_by: user.id
    });

    res.json({ ok: true, document: doc });
  } catch (e) {
    const msg = e.message || 'form pdf failed';
    const code = msg === 'signature not found' || msg === 'claim not found' ? 404 : msg === 'forbidden' ? 403 : 500;
    if (code === 500) console.error('resto form-pdf error:', msg);
    res.status(code).json({ error: msg });
  }
});

// POST /api/resto/client-pack  { claimId } -> photos + notes only, for the homeowner.
// Contains no line items, quantities, codes, or pricing by design (see resto-client-pack).
router.post('/client-pack', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;

    const { buildClientPack } = require('../lib/resto-client-pack');
    const { pdf } = await buildClientPack(claim.id);

    const path = `${claim.org_id}/${claim.id}/reports/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage.from('resto-media')
      .upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (upErr) { console.error('resto client-pack upload failed:', upErr.message); return res.status(500).json({ error: 'upload failed' }); }

    const doc = await insertDocument({
      org_id: claim.org_id, claim_id: claim.id, type: 'client_pack',
      storage_path: path, title: `Photos & Notes - ${claim.policyholder_name || 'Claim'}`, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    });

    await logEvent(claim, 'Client photo & note pack generated');

    res.json({ ok: true, document: doc });
  } catch (e) {
    const msg = e.message || 'client pack failed';
    const code = msg === 'claim not found' ? 404 : 500;
    if (code === 500) console.error('resto client-pack error:', msg);
    res.status(code).json({ error: msg });
  }
});

// POST /api/resto/measurements  { claimId } -> the room-by-room measurement sheet:
// floor, ceiling, perimeter, wall area with every opening deducted, and baseboard.
// Shows its arithmetic, because an adjuster will ask how the wall area was reached.
// No prices: Xactimate prices this, we only measure it.
router.post('/measurements', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;

    const { buildMeasurementPdf } = require('../lib/resto-measurements-pdf');
    const { pdf } = await buildMeasurementPdf(claim.id);

    const path = `${claim.org_id}/${claim.id}/reports/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage.from('resto-media')
      .upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (upErr) { console.error('resto measurements upload failed:', upErr.message); return res.status(500).json({ error: 'upload failed' }); }

    const doc = await insertDocument({
      org_id: claim.org_id, claim_id: claim.id, type: 'measurements',
      storage_path: path, title: `Measurements - ${claim.policyholder_name || 'Claim'}`, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    });

    await logEvent(claim, 'Measurement sheet generated');

    res.json({ ok: true, document: doc });
  } catch (e) {
    const msg = e.message || 'measurements failed';
    const code = msg === 'claim not found' ? 404 : 500;
    if (code === 500) console.error('resto measurements error:', msg);
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

    const doc = await insertDocument({
      org_id: claim.org_id, claim_id: claim.id, type: 'esx',
      storage_path: path, title: `Xactimate Export (.esx) - ${claim.policyholder_name || 'Claim'}`, status: 'draft',
      generated_at: new Date().toISOString(), created_by: user.id
    });

    res.json({ ok: true, document: doc });
  } catch (e) {
    console.error('resto esx error:', e.message);
    res.status(500).json({ error: e.message || 'esx generation failed' });
  }
});

// POST /api/resto/underlay  { claimId, structureId? } -> renders a structure level
// to a to-scale PNG the estimator imports into Xactimate as a Sketch underlay and
// traces over. Uses the same placement math the esx uses, so the plan matches. When
// structureId is omitted, the claim's first structure is used. Stored as a PNG under
// a resto_documents 'upload' row (allowed by the type check, no schema change).
router.post('/underlay', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;
    const { structureId } = req.body || {};

    const { buildClaimUnderlay } = require('../lib/resto-underlay');
    const { png, structure } = await buildClaimUnderlay(claim.id, structureId);

    const path = `${claim.org_id}/${claim.id}/reports/${crypto.randomUUID()}.png`;
    const { error: upErr } = await supabase.storage.from('resto-media')
      .upload(path, png, { contentType: 'image/png', upsert: false });
    if (upErr) { console.error('resto underlay upload failed:', upErr.message); return res.status(500).json({ error: 'upload failed' }); }

    const suffix = structure && structure.name ? ` (${structure.name})` : '';
    const doc = await insertDocument({
      org_id: claim.org_id, claim_id: claim.id, type: 'upload',
      storage_path: path, title: `Xactimate Underlay${suffix} - ${claim.policyholder_name || 'Claim'}`, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    });

    await logEvent(claim, 'Xactimate underlay generated');

    res.json({ ok: true, document: doc });
  } catch (e) {
    const msg = e.message || 'underlay generation failed';
    const code = msg === 'claim not found' ? 404
      : msg === 'no drawn rooms for this structure' ? 400 : 500;
    if (code === 500) console.error('resto underlay error:', e.message);
    res.status(code).json({ error: msg });
  }
});

// POST /api/resto/entry-sheet  { claimId } -> a per-room list of Xactimate line items
// (CAT, SEL, quantity, unit) with the F9 justification note under each line, for a tech
// to key straight into Xactimate. Same line-item model as the esx, rendered for humans.
// No prices: Xactimate reprices from its own list. Stored as a resto_documents 'upload'
// PDF row (allowed by the type check, no schema change).
router.post('/entry-sheet', async (req, res) => {
  try {
    const ctx = await authClaim(req, res);
    if (!ctx) return;
    const { user, claim } = ctx;

    const { buildEntrySheet } = require('../lib/resto-entry-sheet');
    const { pdf } = await buildEntrySheet(claim.id);

    const path = `${claim.org_id}/${claim.id}/reports/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage.from('resto-media')
      .upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (upErr) { console.error('resto entry-sheet upload failed:', upErr.message); return res.status(500).json({ error: 'upload failed' }); }

    const doc = await insertDocument({
      org_id: claim.org_id, claim_id: claim.id, type: 'upload',
      storage_path: path, title: `Xactimate Entry Sheet - ${claim.policyholder_name || 'Claim'}`, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    });

    await logEvent(claim, 'Xactimate entry sheet generated');

    res.json({ ok: true, document: doc });
  } catch (e) {
    console.error('resto entry-sheet error:', e.message);
    res.status(500).json({ error: e.message || 'entry sheet generation failed' });
  }
});

router.get('/health', (_req, res) => res.json({ ok: true, scope: 'resto' }));

module.exports = router;