// ============================================================================
// WORKFLOWS API - agency-facing CRUD, publish/activate, runs, stats
//
// The surface both the simple Automations page and the full canvas talk to.
// Agency-scoped and gated by requireAgencyAccess('workflows'), same as the
// other agency routers. Plan gating is enforced here (not just in the UI):
//   - Pro:   capped number of ACTIVE workflows, basic node types only
//   - Scale: unlimited workflows, every node type
//   - Free:  no access
// resolved through entitlementsForAgency() (which honors trials + access_plan).
//
// Versioning: editing a workflow changes its DRAFT graph only. Publishing
// snapshots the draft into workflow_versions and points live_version_id at it,
// so runs already in flight keep executing the version they enrolled on.
// Mounted at app.use('/api/agency', workflowRoutes).
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');
const { getEffectivePlan } = require('../lib/plan-access');
const { entitlementsForAgency, graphWithinPlan } = require('../lib/workflow-nodes');
const { getTemplate, listTemplates } = require('../lib/workflow-templates');

router.use('/:agencyId/workflows', requireAgencyAccess('workflows'));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function loadAgency(agencyId) {
  const { data } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
  return data || null;
}
async function loadWorkflow(id, agencyId) {
  const { data } = await supabase.from('workflows').select('*').eq('id', id).single();
  if (!data || data.agency_id !== agencyId) return null;
  return data;
}
function entSummary(agency) {
  const ent = entitlementsForAgency(agency);
  return {
    plan: getEffectivePlan(agency),
    max_workflows: ent.maxWorkflows === Infinity ? null : ent.maxWorkflows,
    allowed_tiers: ent.allowedTiers,
    has_access: ent.maxWorkflows > 0,
  };
}
async function countActiveWorkflows(agencyId, excludeId) {
  const { data } = await supabase.from('workflows').select('id').eq('agency_id', agencyId).eq('status', 'active');
  return (data || []).filter((w) => w.id !== excludeId).length;
}
// Snapshot the current draft into a new version and point the workflow at it.
async function publishWorkflow(wf, publishedBy) {
  const { data: vers } = await supabase
    .from('workflow_versions').select('version')
    .eq('workflow_id', wf.id).order('version', { ascending: false }).limit(1);
  const nextV = (((vers && vers[0] && vers[0].version) || 0)) + 1;
  const { data: ver, error } = await supabase
    .from('workflow_versions')
    .insert({
      workflow_id: wf.id, agency_id: wf.agency_id, version: nextV,
      graph: wf.graph, trigger_type: wf.trigger_type, trigger_config: wf.trigger_config || {},
      stop_on: wf.stop_on || {}, entry_rules: wf.entry_rules || {}, published_by: publishedBy || null,
    })
    .select().single();
  if (error) throw new Error(error.message);
  await supabase.from('workflows').update({ live_version_id: ver.id, updated_at: new Date().toISOString() }).eq('id', wf.id);
  return ver;
}
function callerName(req) {
  return (req.user && (req.user.email || req.user.userId)) || 'agency';
}

