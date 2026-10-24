// ============================================================================
// WORKFLOWS API - agency-facing CRUD, publish/activate, runs, stats
//
// Scope: a workflow is agency-level (client_id null -> every client) or
// client-level (client_id set -> one business). The agency manages both from
// the agency dashboard; the scope is chosen at create time and carried on the
// row. Plan gating is enforced here. Gating of the client-level scope itself is
// deliberately open for now and centralized in ONE place (see CLIENT_SCOPE_GATE)
// so it is a one-line change when the plan decision is made.
//
// Versioning unchanged: editing changes the draft graph; publishing snapshots a
// version; in-flight runs pin the version they enrolled on.
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
// CLIENT_SCOPE_GATE: who may create per-business (client-level) automations.
// Open for now (any plan with workflow access). When the plan decision lands,
// change this one function (e.g. return getEffectivePlan(agency) === 'scale').
// ---------------------------------------------------------------------------
function clientScopeAllowed(agency) {
  const ent = entitlementsForAgency(agency);
  return ent.maxWorkflows > 0; // same access as agency-level, for now
}

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
async function clientBelongsToAgency(clientId, agencyId) {
  if (!clientId) return false;
  const { data } = await supabase.from('clients').select('id, agency_id, business_name').eq('id', clientId).single();
  return data && data.agency_id === agencyId ? data : false;
}
function entSummary(agency) {
  const ent = entitlementsForAgency(agency);
  return {
    plan: getEffectivePlan(agency),
    max_workflows: ent.maxWorkflows === Infinity ? null : ent.maxWorkflows,
    allowed_tiers: ent.allowedTiers,
    has_access: ent.maxWorkflows > 0,
    client_scope_allowed: clientScopeAllowed(agency),
  };
}
// The count cap applies to agency-LEVEL workflows only (client_id null). Client-
// level ones are not capped for now (see CLIENT_SCOPE_GATE note).
async function countActiveAgencyWorkflows(agencyId, excludeId) {
  const { data } = await supabase
    .from('workflows').select('id').eq('agency_id', agencyId).eq('status', 'active').is('client_id', null);
  return (data || []).filter((w) => w.id !== excludeId).length;
}
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
// Parse the scope the request is asking about: a specific client, or agency-wide.
function scopeFromQuery(req) {
  const cid = req.query.client_id;
  if (cid) return { clientId: String(cid) };
  return { clientId: null };
}

