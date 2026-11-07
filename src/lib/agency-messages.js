// ============================================================================
// Agency-sent automated messages: definitions, defaults, and rendering
// VoiceAI Connect
// ----------------------------------------------------------------------------
// Single source of truth for the automated texts an agency sends to prospects
// and clients. Each message has a default template (which reproduces the exact
// copy the platform shipped) plus a per-agency override stored in
// agencies.message_overrides ({ [key]: string }). notifications.js precomputes
// the variables for a given send and calls renderAgencyMessage(); when the
// agency has set an override for that key, the override is rendered with the
// same variables, otherwise the default is used. Conditional fragments (an
// urgency line, a trial end date, a recap block) are precomputed and passed in
// as variables so both the default and any override resolve correctly.
//
// The settings UI reads MESSAGE_DEFS to show each message, its audience, its
// editable default, and the variables available for it.
// ============================================================================

// Build the agency's signup URL. An agency can point this at their OWN site
// (e.g. their own page with the embedded signup form) via custom_signup_url;
// otherwise we derive it: verified marketing domain, then slug subdomain, then
// the platform domain. This is the one place signup links are built so the
// override is honored everywhere (demo follow-up SMS, nurture texts, embeds).
function buildSignupUrl(agency) {
  const custom = typeof agency?.custom_signup_url === 'string' ? agency.custom_signup_url.trim() : '';
  if (custom) return custom;
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  if (agency?.marketing_domain && agency?.domain_verified) return `https://${agency.marketing_domain}/signup`;
  if (agency?.slug) return `https://${agency.slug}.${platformDomain}/signup`;
  return `https://${platformDomain}/signup`;
}

// Build the agency's client-login base + URL (same domain precedence, no custom
// override: login always lives on the real dashboard host, never the agency's
// marketing site).
function buildClientLoginUrl(agency) {
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  const base = (agency?.marketing_domain && agency?.domain_verified)
    ? `https://${agency.marketing_domain}`
    : (agency?.slug ? `https://${agency.slug}.${platformDomain}` : `https://${platformDomain}`);
  return `${base}/client/login`;
}

function buildClientUpgradeUrl(agency) {
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  if (agency?.marketing_domain && agency?.domain_verified) return `${agency.marketing_domain}/client/upgrade`;
  if (agency?.slug) return `${agency.slug}.${platformDomain}/client/upgrade`;
  return `${platformDomain}/client/upgrade`;
}