// ---------------------------------------------------------------------------
// GET templates  (literal path registered before the :id routes)
// ---------------------------------------------------------------------------
router.get('/:agencyId/workflows/templates', async (req, res) => {
  try {
    const agency = await loadAgency(req.params.agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    const { data: existing } = await supabase
      .from('workflows').select('template_key, id, status').eq('agency_id', agency.id);
    const used = new Map();
    (existing || []).forEach((w) => { if (w.template_key) used.set(w.template_key, w); });
    const templates = listTemplates().map((t) => {
      const w = used.get(t.key);
      return { ...t, activated: !!w, workflow_id: w ? w.id : null, workflow_status: w ? w.status : null };
    });
    res.json({ templates, entitlements: entSummary(agency) });
  } catch (e) {
    console.error('workflows templates error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET list
// ---------------------------------------------------------------------------
router.get('/:agencyId/workflows', async (req, res) => {
  try {
    const { data: wfs } = await supabase
      .from('workflows').select('*')
      .eq('agency_id', req.params.agencyId).neq('status', 'archived')
      .order('created_at', { ascending: false });
    const agency = await loadAgency(req.params.agencyId);
    res.json({ workflows: wfs || [], entitlements: agency ? entSummary(agency) : null });
  } catch (e) {
    console.error('workflows list error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST create (from a template, or blank)
// ---------------------------------------------------------------------------
router.post('/:agencyId/workflows', async (req, res) => {
  try {
    const agencyId = req.params.agencyId;
    const agency = await loadAgency(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    const ent = entitlementsForAgency(agency);
    if (ent.maxWorkflows === 0) {
      return res.status(403).json({ error: 'Workflows are available on Pro and Scale.', code: 'upgrade_required' });
    }

    const body = req.body || {};
    let name = body.name;
    let description = body.description || null;
    let graph; let triggerType; let triggerConfig; let stopOn; let entryRules; let templateKey = null;

    if (body.template_key) {
      const t = getTemplate(body.template_key);
      if (!t) return res.status(400).json({ error: 'Unknown template' });
      // Don't duplicate an already-activated template.
      const { data: dup } = await supabase
        .from('workflows').select('id').eq('agency_id', agencyId).eq('template_key', t.key).limit(1);
      if (dup && dup.length) return res.status(409).json({ error: 'This template is already set up.', workflow_id: dup[0].id });
      graph = t.graph; triggerType = t.trigger_type; triggerConfig = t.trigger_config || {};
      stopOn = t.stop_on || {}; entryRules = t.entry_rules || {}; templateKey = t.key;
      name = name || t.name; description = description || t.description;
    } else {
      graph = body.graph || { nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] };
      triggerType = body.trigger_type || 'call.completed';
      triggerConfig = body.trigger_config || {};
      stopOn = body.stop_on || {}; entryRules = body.entry_rules || { reenroll: false };
      name = name || 'Untitled workflow';
    }

    const chk = graphWithinPlan(graph, getEffectivePlan(agency));
    if (!chk.ok) {
      return res.status(403).json({ error: 'Some steps require Scale.', code: 'upgrade_required', blocked_node_types: chk.blockedTypes });
    }

    const { data: wf, error } = await supabase
      .from('workflows')
      .insert({
        agency_id: agencyId, name, description, status: 'draft',
        trigger_type: triggerType, trigger_config: triggerConfig, graph,
        stop_on: stopOn, entry_rules: entryRules, template_key: templateKey, created_by: callerName(req),
      })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ workflow: wf });
  } catch (e) {
    console.error('workflows create error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET one
// ---------------------------------------------------------------------------
router.get('/:agencyId/workflows/:id', async (req, res) => {
  try {
    const wf = await loadWorkflow(req.params.id, req.params.agencyId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    let liveVersion = null;
    if (wf.live_version_id) {
      const { data } = await supabase.from('workflow_versions').select('*').eq('id', wf.live_version_id).single();
      liveVersion = data || null;
    }
    res.json({ workflow: wf, live_version: liveVersion });
  } catch (e) {
    console.error('workflows get error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH update (draft only)
// ---------------------------------------------------------------------------
router.patch('/:agencyId/workflows/:id', async (req, res) => {
  try {
    const wf = await loadWorkflow(req.params.id, req.params.agencyId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const agency = await loadAgency(req.params.agencyId);

    const body = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    for (const f of ['name', 'description', 'trigger_type', 'trigger_config', 'graph', 'stop_on', 'entry_rules']) {
      if (body[f] !== undefined) patch[f] = body[f];
    }
    if (patch.graph) {
      const chk = graphWithinPlan(patch.graph, getEffectivePlan(agency));
      if (!chk.ok) return res.status(403).json({ error: 'Some steps require Scale.', code: 'upgrade_required', blocked_node_types: chk.blockedTypes });
    }
    const { data: updated, error } = await supabase
      .from('workflows').update(patch).eq('id', wf.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ workflow: updated });
  } catch (e) {
    console.error('workflows update error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST publish (snapshot draft -> new live version)
// ---------------------------------------------------------------------------
router.post('/:agencyId/workflows/:id/publish', async (req, res) => {
  try {
    const wf = await loadWorkflow(req.params.id, req.params.agencyId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const agency = await loadAgency(req.params.agencyId);
    const chk = graphWithinPlan(wf.graph, getEffectivePlan(agency));
    if (!chk.ok) return res.status(403).json({ error: 'Some steps require Scale.', code: 'upgrade_required', blocked_node_types: chk.blockedTypes });
    const ver = await publishWorkflow(wf, callerName(req));
    res.json({ version: ver });
  } catch (e) {
    console.error('workflows publish error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST activate (publishes first if needed; enforces count cap + node tiers)
// ---------------------------------------------------------------------------
router.post('/:agencyId/workflows/:id/activate', async (req, res) => {
  try {
    const agencyId = req.params.agencyId;
    const wf = await loadWorkflow(req.params.id, agencyId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const agency = await loadAgency(agencyId);
    const ent = entitlementsForAgency(agency);
    if (ent.maxWorkflows === 0) return res.status(403).json({ error: 'Workflows are available on Pro and Scale.', code: 'upgrade_required' });

    const chk = graphWithinPlan(wf.graph, getEffectivePlan(agency));
    if (!chk.ok) return res.status(403).json({ error: 'Some steps require Scale.', code: 'upgrade_required', blocked_node_types: chk.blockedTypes });

    if (wf.status !== 'active') {
      const activeCount = await countActiveWorkflows(agencyId, wf.id);
      if (activeCount >= ent.maxWorkflows) {
        return res.status(403).json({ error: `Your plan allows ${ent.maxWorkflows} active workflows. Upgrade to Scale for unlimited.`, code: 'limit_reached', max_workflows: ent.maxWorkflows });
      }
    }

    // Must have a published version to run. Auto-publish the current draft.
    let liveVersionId = wf.live_version_id;
    if (!liveVersionId) {
      const ver = await publishWorkflow(wf, callerName(req));
      liveVersionId = ver.id;
    }
    const { data: updated, error } = await supabase
      .from('workflows').update({ status: 'active', live_version_id: liveVersionId, updated_at: new Date().toISOString() })
      .eq('id', wf.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ workflow: updated });
  } catch (e) {
    console.error('workflows activate error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST pause
// ---------------------------------------------------------------------------
router.post('/:agencyId/workflows/:id/pause', async (req, res) => {
  try {
    const wf = await loadWorkflow(req.params.id, req.params.agencyId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const { data: updated, error } = await supabase
      .from('workflows').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', wf.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ workflow: updated });
  } catch (e) {
    console.error('workflows pause error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE (soft archive; in-flight runs stop on their next tick)
// ---------------------------------------------------------------------------
router.delete('/:agencyId/workflows/:id', async (req, res) => {
  try {
    const wf = await loadWorkflow(req.params.id, req.params.agencyId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    await supabase.from('workflows').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', wf.id);
    res.json({ success: true });
  } catch (e) {
    console.error('workflows delete error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET runs (recent enrollments / activity)
// ---------------------------------------------------------------------------
router.get('/:agencyId/workflows/:id/runs', async (req, res) => {
  try {
    const wf = await loadWorkflow(req.params.id, req.params.agencyId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { data: runs } = await supabase
      .from('workflow_enrollments')
      .select('id, client_id, contact_phone, status, current_node_id, trigger_event, stopped_reason, enrolled_at, completed_at, next_run_at')
      .eq('workflow_id', wf.id)
      .order('enrolled_at', { ascending: false })
      .limit(limit);
    res.json({ runs: runs || [] });
  } catch (e) {
    console.error('workflows runs error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET stats
// ---------------------------------------------------------------------------
router.get('/:agencyId/workflows/:id/stats', async (req, res) => {
  try {
    const wf = await loadWorkflow(req.params.id, req.params.agencyId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });

    const countBy = async (status) => {
      let q = supabase.from('workflow_enrollments').select('id', { count: 'exact', head: true }).eq('workflow_id', wf.id);
      if (status) q = q.eq('status', status);
      const { count } = await q;
      return count || 0;
    };
    const [total, active, completed, stopped, failed] = await Promise.all([
      countBy(null), countBy('active'), countBy('completed'), countBy('stopped'), countBy('failed'),
    ]);

    // Messages actually sent (send-type steps that succeeded).
    const { count: messagesSent } = await supabase
      .from('workflow_run_steps').select('id', { count: 'exact', head: true })
      .eq('workflow_id', wf.id).in('node_type', ['send_sms', 'ai_sms', 'notify_owner']).eq('status', 'done');

    res.json({ stats: { total, active, completed, stopped, failed, messages_sent: messagesSent || 0 } });
  } catch (e) {
    console.error('workflows stats error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
