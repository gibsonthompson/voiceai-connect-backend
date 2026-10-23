// ============================================================================
// CLIENT WORKFLOWS API - the business owner's view of their automations
//
// Mounted under /api/client, so routes are /api/client/:clientId/workflows and
// are already behind the global requireClientAccess gate in server.js (the
// owner, its staff, or the managing agency). The business owner can SEE their
// automations and toggle their own on/off; building/editing stays in the agency
// dashboard. Agency-wide automations are shown read-only ("set by your agency").
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { workflowStats } = require('./workflows');

async function clientAgencyId(clientId) {
  const { data } = await supabase.from('clients').select('agency_id').eq('id', clientId).single();
  return data ? data.agency_id : null;
}

// Load a workflow and classify it for this client:
//   'own'    -> client_id === clientId (toggleable)
//   'agency' -> client_id null and same agency (read-only)
//   null     -> not visible to this client
async function loadForClient(id, clientId) {
  const { data: wf } = await supabase.from('workflows').select('*').eq('id', id).single();
  if (!wf) return { wf: null, scope: null };
  if (wf.client_id === clientId) return { wf, scope: 'own' };
  if (!wf.client_id) {
    const agencyId = await clientAgencyId(clientId);
    if (agencyId && wf.agency_id === agencyId) return { wf, scope: 'agency' };
  }
  return { wf: null, scope: null };
}

// ---------------------------------------------------------------------------
// GET list: this business's own automations + the agency-wide ones affecting it
// ---------------------------------------------------------------------------
router.get('/:clientId/workflows', async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const agencyId = await clientAgencyId(clientId);
    if (!agencyId) return res.status(404).json({ error: 'Business not found' });

    const { data: own } = await supabase
      .from('workflows').select('*')
      .eq('agency_id', agencyId).eq('client_id', clientId).neq('status', 'archived')
      .order('created_at', { ascending: false });

    const { data: agencyWide } = await supabase
      .from('workflows').select('id, name, description, trigger_type, status, template_key')
      .eq('agency_id', agencyId).is('client_id', null).eq('status', 'active')
      .order('created_at', { ascending: false });

    res.json({
      own: (own || []).map((w) => ({ ...w, scope: 'own' })),
      agency_wide: (agencyWide || []).map((w) => ({ ...w, scope: 'agency' })),
    });
  } catch (e) {
    console.error('client workflows list error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST activate / pause  (own automations only)
// ---------------------------------------------------------------------------
async function setStatus(req, res, status) {
  const { wf, scope } = await loadForClient(req.params.id, req.params.clientId);
  if (!wf) return res.status(404).json({ error: 'Automation not found' });
  if (scope !== 'own') return res.status(403).json({ error: 'This automation is managed by your agency.' });

  // Activating needs a published version; it was published when the agency built
  // it. If somehow unpublished, refuse rather than silently doing nothing.
  if (status === 'active' && !wf.live_version_id) {
    return res.status(409).json({ error: 'This automation is not ready yet. Ask your agency to finish it.' });
  }
  const { data: updated, error } = await supabase
    .from('workflows').update({ status, updated_at: new Date().toISOString() }).eq('id', wf.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ workflow: { ...updated, scope: 'own' } });
}
router.post('/:clientId/workflows/:id/activate', (req, res) => setStatus(req, res, 'active'));
router.post('/:clientId/workflows/:id/pause', (req, res) => setStatus(req, res, 'paused'));

// ---------------------------------------------------------------------------
// GET stats / runs (own or agency-wide that affect this business)
// ---------------------------------------------------------------------------
router.get('/:clientId/workflows/:id/stats', async (req, res) => {
  try {
    const { wf } = await loadForClient(req.params.id, req.params.clientId);
    if (!wf) return res.status(404).json({ error: 'Automation not found' });
    res.json({ stats: await workflowStats(wf.id) });
  } catch (e) {
    console.error('client workflow stats error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:clientId/workflows/:id/runs', async (req, res) => {
  try {
    const { wf } = await loadForClient(req.params.id, req.params.clientId);
    if (!wf) return res.status(404).json({ error: 'Automation not found' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    // Only this business's own runs (even for an agency-wide workflow).
    const { data: runs } = await supabase
      .from('workflow_enrollments')
      .select('id, contact_phone, status, stopped_reason, enrolled_at, completed_at')
      .eq('workflow_id', wf.id).eq('client_id', req.params.clientId)
      .order('enrolled_at', { ascending: false }).limit(limit);
    res.json({ runs: runs || [] });
  } catch (e) {
    console.error('client workflow runs error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
