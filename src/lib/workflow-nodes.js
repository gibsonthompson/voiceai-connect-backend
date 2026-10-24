// ============================================================================
// WORKFLOW NODES - catalog, token rendering, and plan entitlements
//
// One place that defines:
//   - every node type the engine understands, and its plan TIER
//     ('basic' = available on Pro and up, 'advanced' = Scale only),
//   - the merge tokens a message/condition may reference (whitelist),
//   - the per-plan entitlement map (how many workflows a plan may run, and
//     which node tiers it may use).
//
// Gating decision (locked): Pro gets a capped number of active workflows and
// basic node types only; Scale gets unlimited workflows and every node type.
//
// PLAN NAMES (confirmed against the live data): the agency tier resolved by
// getEffectivePlan() is one of 'free' | 'pro' | 'scale' (trials and a comped
// access_plan already resolve to 'scale' there). So 'scale' -> full, 'pro' ->
// capped + basic, everything else -> no access. entitlementsForAgency(agency)
// runs an agency through getEffectivePlan and returns its entitlement.
// ============================================================================

const { getEffectivePlan } = require('./plan-access');

// Every node type, with the plan tier that may use it.
const NODE_TYPES = {
  // Entry. Every workflow graph starts here; its single outgoing edge points
  // at the first real node.
  trigger:      { tier: 'basic',    label: 'Trigger',            terminal: false },

  // Actions
  send_sms:     { tier: 'basic',    label: 'Send SMS',           terminal: false },
  ai_sms:       { tier: 'advanced', label: 'AI SMS',             terminal: false }, // grounded in client KB + call context
  notify_owner: { tier: 'basic',    label: 'Notify business',    terminal: false },
  add_tag:      { tier: 'basic',    label: 'Add tag',            terminal: false },
  remove_tag:   { tier: 'basic',    label: 'Remove tag',         terminal: false },
  set_status:   { tier: 'basic',    label: 'Set contact status', terminal: false },
  webhook:      { tier: 'advanced', label: 'Webhook',            terminal: false },

  // Flow control
  wait:         { tier: 'basic',    label: 'Wait',               terminal: false },
  reminder:     { tier: 'basic',    label: 'Appointment reminder', terminal: false }, // wait until relative to the appointment time
  condition:    { tier: 'basic',    label: 'If / Else',          terminal: false },
  branch_outcome:{ tier: 'advanced',label: 'Branch on outcome',  terminal: false },

  // Terminal
  goal:         { tier: 'basic',    label: 'Goal reached',       terminal: true },
  end:          { tier: 'basic',    label: 'End',                terminal: true },
};

function isKnownNodeType(type) {
  return Object.prototype.hasOwnProperty.call(NODE_TYPES, type);
}

function nodeTier(type) {
  const n = NODE_TYPES[type];
  return n ? n.tier : 'advanced'; // unknown types treated as gated, never free
}

// ---------------------------------------------------------------------------
// Plan entitlements
// ---------------------------------------------------------------------------
// maxWorkflows: how many ACTIVE workflows the agency may run at once.
// allowedTiers: which node tiers the agency may build with.
// Tunable without a deploy via env (WORKFLOW_MAX_PRO).
const PRO_MAX_WORKFLOWS = parseInt(process.env.WORKFLOW_MAX_PRO || '5', 10);

const ENTITLEMENTS = {
  pro:   { maxWorkflows: PRO_MAX_WORKFLOWS, allowedTiers: ['basic'] },
  scale: { maxWorkflows: Infinity,          allowedTiers: ['basic', 'advanced'] },
  none:  { maxWorkflows: 0,                 allowedTiers: [] },
};

// Map the effective agency plan (from getEffectivePlan) onto the workflow tier.
// The live agency tiers are exactly free / pro / scale; anything unrecognized
// falls to 'none' (no access) rather than silently granting a tier.
function mapPlanToTier(plan) {
  const p = String(plan || '').toLowerCase();
  if (p === 'scale') return 'scale'; // unlimited + advanced nodes
  if (p === 'pro') return 'pro';     // capped count + basic nodes only
  return 'none';                     // free / anything else: no workflow access
}

