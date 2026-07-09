// ============================================================================
// RESTORATION PLATFORM ROUTES  (mounted at /api/resto)
// Lives in voiceai-connect-backend/src/routes/. Reuses the existing Supabase
// service client and CORS. /report, /drying-log, /mold-scan, /ocr, /scope are
// implemented; esx remains a stub.
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

    const title = `Full Report - ${claim.policyholder_name || 'Claim'} - ${new Date().toLocaleDateString()}`;
    const { data: doc } = await supabase.from('resto_documents').insert({
      org_id: claim.org_id, claim_id: claim.id, type: 'full_export',
      storage_path: path, title, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    }).select('*').single();

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

    const title = `Daily Drying Log - ${claim.policyholder_name || 'Claim'} - ${new Date().toLocaleDateString()}`;
    const { data: doc } = await supabase.from('resto_documents').insert({
      org_id: claim.org_id, claim_id: claim.id, type: 'drying_report',
      storage_path: path, title, status: 'final',
      generated_at: new Date().toISOString(), created_by: user.id
    }).select('*').single();

    res.json({ ok: true, document: doc });
  } catch (e) {
    console.error('resto drying-log error:', e.message);
    res.status(500).json({ error: 'drying log generation failed' });
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

// POST /api/resto/esx  -> Xactimate ESX export (stub)
router.post('/esx', async (_req, res) => res.status(501).json({ error: 'not implemented', module: 'esx' }));

router.get('/health', (_req, res) => res.json({ ok: true, scope: 'resto' }));

module.exports = router;