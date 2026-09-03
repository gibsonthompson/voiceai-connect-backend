// ============================================================================
// AGENCY PLANS — single source of truth for plan resolution
// ----------------------------------------------------------------------------
// Plans used to be three hardcoded slots (starter/pro/growth) spread across
// dedicated columns and ~15 code sites. They are now a `plans` JSONB array on
// the agency: an ordered list of plan objects, each with a STABLE, IMMUTABLE
// `key`. `client.plan_type` references that key.
//
// Why a key and not an index/position:
//   - client.plan_type stores the key, and Stripe metadata + our billing maps
//     are keyed on it. A key must NEVER change once a client can be on the plan,
//     or live subscriptions would resolve to the wrong price/limit. Reordering
//     or renaming a plan is fine; changing its key is not (and the UI must never
//     let you edit a key).
//   - Legacy plans keep their historical keys 'starter'/'pro'/'growth', so every
//     existing client's plan_type already resolves with no data migration.
//
// This module is the ONLY place that knows the plan shape. Billing, marketing,
// signup, and settings all go through getAgencyPlans / getPlan, so adding a 4th
// (or Nth) plan is data, not code.
//
// LEGACY FALLBACK: when agency.plans is missing/empty (pre-backfill, or a row
// the migration hasn't touched), we synthesize the list from the old columns.
// This is what lets the billing refactor land BEFORE the data migration without
// changing behavior for a single agency.
// ============================================================================

const LEGACY_KEYS = ['starter', 'pro', 'growth'];
const LEGACY_DEFAULTS = {
  starter: { name: 'Starter', price: 9900, limit: 50, order: 0 },
  pro: { name: 'Professional', price: 14900, limit: 150, order: 1 },
  growth: { name: 'Growth', price: 29900, limit: 500, order: 2 },
};

// Normalize one raw plan object (from JSONB) into a complete, typed plan.
function normalizePlan(raw, order) {
  return {
    key: String(raw.key),
    name: raw.name || raw.key,
    price_cents: raw.price_cents != null ? Number(raw.price_cents) : null,
    call_limit: raw.call_limit != null ? Number(raw.call_limit) : 50, // -1 = unlimited
    description: typeof raw.description === 'string' ? raw.description : '',
    setup_fee_cents: raw.setup_fee_cents != null ? Number(raw.setup_fee_cents) : null,
    included_minutes: Number(raw.included_minutes) || 0,
    features: (raw.features && typeof raw.features === 'object') ? raw.features : {},
    visible: raw.visible !== false, // default visible
    order: raw.order != null ? Number(raw.order) : order,
  };
}

// Synthesize the plan list from the legacy starter/pro/growth columns. Used only
// when agency.plans is absent/empty.
function legacyPlansFromColumns(agency) {
  return LEGACY_KEYS.map((key, i) => {
    const d = LEGACY_DEFAULTS[key];
    const price = agency[`price_${key}`];
    const limit = agency[`limit_${key}`];
    return normalizePlan({
      key,
      name: agency[`plan_${key}_name`] || d.name,
      price_cents: price != null ? price : d.price,
      call_limit: limit != null ? limit : d.limit,
      description: agency[`plan_${key}_description`] || '',
      // per-plan setup fee, falling back to the legacy single fee
      setup_fee_cents: agency[`setup_fee_${key}_cents`] != null
        ? agency[`setup_fee_${key}_cents`]
        : (agency.setup_fee_cents != null ? agency.setup_fee_cents : null),
      included_minutes: agency[`included_minutes_${key}`] || 0,
      features: (agency.plan_features || {})[key] || {},
      // Legacy visibility rule matched the marketing filter: a priced tier showed,
      // an unpriced (null) one was hidden.
      visible: price != null,
      order: d.order,
    }, i);
  });
}

// The agency's plans as a normalized, ordered array. Prefers the JSONB array;
// falls back to the legacy columns. Never throws; returns [] only for a null
// agency.
function getAgencyPlans(agency) {
  if (!agency) return [];
  const raw = agency.plans;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .filter((p) => p && p.key != null)
      .map((p, i) => normalizePlan(p, i))
      .sort((a, b) => a.order - b.order);
  }
  return legacyPlansFromColumns(agency);
}

// Only the plans shown publicly (marketing site + signup). Billing/plan-change
// must use getPlan (a client can be on a plan later hidden from new signups).
function getVisiblePlans(agency) {
  return getAgencyPlans(agency).filter((p) => p.visible);
}

// Resolve a single plan by key (what client.plan_type stores). Returns null if
// the key isn't found — callers must handle that (invalid/removed plan).
function getPlan(agency, key) {
  if (!key) return null;
  return getAgencyPlans(agency).find((p) => p.key === key) || null;
}

// Valid plan keys for THIS agency (replaces the hardcoded VALID_PLANS).
function validPlanKeys(agency) {
  return getAgencyPlans(agency).map((p) => p.key);
}

// Generate a stable, unique, immutable key for a NEW plan. Slug from the name
// plus a short time-based suffix so two same-named plans never collide. Legacy
// keys are reserved so a new plan can't shadow starter/pro/growth.
function generatePlanKey(name, existingKeys = []) {
  const base = String(name || 'plan')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'plan';
  const reserved = new Set([...LEGACY_KEYS, ...existingKeys]);
  let key = `${base}_${Date.now().toString(36)}`;
  while (reserved.has(key)) key = `${base}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  return key;
}

module.exports = {
  LEGACY_KEYS,
  getAgencyPlans,
  getVisiblePlans,
  getPlan,
  validPlanKeys,
  generatePlanKey,
  normalizePlan,
};