function getEntitlements(plan) {
  return ENTITLEMENTS[mapPlanToTier(plan)] || ENTITLEMENTS.none;
}

// Resolve an agency row straight to its entitlement, honoring trials and a
// comped access_plan (both surface through getEffectivePlan as 'scale').
function entitlementsForAgency(agency) {
  return getEntitlements(getEffectivePlan(agency));
}

// Does this plan permit every node type used in the graph? Returns
// { ok, blockedTypes } so the caller can tell the agency exactly what to
// upgrade for.
function graphWithinPlan(graph, plan) {
  const ent = getEntitlements(plan);
  const nodes = (graph && graph.nodes) || [];
  const blocked = [];
  for (const n of nodes) {
    if (!ent.allowedTiers.includes(nodeTier(n.type))) blocked.push(n.type);
  }
  return { ok: blocked.length === 0, blockedTypes: [...new Set(blocked)] };
}

// ---------------------------------------------------------------------------
// Token rendering
// ---------------------------------------------------------------------------
// Messages and condition values may reference {{token}} fields. Only these are
// resolvable; an unknown token renders empty (never leaks a raw {{...}} to a
// customer). Values are pulled from the merged run record the engine builds
// (context + contact + client).
const TOKEN_FIELDS = [
  'customer_name',   // the caller's name (or the business owner, for account events)
  'first_name',      // first word of customer_name
  'business_name',   // the client business
  'service',         // service_requested
  'agent_name',      // owner_name of the business
  'appointment_time',
  'city',            // business_city
  'caller_phone',
  'plan',            // account events: the client's plan
  'amount',          // account events: amount due / charged
  'reason',          // account events: failure/cancel reason
];

function firstName(name) {
  if (!name) return '';
  return String(name).trim().split(/\s+/)[0] || '';
}

// Render an appointment time nicely in the business's timezone. An ISO datetime
// (from the real booking) becomes "Tue, Oct 28 at 2:00 PM"; free text (an AI
// transcript mention) is shown as-is.
function formatApptTime(val, tz) {
  if (!val) return '';
  const ms = Date.parse(val);
  if (!Number.isFinite(ms)) return String(val);
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(ms));
  } catch (e) { return String(val); }
}

// Build the flat field map the tokens resolve against, from the pieces the
// engine already has in hand. Missing pieces just yield empty tokens.
function buildTokenMap({ context = {}, contact = {}, client = {} } = {}) {
  const customerName = context.customer_name || contact.name || '';
  return {
    customer_name: customerName,
    first_name: firstName(customerName),
    business_name: client.business_name || '',
    service: context.service_requested || context.service || '',
    agent_name: client.owner_name || '',
    appointment_time: formatApptTime(context.appointment_time, client.timezone),
    city: client.business_city || '',
    caller_phone: context.caller_phone || contact.phone || '',
    plan: context.plan || '',
    amount: context.amount != null ? String(context.amount) : '',
    reason: context.reason || '',
  };
}

// Replace {{token}} with its value. Whitelisted only; unknown -> ''. Tolerates
// surrounding whitespace inside the braces.
function renderTemplate(str, tokenMap) {
  if (!str) return '';
  return String(str).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => {
    const k = String(key).toLowerCase();
    if (!TOKEN_FIELDS.includes(k)) return '';
    const v = tokenMap[k];
    return v == null ? '' : String(v);
  });
}

module.exports = {
  NODE_TYPES,
  TOKEN_FIELDS,
  isKnownNodeType,
  nodeTier,
  getEntitlements,
  entitlementsForAgency,
  mapPlanToTier,
  graphWithinPlan,
  buildTokenMap,
  renderTemplate,
  firstName,
};
