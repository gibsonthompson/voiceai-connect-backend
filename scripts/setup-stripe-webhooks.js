#!/usr/bin/env node
/**
 * ============================================================================
 * setup-stripe-webhooks.js
 * VoiceAI Connect — Stripe webhook endpoint setup
 * ============================================================================
 *
 * Declarative management of platform + Connect webhook endpoints. Ensures
 * each endpoint is enabled, pointed at the correct URL, and listening to
 * exactly the events your handlers actually process.
 *
 * The event lists below are mirrored from the switch statements in:
 *   src/routes/stripe-platform.js → handlePlatformStripeWebhook (7 events)
 *   src/routes/stripe-connect.js  → handleConnectStripeWebhook  (6 events)
 *
 * If you ever add new cases to either switch, update the lists below and
 * re-run this script.
 *
 * ─── IMPORTANT: signing secrets ───────────────────────────────────────────
 * Stripe only returns a webhook's signing secret when the endpoint is
 * CREATED. For endpoints that already exist and get UPDATED, the secret
 * cannot be read via the API — you have to grab it from Dashboard manually
 * (Developers → Webhooks → click endpoint → Reveal signing secret).
 *
 * The script prints a copy-pasteable URL to the right Dashboard page for
 * each updated endpoint so you can grab the secret with one click.
 *
 * ─── SAFETY ───────────────────────────────────────────────────────────────
 * Idempotent. Safe to re-run.
 * Default behavior: events list is set to EXACT match with spec (Stripe's
 * webhookEndpoints.update replaces the full enabled_events array). Extra
 * events on Stripe that aren't in the spec are REMOVED. Pass --add-only to
 * preserve extras (merge instead of replace).
 *
 * In LIVE mode, the script pauses 5 seconds before any write so you can
 * Ctrl+C if you didn't mean to flip modes.
 *
 * ─── USAGE ────────────────────────────────────────────────────────────────
 *   STRIPE_SECRET_KEY=sk_test_xxx node setup-stripe-webhooks.js --dry-run
 *   STRIPE_SECRET_KEY=sk_test_xxx node setup-stripe-webhooks.js
 *   STRIPE_SECRET_KEY=sk_live_xxx node setup-stripe-webhooks.js
 *
 *   # Different backend URL (defaults to your DO app):
 *   BACKEND_URL=https://staging.example.com STRIPE_SECRET_KEY=sk_xxx node ...
 *
 *   # Preserve any extra events already configured on Stripe:
 *   STRIPE_SECRET_KEY=sk_xxx node setup-stripe-webhooks.js --add-only
 * ============================================================================
 */

const Stripe = require('stripe');

// ─── CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const addOnly = args.includes('--add-only');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage:
  STRIPE_SECRET_KEY=sk_xxx node setup-stripe-webhooks.js [options]

Options:
  --dry-run     Print what would change. No Stripe writes.
  --add-only    Only add missing events. Don't remove events on Stripe that
                aren't in the spec.
  --help        This message.

Env vars:
  STRIPE_SECRET_KEY   Required. sk_test_xxx or sk_live_xxx.
  BACKEND_URL         Optional. Defaults to your DO app URL.
`);
  process.exit(0);
}

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  console.error('\n✗ STRIPE_SECRET_KEY env var is required.\n');
  process.exit(1);
}

const stripe = new Stripe(stripeKey);
const isLive = stripeKey.startsWith('sk_live_');
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

// ─── Pretty logging ───────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const ok      = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const warn    = (m) => console.log(`  ${c.yellow}⚠${c.reset} ${m}`);
const fail    = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
const dim     = (m) => console.log(`  ${c.gray}${m}${c.reset}`);
const heading = (m) => console.log(`\n${c.bold}${c.cyan}━━━ ${m} ━━━${c.reset}`);

// ─── Spec ─────────────────────────────────────────────────────────────────
// Event lists are mirrored from the switch statements in:
//   src/routes/stripe-platform.js → handlePlatformStripeWebhook
//   src/routes/stripe-connect.js  → handleConnectStripeWebhook
const WEBHOOK_SPEC = [
  {
    label: 'Platform Webhook',
    url: `${BACKEND_URL}/webhook/stripe`,
    connect: false, // listens to "Your account" — agency subscriptions on platform Stripe
    envVar: 'STRIPE_WEBHOOK_SECRET',
    description: 'VoiceAI Connect — Platform (agency subscriptions)',
    events: [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.payment_succeeded',
      'invoice.payment_failed',
      'customer.subscription.trial_will_end',
    ],
  },
  {
    label: 'Connect Webhook',
    url: `${BACKEND_URL}/webhook/stripe-connect`,
    connect: true, // listens to "Connected accounts" — client subscriptions on agency Stripe
    envVar: 'STRIPE_CONNECT_WEBHOOK_SECRET',
    description: 'VoiceAI Connect — Connect (client subscriptions)',
    events: [
      'account.updated',
      'checkout.session.completed',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.payment_succeeded',
      'invoice.payment_failed',
      // NOTE: customer.subscription.created and trial_will_end deliberately
      // NOT listed. The Connect handler doesn't process them — client
      // activation flows through checkout.session.completed exclusively, and
      // trial expiry is handled by the expireTrials() cron job, not webhook.
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────
function normalizeUrl(u) {
  return (u || '').replace(/\/+$/, '').toLowerCase();
}

function dashboardUrl(endpointId, isLiveMode) {
  // Test-mode webhooks live at /test/webhooks/<id>, live at /webhooks/<id>
  const prefix = isLiveMode ? '' : '/test';
  return `https://dashboard.stripe.com${prefix}/webhooks/${endpointId}`;
}

