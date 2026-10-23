// ============================================================================
// WORKFLOW ENGINE - enrollment + execution state machine
//
// A run (workflow_enrollment) is one contact walking one published graph. The
// engine does two things:
//   enroll()            - start a contact on a workflow (idempotent)
//   advanceEnrollment() - execute nodes until it hits a wait, a stop, or the end
// and the cron calls processDueEnrollments() to advance runs whose timer is up.
//
// What it leans on (already in the codebase, not re-implemented here):
//   - sendClientSms()  for the actual text (opt-out, transport, threading, log)
//   - clients.timezone + the activation-sms quiet-hours idea for night-safe sends
//   - calls / sms_messages for goal checks (booked / replied)
//
// Guardrails: per-tick and per-run step caps (loop protection), a claim lock so
// parallel cron ticks never double-advance one run, stop-on-goal checks before
// every send, and quiet hours on drip sends.
// ============================================================================

const { supabase } = require('./supabase');
const {
  buildTokenMap, renderTemplate, isKnownNodeType,
} = require('./workflow-nodes');

// Per advance() tick, execute at most this many nodes, then yield (reschedule
// ~1 min out). Stops a pathological graph from spinning a worker. Normal graphs
// break on the first wait anyway.
const MAX_STEPS_PER_TICK = parseInt(process.env.WORKFLOW_MAX_STEPS_TICK || '25', 10);
// Total nodes a single run may ever execute. Hard stop against loops.
const MAX_STEPS_PER_RUN = parseInt(process.env.WORKFLOW_MAX_STEPS_RUN || '200', 10);

// Quiet hours for drip sends (daytime window in the contact's/business's tz).
const HOUR_START = parseInt(process.env.WORKFLOW_SMS_HOUR_START || '9', 10);
const HOUR_END = parseInt(process.env.WORKFLOW_SMS_HOUR_END || '20', 10);

const SEND_NODE_TYPES = ['send_sms', 'ai_sms', 'notify_owner'];

// ---------------------------------------------------------------------------
// Time / quiet hours
// ---------------------------------------------------------------------------
function localHm(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    let h = parseInt((parts.find((p) => p.type === 'hour') || {}).value, 10);
    const m = parseInt((parts.find((p) => p.type === 'minute') || {}).value, 10);
    if (h === 24) h = 0;
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return { h, m };
  } catch (_) { return null; }
}

// Returns null when it is fine to send now, else an ISO timestamp for the next
// time the daytime window opens (so the send holds to daytime instead of going
// out at 2am). Unknown tz: never hold.
function quietHoldUntil(tz) {
  const hm = localHm(tz);
  if (!hm) return null;
  const { h, m } = hm;
  if (h >= HOUR_START && h < HOUR_END) return null;
  let mins;
  if (h < HOUR_START) mins = (HOUR_START - h) * 60 - m;
  else mins = (24 - h + HOUR_START) * 60 - m; // h >= HOUR_END
  if (mins < 1) mins = 1;
  return new Date(Date.now() + mins * 60000).toISOString();
}

