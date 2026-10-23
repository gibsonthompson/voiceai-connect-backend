// ============================================================================
// WORKFLOW TRIGGERS - turn an internal event into an enrollment
//
// onEvent(agencyId, eventType, data) is called once from dispatchWebhook (the
// single hook point that already fires for every call/appointment), so the
// engine listens to the same events the agency webhook API does, with no new
// instrumentation at the call sites.
//
// For each ACTIVE workflow whose trigger_type matches the event, this resolves
// the event into { client, contact, context }, checks the workflow's
// trigger_config and re-entry rules, and enrolls the contact.
//
// This is the receptionist-native edge: the context it passes carries the AI
// call outcome (followup_outcome), whether an appointment was booked, sentiment,
// and the transcript summary, so conditions can branch on what the call was
// ABOUT, not just that a call happened.
// ============================================================================

const { supabase } = require('./supabase');
const { enroll } = require('./workflow-engine');
const { samePhone } = require('./workflow-engine');

const HANDLED_EVENTS = ['call.completed', 'appointment.booked'];

function phoneKey(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

// ---------------------------------------------------------------------------
// Resolve the raw event into the pieces an enrollment needs.
// ---------------------------------------------------------------------------
async function resolveEvent(eventType, data) {
  if (!data) return null;

  if (eventType === 'call.completed') {
    const callId = data.id;
    if (!callId) return null;
    const { data: call } = await supabase.from('calls').select('*').eq('id', callId).single();
    if (!call) return null;
    const contactPhone = call.customer_phone || call.caller_phone || null;
    return {
      callId,
      clientId: call.client_id,
      contactId: call.contact_id || null,
      contactName: call.customer_name || null,
      contactPhone,
      context: {
        followup_outcome: call.followup_outcome || 'none',
        appointment_booked: !!call.appointment_booked,
        caller_spoke: call.caller_spoke !== false,
        is_spam: !!call.is_spam,
        sentiment: call.sentiment || null,
        urgency_level: call.urgency_level || null,
        service_requested: call.service_requested || null,
        customer_name: call.customer_name || null,
        caller_phone: call.caller_phone || null,
        appointment_time: call.appointment_time || null,
        summary: call.summary || null,
        ai_summary: call.ai_summary || null,
      },
    };
  }

  if (eventType === 'appointment.booked') {
    const clientId = data.client_id || data.clientId || null;
    const contactPhone = data.customer_phone || data.caller_phone || data.phone || null;
    const callId = data.call_id || null;
    return {
      callId,
      clientId,
      contactId: data.contact_id || null,
      contactName: data.customer_name || data.name || null,
      contactPhone,
      context: {
        appointment_booked: true,
        customer_name: data.customer_name || data.name || null,
        appointment_time: data.appointment_time || data.time || data.start || null,
        service_requested: data.service || data.service_requested || null,
        caller_phone: contactPhone,
      },
    };
  }

  return null;
}

// Find the contact this run is for, creating one if the caller is new.
async function resolveContact(agencyId, clientId, contactId, phone, name) {
  if (contactId) {
    const { data } = await supabase.from('client_contacts').select('*').eq('id', contactId).single();
    if (data) return data;
  }
  if (!clientId || !phone) return null;

  const { data: existing } = await supabase
    .from('client_contacts').select('*').eq('client_id', clientId).limit(100);
  const match = (existing || []).find((c) => samePhone(c.phone, phone));
  if (match) return match;

  const { data: created } = await supabase
    .from('client_contacts')
    .insert({ client_id: clientId, agency_id: agencyId, name: name || null, phone, source: 'workflow', status: 'new' })
    .select().single();
  return created || null;
}

// ---------------------------------------------------------------------------
// trigger_config matching
// ---------------------------------------------------------------------------
function passesConfig(cfg, context) {
  const c = cfg || {};
  if (Array.isArray(c.followup_outcome_in) && c.followup_outcome_in.length) {
    if (!c.followup_outcome_in.includes(context.followup_outcome)) return false;
  }
  if (c.require_caller_spoke && !context.caller_spoke) return false;
  if (c.exclude_spam && context.is_spam) return false;
  if (c.require_booked && !context.appointment_booked) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Re-entry policy
// ---------------------------------------------------------------------------
// Returns true when this contact may NOT be (re)enrolled right now.
async function blockedByReentry(wf, contactId) {
  const rules = wf.entry_rules || {};
  if (!contactId) return false;
  // reenroll:false -> one lifetime enrollment per contact per workflow.
  if (!rules.reenroll) {
    const { data } = await supabase
      .from('workflow_enrollments').select('id')
      .eq('workflow_id', wf.id).eq('contact_id', contactId)
      .neq('status', 'canceled').limit(1);
    return !!(data && data.length);
  }
  // reenroll:true with a cooldown -> block if a recent enrollment is inside it.
  const cooldownH = parseInt(rules.cooldown_hours, 10) || 0;
  if (cooldownH > 0) {
    const sinceIso = new Date(Date.now() - cooldownH * 3600000).toISOString();
    const { data } = await supabase
      .from('workflow_enrollments').select('id')
      .eq('workflow_id', wf.id).eq('contact_id', contactId)
      .gt('enrolled_at', sinceIso).limit(1);
    return !!(data && data.length);
  }
  return false;
}

// Load the graph a new run should pin to: the live published version, or the
// draft graph as a fallback (so an active-but-unpublished workflow still runs
// in testing).
async function resolveLiveGraph(wf) {
  if (wf.live_version_id) {
    const { data } = await supabase.from('workflow_versions').select('graph').eq('id', wf.live_version_id).single();
    if (data && data.graph) return { versionId: wf.live_version_id, graph: data.graph };
  }
  return { versionId: null, graph: wf.graph };
}

// ---------------------------------------------------------------------------
// Entry point, called from dispatchWebhook.
// ---------------------------------------------------------------------------
async function onEvent(agencyId, eventType, data) {
  try {
    if (!agencyId || !HANDLED_EVENTS.includes(eventType)) return;

    // Resolve the event first so we know which client (business) it belongs to.
    const resolved = await resolveEvent(eventType, data);
    if (!resolved || !resolved.clientId || !resolved.contactPhone) return;

    // Active workflows for this agency + trigger that are either agency-wide
    // (client_id null) OR scoped to THIS client.
    const { data: matched } = await supabase
      .from('workflows').select('*')
      .eq('agency_id', agencyId).eq('status', 'active').eq('trigger_type', eventType)
      .or(`client_id.is.null,client_id.eq.${resolved.clientId}`);
    if (!matched || matched.length === 0) return;

    // Override rule: if this business has its own workflow(s) for this trigger,
    // run only those; the agency-wide defaults are skipped for this business so
    // nobody gets double-texted.
    const clientScoped = matched.filter((w) => w.client_id === resolved.clientId);
    const workflows = clientScoped.length ? clientScoped : matched.filter((w) => !w.client_id);
    if (workflows.length === 0) return;

    const contact = await resolveContact(
      agencyId, resolved.clientId, resolved.contactId, resolved.contactPhone, resolved.contactName,
    );
    if (!contact) return;

    for (const wf of workflows) {
      try {
        if (!passesConfig(wf.trigger_config, resolved.context)) continue;
        if (await blockedByReentry(wf, contact.id)) continue;

        const { versionId, graph } = await resolveLiveGraph(wf);
        if (!graph || !(graph.nodes || []).length) continue;

        const idemBasis = resolved.callId || resolved.context.appointment_time || '';
        const idempotencyKey = `${wf.id}:${eventType}:${idemBasis}:${phoneKey(resolved.contactPhone)}`;

        await enroll({
          workflowId: wf.id,
          versionId,
          agencyId,
          clientId: resolved.clientId,
          contactId: contact.id,
          contactPhone: resolved.contactPhone,
          triggerEvent: eventType,
          triggerCallId: resolved.callId || null,
          context: resolved.context,
          idempotencyKey,
          graph,
        });
      } catch (e) {
        console.error('workflow enroll error:', (e && e.message) || e);
      }
    }
  } catch (e) {
    console.error('workflow onEvent error:', (e && e.message) || e);
  }
}

module.exports = { onEvent, resolveEvent, passesConfig };