// ---------------------------------------------------------------------------
// GET templates  (literal path before the :id routes). Scope-aware: ?client_id=
// reflects which templates are already set up for THAT business.
// ---------------------------------------------------------------------------
router.get('/:agencyId/workflows/templates', async (req, res) => {
  try {
    const agency = await loadAgency(req.params.agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    const { clientId } = scopeFromQuery(req);

    let q = supabase.from('workflows').select('template_key, id, status, client_id').eq('agency_id', agency.id);
    q = clientId ? q.eq('client_id', clientId) : q.is('client_id', null);
    const { data: existing } = await q;

    const used = new Map();
    (existing || []).forEach((w) => { if (w.template_key) used.set(w.template_key, w); });
    const templates = listTemplates().map((t) => {
      const w = used.get(t.key);
      return { ...t, activated: !!w, workflow_id: w ? w.id : null, workflow_status: w ? w.status : null };
    });
    res.json({ templates, entitlements: entSummary(agency), scope: { client_id: clientId } });
  } catch (e) {
    console.error('workflows templates error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET list. ?client_id=<id> for one business, ?scope=agency for agency-wide,
// default returns all of the agency's workflows.
// ---------------------------------------------------------------------------
router.get('/:agencyId/workflows', async (req, res) => {
  try {
    const agencyId = req.params.agencyId;
    let q = supabase.from('workflows').select('*').eq('agency_id', agencyId).neq('status', 'archived');
    if (req.query.client_id) q = q.eq('client_id', String(req.query.client_id));
    else if (req.query.scope === 'agency') q = q.is('client_id', null);
    q = q.order('created_at', { ascending: false });
    const { data: wfs } = await q;
    const agency = await loadAgency(agencyId);
    res.json({ workflows: wfs || [], entitlements: agency ? entSummary(agency) : null });
  } catch (e) {
    console.error('workflows list error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST create (from a template or blank; agency-level or scoped to a client)
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

    // Scope: optional client_id. Validate it belongs to this agency.
    let clientId = null;
    if (body.client_id) {
      if (!clientScopeAllowed(agency)) {
        return res.status(403).json({ error: 'Per-business automations are not available on your plan.', code: 'upgrade_required' });
      }
      const client = await clientBelongsToAgency(body.client_id, agencyId);
      if (!client) return res.status(400).json({ error: 'That business is not under your agency.' });
      clientId = client.id;
    }

    let name = body.name;
    let description = body.description || null;
    let graph; let triggerType; let triggerConfig; let stopOn; let entryRules; let templateKey = null;

    if (body.template_key) {
      const t = getTemplate(body.template_key);
      if (!t) return res.status(400).json({ error: 'Unknown template' });
      // Don't duplicate an already-set-up template WITHIN THE SAME SCOPE.
      let dupQ = supabase.from('workflows').select('id').eq('agency_id', agencyId).eq('template_key', t.key);
      dupQ = clientId ? dupQ.eq('client_id', clientId) : dupQ.is('client_id', null);
      const { data: dup } = await dupQ.limit(1);
      if (dup && dup.length) return res.status(409).json({ error: 'This automation is already set up here.', workflow_id: dup[0].id });
      graph = t.graph; triggerType = t.trigger_type; triggerConfig = t.trigger_config || {};
      stopOn = t.stop_on || {}; entryRules = t.entry_rules || {}; templateKey = t.key;
      name = name || t.name; description = description || t.description;
    } else {
      graph = body.graph || {
        nodes: [{ id: 'trigger', type: 'trigger', data: {} }, { id: 'end_0', type: 'end', data: {} }],
        edges: [{ source: 'trigger', target: 'end_0' }],
      };
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
        agency_id: agencyId, client_id: clientId, name, description, status: 'draft',
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
// GET one (includes the business name when client-scoped)
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
    let clientName = null;
    if (wf.client_id) {
      const { data } = await supabase.from('clients').select('business_name').eq('id', wf.client_id).single();
      clientName = data ? data.business_name : null;
    }
    res.json({ workflow: { ...wf, client_name: clientName }, live_version: liveVersion });
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
// POST publish
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
// POST activate (publishes first if needed; count cap applies to agency-level)
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

    // Cap only agency-level (client_id null) active workflows for now.
    if (wf.status !== 'active' && !wf.client_id) {
      const activeCount = await countActiveAgencyWorkflows(agencyId, wf.id);
      if (activeCount >= ent.maxWorkflows) {
        return res.status(403).json({ error: `Your plan allows ${ent.maxWorkflows} agency-wide automations. Upgrade to Scale for unlimited.`, code: 'limit_reached', max_workflows: ent.maxWorkflows });
      }
    }

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
// DELETE (soft archive)
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
// GET runs
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
    const stats = await workflowStats(wf.id);
    res.json({ stats });
  } catch (e) {
    console.error('workflows stats error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Shared stats helper (reused by the client-facing router).
async function workflowStats(workflowId) {
  const countBy = async (status) => {
    let q = supabase.from('workflow_enrollments').select('id', { count: 'exact', head: true }).eq('workflow_id', workflowId);
    if (status) q = q.eq('status', status);
    const { count } = await q;
    return count || 0;
  };
  const [total, active, completed, stopped, failed] = await Promise.all([
    countBy(null), countBy('active'), countBy('completed'), countBy('stopped'), countBy('failed'),
  ]);
  const { count: messagesSent } = await supabase
    .from('workflow_run_steps').select('id', { count: 'exact', head: true })
    .eq('workflow_id', workflowId).in('node_type', ['send_sms', 'ai_sms', 'notify_owner']).eq('status', 'done');
  return { total, active, completed, stopped, failed, messages_sent: messagesSent || 0 };
}

module.exports = router;
module.exports.workflowStats = workflowStats;
