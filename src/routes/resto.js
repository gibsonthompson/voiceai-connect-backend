// ============================================================================
// RESTORATION PLATFORM ROUTES  (mounted at /api/resto)
// Lives in voiceai-connect-backend/src/routes/. Reuses the existing Supabase
// service client and CORS. /report is implemented; scope/ocr/esx are stubs.
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

// POST /api/resto/scope  -> structured IICRC scope (stub)
router.post('/scope', async (_req, res) => res.status(501).json({ error: 'not implemented', module: 'scopes' }));

// POST /api/resto/ocr  -> meter reading OCR (stub)
router.post('/ocr', async (_req, res) => res.status(501).json({ error: 'not implemented', module: 'hydro/meter-ocr' }));

// POST /api/resto/esx  -> Xactimate ESX export (stub)
router.post('/esx', async (_req, res) => res.status(501).json({ error: 'not implemented', module: 'esx' }));

router.get('/health', (_req, res) => res.json({ ok: true, scope: 'resto' }));

module.exports = router;