// ---------------------------------------------------------------------------
// Phone matching (goal checks compare against stored message/call phones)
// ---------------------------------------------------------------------------
function phoneKey(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
function samePhone(a, b) {
  const ka = phoneKey(a); const kb = phoneKey(b);
  return ka.length >= 7 && ka === kb;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------
function nodeById(graph, id) {
  return (graph.nodes || []).find((n) => n.id === id) || null;
}
function entryTarget(graph) {
  const trig = (graph.nodes || []).find((n) => n.type === 'trigger');
  const from = trig ? trig.id : 'trigger';
  const e = (graph.edges || []).find((x) => x.source === from);
  return e ? e.target : null;
}
function linearNext(graph, nodeId) {
  const e = (graph.edges || []).find((x) => x.source === nodeId && (x.branch == null));
  return e ? e.target : null;
}
function branchNext(graph, nodeId, branch) {
  const edges = (graph.edges || []).filter((x) => x.source === nodeId);
  const hit = edges.find((x) => String(x.branch) === String(branch));
  if (hit) return hit.target;
  const def = edges.find((x) => x.branch === 'else' || x.branch === 'default' || x.branch == null);
  return def ? def.target : null;
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------
function getFieldValue(field, ctx, contact) {
  switch (field) {
    case 'followup_outcome': return ctx.followup_outcome;
    case 'appointment_booked': return ctx.appointment_booked;
    case 'sentiment': return ctx.sentiment;
    case 'urgency_level': return ctx.urgency_level;
    case 'service': return ctx.service_requested || ctx.service;
    case 'status': return contact ? contact.status : undefined;
    case 'tags': return contact ? (contact.tags || []) : [];
    default: return ctx[field];
  }
}
function evalCondition(data, ctx, contact) {
  const val = getFieldValue(data.field, ctx, contact);
  const target = data.value;
  switch (data.op) {
    case 'eq': return val === target || String(val) === String(target);
    case 'ne': return !(val === target || String(val) === String(target));
    case 'exists': return val !== undefined && val !== null && val !== '';
    case 'not_exists': return val === undefined || val === null || val === '';
    case 'in': return Array.isArray(target) && target.map(String).includes(String(val));
    case 'contains':
      if (Array.isArray(val)) return val.map(String).includes(String(target));
      return String(val || '').toLowerCase().includes(String(target || '').toLowerCase());
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Goal checks (stop the run early when the point is already made)
// ---------------------------------------------------------------------------
async function checkGoals(stopOn, enr) {
  if (!stopOn || (!stopOn.booked && !stopOn.reply)) return null;
  const sinceIso = enr.enrolled_at;

  if (stopOn.booked) {
    const { data: calls } = await supabase
      .from('calls')
      .select('id, caller_phone, customer_phone, appointment_booked, created_at')
      .eq('client_id', enr.client_id)
      .eq('appointment_booked', true)
      .gt('created_at', sinceIso)
      .limit(25);
    if ((calls || []).some((c) => samePhone(c.customer_phone, enr.contact_phone) || samePhone(c.caller_phone, enr.contact_phone))) {
      return 'goal_booked';
    }
  }

  if (stopOn.reply) {
    const { data: msgs } = await supabase
      .from('sms_messages')
      .select('id, direction, sender_phone, created_at')
      .eq('client_id', enr.client_id)
      .eq('direction', 'inbound')
      .gt('created_at', sinceIso)
      .limit(50);
    if ((msgs || []).some((mm) => samePhone(mm.sender_phone, enr.contact_phone))) {
      return 'goal_reply';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function doSendSms(enr, message) {
  const to = enr.contact_phone;
  if (!to || !message) return { sent: false, reason: 'missing_to_or_message' };
  let sendClientSms;
  try { ({ sendClientSms } = require('../routes/sms')); } catch (e) { return { sent: false, reason: 'send_unavailable' }; }
  try {
    const r = await sendClientSms({ clientId: enr.client_id, to, message, sentBy: { name: 'Workflow' } });
    if (r && r.error) return { sent: false, reason: r.details || r.error };
    return { sent: true, messageId: (r && r.providerMessageId) || (r && r.savedMessage && r.savedMessage.id) || null };
  } catch (e) {
    return { sent: false, reason: (e && e.message) || 'send_error' };
  }
}

// AI SMS: generate a short, grounded follow-up from the business KB + the call
// context, then send it. Falls back to node.data.fallback (or the raw message)
// when generation is unavailable, so the node is never a dead end.
async function generateAiSms(node, client, ctx, tokenMap) {
  const fallback = renderTemplate(node.data.fallback || node.data.message || '', tokenMap);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback;
  const kb = (client && (client.knowledge_base_content
    || (client.knowledge_base_data && JSON.stringify(client.knowledge_base_data)))) || '';
  const instruction = node.data.instruction || 'Write a brief, friendly follow-up text to the customer after their call.';
  const sys = `You write short SMS follow-ups for ${client ? client.business_name : 'a local business'}. `
    + 'One or two sentences, under 320 characters, warm and plain, no links, no emojis, no em-dashes. '
    + 'Use only facts from the business info provided; never invent prices, hours, or promises.';
  const user = `Business info:\n${String(kb).slice(0, 2500)}\n\n`
    + `Call context: customer=${ctx.customer_name || 'unknown'}, service=${ctx.service_requested || ctx.service || 'n/a'}, `
    + `outcome=${ctx.followup_outcome || 'n/a'}, summary=${String(ctx.summary || ctx.ai_summary || '').slice(0, 400)}\n\n`
    + `Task: ${instruction}`;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.WORKFLOW_AI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.6, max_tokens: 160,
      }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const out = String(text || '').trim();
    return out.length >= 2 ? out.slice(0, 480) : fallback;
  } catch (e) { return fallback; }
}

async function doTag(enr, contact, tag, add) {
  if (!contact || !tag) return { ok: false };
  const current = Array.isArray(contact.tags) ? contact.tags.slice() : [];
  let next;
  if (add) { next = current.includes(tag) ? current : current.concat([tag]); }
  else { next = current.filter((t) => t !== tag); }
  await supabase.from('client_contacts').update({ tags: next, updated_at: new Date().toISOString() }).eq('id', contact.id);
  contact.tags = next;
  return { ok: true, tags: next };
}

async function doWebhook(node, enr, ctx) {
  const url = node.data && node.data.url;
  if (!url || !/^https:\/\//i.test(url)) return { ok: false, reason: 'bad_url' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'VoiceAIConnect-Workflows/1' },
      body: JSON.stringify({ enrollment_id: enr.id, workflow_id: enr.workflow_id, contact_phone: enr.contact_phone, context: ctx }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) { return { ok: false, reason: (e && e.message) || 'webhook_error' }; }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
async function logStep(enr, node, status, detail) {
  try {
    await supabase.from('workflow_run_steps').insert({
      enrollment_id: enr.id, workflow_id: enr.workflow_id,
      node_id: node ? node.id : null, node_type: node ? node.type : null,
      status, detail: detail || null,
    });
  } catch (e) { /* logging must never break a run */ }
}
async function persistProgress(enr, patch) {
  const body = { updated_at: new Date().toISOString(), ...patch };
  await supabase.from('workflow_enrollments').update(body).eq('id', enr.id);
  Object.assign(enr, body);
}

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------
// Insert a run and advance it immediately (so a missed-call text-back is near
// instant). idempotencyKey makes a given trigger enroll a contact at most once.
async function enroll(params) {
  const {
    workflowId, versionId, agencyId, clientId, contactId, contactPhone,
    triggerEvent, triggerCallId, context, idempotencyKey, graph,
  } = params;

  const start = entryTarget(graph);
  if (!start) return { skipped: 'empty_graph' };

  const row = {
    workflow_id: workflowId, version_id: versionId || null, agency_id: agencyId,
    client_id: clientId || null, contact_id: contactId || null, contact_phone: contactPhone || null,
    status: 'active', current_node_id: start, trigger_event: triggerEvent || null,
    trigger_call_id: triggerCallId || null, context: context || {},
    idempotency_key: idempotencyKey || null, next_run_at: new Date().toISOString(),
  };

  const { data: enr, error } = await supabase
    .from('workflow_enrollments').insert(row).select().single();
  if (error) {
    if (error.code === '23505') return { skipped: 'duplicate' }; // unique idempotency_key
    return { error: error.message };
  }
  await advanceEnrollment(enr);
  return { enrollment_id: enr.id };
}

// ---------------------------------------------------------------------------
// advanceEnrollment
// ---------------------------------------------------------------------------
async function advanceEnrollment(enrOrId) {
  let enr = enrOrId;
  if (typeof enrOrId === 'string') {
    const { data } = await supabase.from('workflow_enrollments').select('*').eq('id', enrOrId).single();
    enr = data;
  }
  if (!enr || enr.status !== 'active') return;

  // Workflow must still be active (kill switch / pause).
  const { data: wf } = await supabase.from('workflows').select('*').eq('id', enr.workflow_id).single();
  if (!wf || wf.status !== 'active') {
    await persistProgress(enr, { status: 'stopped', stopped_reason: 'workflow_inactive', next_run_at: null, claimed_at: null, completed_at: new Date().toISOString() });
    return;
  }

  // Pinned version graph + stop_on (editing the draft never touches this run).
  // Fall back to the workflow's own fields when a run predates versioning.
  let graph = wf.graph;
  let stopOn = wf.stop_on || {};
  if (enr.version_id) {
    const { data: ver } = await supabase.from('workflow_versions').select('graph, stop_on').eq('id', enr.version_id).single();
    if (ver && ver.graph) graph = ver.graph;
    if (ver && ver.stop_on) stopOn = ver.stop_on;
  }

  // Load client + contact once for tokens, tz, tags.
  let client = null; let contact = null;
  if (enr.client_id) {
    const { data } = await supabase.from('clients')
      .select('id, business_name, owner_name, business_city, timezone, knowledge_base_content, knowledge_base_data')
      .eq('id', enr.client_id).single();
    client = data || null;
  }
  if (enr.contact_id) {
    const { data } = await supabase.from('client_contacts').select('id, name, phone, tags, status').eq('id', enr.contact_id).single();
    contact = data || null;
  }
  const tz = (client && client.timezone) || 'America/New_York';
  const ctx = enr.context || {};
  const tokenMap = buildTokenMap({ context: ctx, contact: contact || {}, client: client || {} });

  let localSteps = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (enr.steps_run >= MAX_STEPS_PER_RUN) {
      await logStep(enr, null, 'stopped', { reason: 'max_steps_per_run' });
      await persistProgress(enr, { status: 'stopped', stopped_reason: 'max_steps', next_run_at: null, claimed_at: null, completed_at: new Date().toISOString() });
      return;
    }
    if (localSteps >= MAX_STEPS_PER_TICK) {
      // Yield; pick this same node up on the next cron tick.
      await persistProgress(enr, { next_run_at: new Date(Date.now() + 60000).toISOString(), claimed_at: null });
      return;
    }

    const node = nodeById(graph, enr.current_node_id);
    if (!node) { // dangling pointer or end of a branch with no target
      await persistProgress(enr, { status: 'completed', next_run_at: null, claimed_at: null, completed_at: new Date().toISOString() });
      return;
    }

    // Before any send: honor goals and quiet hours.
    if (SEND_NODE_TYPES.includes(node.type)) {
      const goal = await checkGoals(stopOn, enr);
      if (goal) {
        await logStep(enr, node, 'stopped', { reason: goal });
        await persistProgress(enr, { status: 'stopped', stopped_reason: goal, next_run_at: null, claimed_at: null, completed_at: new Date().toISOString() });
        return;
      }
      const respectQuiet = !(node.data && node.data.respect_quiet_hours === false);
      if (respectQuiet) {
        const hold = quietHoldUntil(tz);
        if (hold) { // hold the SEND (do not advance past this node) until daytime
          await persistProgress(enr, { next_run_at: hold, claimed_at: null });
          return;
        }
      }
    }

    // Execute the node.
    let nextId; let terminal = false;
    try {
      const outcome = await executeNode(node, { enr, client, contact, ctx, tokenMap, graph });
      if (outcome.wait) {
        await logStep(enr, node, 'scheduled', { until: outcome.runAt });
        await persistProgress(enr, { current_node_id: outcome.nextNodeId, next_run_at: outcome.runAt, claimed_at: null, steps_run: enr.steps_run + 1 });
        return;
      }
      await logStep(enr, node, outcome.failed ? 'failed' : 'done', outcome.detail || null);
      if (outcome.terminal) terminal = true;
      nextId = outcome.nextNodeId;
    } catch (e) {
      await logStep(enr, node, 'failed', { error: (e && e.message) || 'node_error' });
      nextId = linearNext(graph, node.id); // never trap a run on one bad node
    }

    enr.steps_run += 1; localSteps += 1;

    if (terminal) {
      await persistProgress(enr, { status: 'completed', next_run_at: null, claimed_at: null, completed_at: new Date().toISOString(), steps_run: enr.steps_run });
      return;
    }
    const next = (nextId !== undefined) ? nextId : linearNext(graph, node.id);
    if (!next) {
      await persistProgress(enr, { status: 'completed', next_run_at: null, claimed_at: null, completed_at: new Date().toISOString(), steps_run: enr.steps_run });
      return;
    }
    // Persist the advance before looping (so a crash resumes here, not earlier).
    await persistProgress(enr, { current_node_id: next, steps_run: enr.steps_run });
    enr.current_node_id = next;
  }
}

// Returns one of:
//   { wait:true, runAt, nextNodeId }   schedule and pause
//   { terminal:true }                  end the run
//   { nextNodeId }                     continue to this node (undefined -> linear)
//   { failed:true, nextNodeId, detail} action failed but run continues
async function executeNode(node, env) {
  const { enr, client, contact, ctx, tokenMap, graph } = env;
  const type = node.type;
  const data = node.data || {};

  if (!isKnownNodeType(type) || type === 'trigger') {
    return { nextNodeId: linearNext(graph, node.id) };
  }

  switch (type) {
    case 'wait': {
      const minutes = Math.max(1, parseInt(data.minutes, 10) || 0);
      return { wait: true, runAt: new Date(Date.now() + minutes * 60000).toISOString(), nextNodeId: linearNext(graph, node.id) };
    }
    case 'send_sms': {
      const message = renderTemplate(data.message || '', tokenMap);
      const r = await doSendSms(enr, message);
      return { nextNodeId: linearNext(graph, node.id), failed: !r.sent, detail: { sent: r.sent, reason: r.reason, message_id: r.messageId } };
    }
    case 'ai_sms': {
      const message = await generateAiSms(node, client, ctx, tokenMap);
      const r = await doSendSms(enr, message);
      return { nextNodeId: linearNext(graph, node.id), failed: !r.sent, detail: { sent: r.sent, reason: r.reason, generated: message.slice(0, 160) } };
    }
    case 'notify_owner': {
      // Text the business owner (not the customer). Best effort.
      const message = renderTemplate(data.message || 'A workflow was triggered.', tokenMap);
      const ownerPhone = (contact && null) || (client && client.owner_phone) || null;
      let detail = { sent: false, reason: 'no_owner_path' };
      if (ownerPhone) {
        try {
          const { sendClientSms } = require('../routes/sms');
          const r = await sendClientSms({ clientId: enr.client_id, to: ownerPhone, message, sentBy: { name: 'Workflow' } });
          detail = r && r.error ? { sent: false, reason: r.details || r.error } : { sent: true };
        } catch (e) { detail = { sent: false, reason: (e && e.message) || 'notify_error' }; }
      }
      return { nextNodeId: linearNext(graph, node.id), failed: !detail.sent, detail };
    }
    case 'add_tag': {
      const r = await doTag(enr, contact, data.tag, true);
      return { nextNodeId: linearNext(graph, node.id), failed: !r.ok, detail: r };
    }
    case 'remove_tag': {
      const r = await doTag(enr, contact, data.tag, false);
      return { nextNodeId: linearNext(graph, node.id), failed: !r.ok, detail: r };
    }
    case 'set_status': {
      if (contact && data.status) {
        await supabase.from('client_contacts').update({ status: data.status, updated_at: new Date().toISOString() }).eq('id', contact.id);
        contact.status = data.status;
      }
      return { nextNodeId: linearNext(graph, node.id), detail: { status: data.status } };
    }
    case 'webhook': {
      const r = await doWebhook(node, enr, ctx);
      return { nextNodeId: linearNext(graph, node.id), failed: !r.ok, detail: r };
    }
    case 'condition':
    case 'branch_outcome': {
      const pass = evalCondition(data, ctx, contact);
      return { nextNodeId: branchNext(graph, node.id, pass ? 'true' : 'false'), detail: { field: data.field, op: data.op, value: data.value, result: pass } };
    }
    case 'goal':
    case 'end':
      return { terminal: true };
    default:
      return { nextNodeId: linearNext(graph, node.id) };
  }
}

// ---------------------------------------------------------------------------
// Scheduler: advance every run whose timer is due. Claim pattern mirrors the
// webhook retry cron (claim lock + stale reclaim) so parallel ticks are safe.
// ---------------------------------------------------------------------------
const STALE_CLAIM_MIN = parseInt(process.env.WORKFLOW_STALE_CLAIM_MIN || '10', 10);

async function processDueEnrollments(batchSize = 100) {
  const nowIso = new Date().toISOString();

  // Reclaim runs stuck 'claimed' past the stale window (a crash mid-advance).
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_MIN * 60000).toISOString();
  await supabase.from('workflow_enrollments')
    .update({ claimed_at: null })
    .eq('status', 'active').lt('claimed_at', staleCutoff);

  const { data: due } = await supabase
    .from('workflow_enrollments')
    .select('id')
    .eq('status', 'active')
    .is('claimed_at', null)
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true })
    .limit(batchSize);
  if (!due || due.length === 0) return { processed: 0 };

  const ids = due.map((d) => d.id);
  const { data: claimed } = await supabase
    .from('workflow_enrollments')
    .update({ claimed_at: nowIso })
    .in('id', ids).is('claimed_at', null)
    .select('*');
  if (!claimed || claimed.length === 0) return { processed: 0 };

  let processed = 0;
  for (const enr of claimed) {
    try { await advanceEnrollment(enr); } catch (e) { /* one bad run never stops the batch */ }
    processed += 1;
  }
  return { processed };
}

module.exports = {
  enroll,
  advanceEnrollment,
  processDueEnrollments,
  // exported for tests / reuse
  quietHoldUntil,
  evalCondition,
  samePhone,
  entryTarget,
};