function eventDiff(currentList, specList) {
  const current = new Set(currentList);
  const spec = new Set(specList);
  const missing = specList.filter((e) => !current.has(e));
  const extra = currentList.filter((e) => !spec.has(e) && e !== '*');
  return { missing, extra };
}

// ─── List all endpoints (paginated) ───────────────────────────────────────
async function listAllEndpoints() {
  let all = [];
  let cursor;
  do {
    const page = await stripe.webhookEndpoints.list({ limit: 100, starting_after: cursor });
    all = all.concat(page.data);
    if (!page.has_more) break;
    cursor = page.data[page.data.length - 1]?.id;
  } while (cursor);
  return all;
}

// ─── Process a single spec ────────────────────────────────────────────────
async function ensureWebhook(spec, allEndpoints) {
  heading(spec.label);
  dim(`URL:           ${spec.url}`);
  dim(`Listening to:  ${spec.connect ? 'Connected accounts' : 'Your account'}`);
  dim(`Events:        ${spec.events.length}`);
  console.log('');

  const existing = allEndpoints.find((e) => normalizeUrl(e.url) === normalizeUrl(spec.url));

  // ── No existing endpoint → create new ──
  if (!existing) {
    if (dryRun) {
      dim(`[dry-run] Would CREATE new endpoint:`);
      dim(`  url=${spec.url}`);
      dim(`  connect=${spec.connect}`);
      dim(`  events=${spec.events.length} (${spec.events.join(', ')})`);
      return { spec, action: 'would-create' };
    }

    const created = await stripe.webhookEndpoints.create({
      url: spec.url,
      enabled_events: spec.events,
      connect: spec.connect,
      description: spec.description,
    });
    ok(`CREATED endpoint: ${created.id}`);
    ok(`Signing secret available below (only chance to copy — Stripe won't show it again)`);
    return { spec, action: 'created', endpoint: created, secret: created.secret };
  }

  // ── Existing endpoint found ──
  dim(`Found existing: ${existing.id} (status=${existing.status})`);

  // NOTE: We deliberately do NOT validate that `existing.connect` matches
  // `spec.connect`. The Stripe WebhookEndpoint API response does not include
  // a `connect` field — it's only a parameter at creation time, not surfaced
  // on retrieve/list. The URL match is the authoritative signal: if the
  // endpoint sits at the URL we expect, treat it as the right one. If
  // someone manually created an endpoint with the wrong connect mode at the
  // right URL, the events won't fire correctly and they'll find out via
  // testing — at which point they delete and recreate manually.

  const updates = {};
  let willUpdate = false;
  const reasons = [];

  // Enable if disabled
  if (existing.status === 'disabled') {
    updates.disabled = false;
    willUpdate = true;
    reasons.push('enable disabled endpoint');
  }

  // Description drift sync (nice-to-have, harmless)
  if (existing.description !== spec.description) {
    updates.description = spec.description;
    willUpdate = true;
    reasons.push('sync description');
  }

  // Events
  const { missing, extra } = eventDiff(existing.enabled_events, spec.events);
  if (missing.length > 0 || (extra.length > 0 && !addOnly)) {
    updates.enabled_events = addOnly
      ? [...new Set([...existing.enabled_events, ...spec.events])]
      : spec.events;
    willUpdate = true;
    if (missing.length > 0) reasons.push(`add ${missing.length} missing event(s)`);
    if (extra.length > 0 && !addOnly) reasons.push(`remove ${extra.length} extra event(s)`);
    if (extra.length > 0 && addOnly) reasons.push(`(${extra.length} extra event(s) preserved by --add-only)`);
  }

  // Print delta
  if (missing.length > 0) {
    console.log('');
    console.log(`  ${c.green}+ ${c.reset}events to add:`);
    missing.forEach((e) => console.log(`    ${c.green}+${c.reset} ${e}`));
  }
  if (extra.length > 0) {
    console.log('');
    if (addOnly) {
      console.log(`  ${c.yellow}~ ${c.reset}events not in spec (preserved by --add-only):`);
      extra.forEach((e) => console.log(`    ${c.yellow}~${c.reset} ${e}`));
    } else {
      console.log(`  ${c.red}- ${c.reset}events to remove:`);
      extra.forEach((e) => console.log(`    ${c.red}-${c.reset} ${e}`));
    }
  }

  if (!willUpdate) {
    console.log('');
    ok(`Already matches spec. No changes needed.`);
    return { spec, action: 'no-op', endpoint: existing };
  }

  console.log('');
  if (dryRun) {
    dim(`[dry-run] Would UPDATE ${existing.id}: ${reasons.join(', ')}`);
    return { spec, action: 'would-update', endpoint: existing };
  }

  const updated = await stripe.webhookEndpoints.update(existing.id, updates);
  ok(`UPDATED ${updated.id}: ${reasons.join(', ')}`);
  warn(`Signing secret not retrievable via API for existing endpoints — grab from Dashboard:`);
  dim(`  ${dashboardUrl(updated.id, isLive)}`);
  return { spec, action: 'updated', endpoint: updated };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log(`${c.bold}🪝 VoiceAI Connect — Stripe Webhook Setup${c.reset}`);
  console.log(`   Mode:        ${isLive ? `${c.red}${c.bold}LIVE${c.reset}` : `${c.green}TEST${c.reset}`}`);
  console.log(`   Dry-run:     ${dryRun ? `${c.yellow}YES${c.reset}` : 'NO'}`);
  console.log(`   Add-only:    ${addOnly ? `${c.yellow}YES (extra events preserved)${c.reset}` : 'NO (events synced to spec exactly)'}`);
  console.log(`   Backend URL: ${BACKEND_URL}`);
  console.log('');

  if (isLive && !dryRun) {
    warn(`${c.bold}About to write to LIVE webhook endpoints.${c.reset}`);
    warn('Press Ctrl+C within 5 seconds to cancel...');
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Load all endpoints once (saves API calls)
  console.log(`${c.dim}Fetching all webhook endpoints from Stripe...${c.reset}`);
  const allEndpoints = await listAllEndpoints();
  console.log(`${c.dim}Found ${allEndpoints.length} endpoint(s) total.${c.reset}`);

  // Process each spec
  const results = [];
  for (const spec of WEBHOOK_SPEC) {
    const r = await ensureWebhook(spec, allEndpoints);
    results.push(r);
  }

  // ─── Surface unrecognized endpoints ─────────────────────────────────────
  const specUrls = new Set(WEBHOOK_SPEC.map((s) => normalizeUrl(s.url)));
  const unrecognized = allEndpoints.filter((e) => !specUrls.has(normalizeUrl(e.url)));
  if (unrecognized.length > 0) {
    heading('Other webhook endpoints (not managed by this script)');
    console.log('');
    for (const e of unrecognized) {
      dim(`${e.id}  status=${e.status}  url=${e.url}`);
    }
    console.log('');
    warn(`Found ${unrecognized.length} webhook(s) not in this script's spec.`);
    dim(`Review these in Dashboard. If they're orphans from old setups, delete manually.`);
    dim(`The platform and Connect endpoints above will still work regardless.`);
  }

  // ─── Output env-var instructions ────────────────────────────────────────
  heading('Env vars / signing secrets');
  console.log('');

  const created = results.filter((r) => r.action === 'created');
  const updated = results.filter((r) => r.action === 'updated');
  const noop    = results.filter((r) => r.action === 'no-op');

  // Secrets available (new endpoints only)
  if (created.length > 0) {
    console.log(`${c.bold}${c.green}New endpoints — secrets below (COPY NOW, Stripe won't show again):${c.reset}`);
    console.log('');
    for (const r of created) {
      console.log(`${c.cyan}${r.spec.envVar}${c.reset}=${r.secret}  ${c.gray}# ${r.spec.label}${c.reset}`);
    }
    console.log('');
  }

  // Updated endpoints — secrets must be retrieved from Dashboard
  if (updated.length > 0) {
    console.log(`${c.bold}${c.yellow}Updated endpoints — grab signing secrets from Dashboard:${c.reset}`);
    console.log('');
    for (const r of updated) {
      console.log(`  ${c.cyan}${r.spec.envVar}${c.reset}  →  ${dashboardUrl(r.endpoint.id, isLive)}`);
      dim(`    (click "Click to reveal" on the Signing secret card)`);
    }
    console.log('');
  }

  // No changes
  if (noop.length > 0 && created.length === 0 && updated.length === 0) {
    ok('Everything already in sync. No changes made.');
  }

  // Final summary
  console.log('');
  console.log(`${c.bold}Summary:${c.reset}`);
  console.log(`  Created:  ${created.length}`);
  console.log(`  Updated:  ${updated.length}`);
  console.log(`  No-op:    ${noop.length}`);
  if (unrecognized.length > 0) {
    console.log(`  Unmanaged: ${unrecognized.length} (review in Dashboard)`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('');
  fail(`Script failed: ${e.message}`);
  if (e.raw) {
    console.error('');
    console.error('Stripe error detail:');
    console.error(JSON.stringify(e.raw, null, 2));
  }
  process.exit(1);
});