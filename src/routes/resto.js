// ============================================================================
// RESTORATION PLATFORM ROUTES  (mounted at /api/resto)
// Lives inside voiceai-connect-backend. Reuses the existing Supabase service
// client and CORS. Namespaced under /api/resto so nothing collides with the
// VoiceAI routes. All four endpoints are stubs (501) until the matching feature
// is built; the structure is here so wiring is a one-line change later.
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase'); // service-role client (bypasses RLS)

// Anthropic client. Requires ANTHROPIC_API_KEY in the DigitalOcean env and
// `npm install @anthropic-ai/sdk` on the box. Lazy-loaded so a missing key only
// breaks the AI endpoints, not the whole backend.
let anthropic = null;
function getAnthropic() {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// Cost discipline (standing rule): Haiku for extraction/drafts, Sonnet for final.
const MODELS = {
  draft: 'claude-haiku-4-5-20251001',
  final: 'claude-sonnet-4-6',
};

// POST /api/resto/scope
// Body: { roomId } -> structured IICRC scope (narrative + line items).
// TODO: load room notes/photos/readings via supabase, build prompt with IICRC
// corpus, Haiku draft -> Sonnet final, validation pass (no invented line items).
router.post('/scope', async (req, res) => {
  res.status(501).json({ error: 'not implemented', module: 'scopes' });
});

// POST /api/resto/ocr
// Body: { imageBase64 } -> { tempF, rhPct }. Claude vision reads the meter.
router.post('/ocr', async (req, res) => {
  res.status(501).json({ error: 'not implemented', module: 'hydro/meter-ocr' });
});

// POST /api/resto/report
// Body: { claimId, type } -> branded PDF from REAL captured data.
// type: preliminary_report | drying_report | schedule_of_loss | full_export.
router.post('/report', async (req, res) => {
  res.status(501).json({ error: 'not implemented', module: 'reports' });
});

// POST /api/resto/esx
// Body: { claimId } -> Xactimate ESX (zipped XML). No Verisk partnership needed.
router.post('/esx', async (req, res) => {
  res.status(501).json({ error: 'not implemented', module: 'esx' });
});

// Health check so you can confirm the mount: GET /api/resto/health
router.get('/health', (req, res) => res.json({ ok: true, scope: 'resto' }));

module.exports = router;