// Message catalog. `template` is the exact default copy, with {variables}.
// `variables` is what the editor offers (name + human description). `audience`
// groups them in the UI. Order here is the display order.
const MESSAGE_DEFS = {
  demo_followup: {
    label: 'Post-demo follow-up',
    audience: 'prospect',
    description: 'Sent to a prospect after they call your demo line. Carries your signup link.',
    variables: [
      { name: 'agency_name', desc: 'Your agency name' },
      { name: 'business_name', desc: "The prospect's business name (may be blank)" },
      { name: 'trial_cta', desc: 'Your trial call-to-action line (set by your trial length)' },
      { name: 'signup_url', desc: 'Your signup link (your custom link if set)' },
    ],
    template: `Thanks for trying {agency_name}'s AI receptionist demo{for_business}! 🎉\n\n{recap_block}Ready to get one{ready_suffix}? {trial_cta}\n{signup_url}`,
  },
  client_welcome: {
    label: 'Client welcome',
    audience: 'client',
    description: "Sent to a client's owner when their AI number goes live.",
    variables: [
      { name: 'brand', desc: 'Your agency name' },
      { name: 'business_name', desc: "The client's business name" },
      { name: 'ai_number', desc: "The client's new AI phone number" },
      { name: 'login_url', desc: 'Client dashboard login link' },
    ],
    template: `Welcome to {brand}!\nYour AI receptionist for {business_name} is ready.\n\nYour AI number:\n{ai_number}\n\nFinish setup and turn on call forwarding here:\n{login_url}`,
  },
  client_call_notification: {
    label: 'Post-call recap',
    audience: 'client',
    description: "Sent to a client's owner after each call their AI handles.",
    variables: [
      { name: 'business_name', desc: "The client's business name" },
      { name: 'customer_name', desc: 'The caller name' },
      { name: 'customer_phone', desc: 'The caller phone' },
      { name: 'summary', desc: 'AI summary of the call' },
      { name: 'brand', desc: 'Your agency name' },
      { name: 'urgency_line', desc: 'An urgency line when the call was high/emergency, else blank' },
    ],
    template: `🔔 New Call - {business_name}\nCustomer: {customer_name}\nPhone: {customer_phone}\n{urgency_line}Summary: {summary}\nPowered by {brand}`,
  },
  client_trial_expired: {
    label: 'Client trial ended',
    audience: 'client',
    description: "Sent to a client's owner when their free trial ends.",
    variables: [
      { name: 'brand', desc: 'Your agency name' },
      { name: 'who', desc: "The owner name (or business name)" },
      { name: 'upgrade_url', desc: 'Client upgrade/reactivate link' },
    ],
    template: `⚠️ {brand} Trial Ended\n\nHi {who}, your free trial has ended.\n\nYour AI receptionist is no longer answering calls.\n\nReactivate now: {upgrade_url}`,
  },
  client_payment_failed: {
    label: 'Client payment failed',
    audience: 'client',
    description: "Sent to a client's owner when their payment fails.",
    variables: [
      { name: 'brand', desc: 'Your agency name' },
      { name: 'who', desc: 'The owner name (or business name)' },
    ],
    template: `🚨 {brand} Payment Failed\n\nHi {who}, your payment failed.\n\nUpdate your payment method to keep your AI receptionist active.`,
  },
  client_subscription_activated: {
    label: 'Client subscription active',
    audience: 'client',
    description: "Sent to a client's owner when their plan activates (or trial starts).",
    variables: [
      { name: 'status_headline', desc: '"Free Trial Started!" or "Subscription Active!" with your brand' },
      { name: 'status_line', desc: 'The plan/trial sentence (includes trial end date when on trial)' },
      { name: 'phone_line', desc: "The client's AI number block (blank until a number is assigned)" },
    ],
    template: `{status_headline}\n\n{status_line}{phone_line}`,
  },
  client_spam_blocked: {
    label: 'Spam call blocked',
    audience: 'client',
    description: "Sent to a client's owner when their AI blocks a spam call.",
    variables: [
      { name: 'business_name', desc: "The client's business name" },
      { name: 'caller', desc: 'The blocked caller number' },
      { name: 'spam_reason', desc: 'Why it was flagged' },
    ],
    template: `🚫 Spam Blocked, {business_name}\n\nYour AI receptionist detected and blocked a spam call.\n\nCaller: {caller}\nType: {spam_reason}\n\nNo action needed, this call was not counted against your limit.`,
  },
};

// Substitute {name} tokens. Only names known for this message (its declared
// variables plus whatever vars were passed) are replaced; an unknown {token} is
// left as-is so a typo is visible rather than silently blanked.
function substitute(template, vars) {
  const known = new Set(Object.keys(vars || {}));
  return String(template).replace(/\{([a-z0-9_]+)\}/gi, (m, name) =>
    known.has(name) ? String(vars[name] ?? '') : m
  );
}

// Render a message for a send: the agency's override for this key when it is a
// non-blank string, otherwise the shipped default. Same variables feed both.
function renderAgencyMessage(key, agency, vars = {}) {
  const def = MESSAGE_DEFS[key];
  if (!def) return '';
  const overrides = (agency && typeof agency.message_overrides === 'object' && agency.message_overrides) || {};
  const raw = overrides[key];
  const template = (typeof raw === 'string' && raw.trim()) ? raw : def.template;
  return substitute(template, vars);
}

module.exports = {
  MESSAGE_DEFS,
  renderAgencyMessage,
  buildSignupUrl,
  buildClientLoginUrl,
  buildClientUpgradeUrl,
};
