// ============================================================================
// GRANT AN AGENCY A NO-CARD 14-DAY TRIAL
// ----------------------------------------------------------------------------
// Creates a real Stripe trialing subscription with NO payment method up front.
// The agency uses the plan free for the trial; if no card is added by trial
// end, Stripe cancels the subscription (missing_payment_method: 'cancel'),
// which fires customer.subscription.deleted -> your existing handler suspends
// the agency and shows the subscribe prompt. They then add a card at checkout
// (skipTrial) and start paying. Exactly: free trial now, pay to continue.
//
// RUN IT in the backend environment (DigitalOcean App Platform Console):
//   node scripts/grant-agency-trial.js <agency_email> --confirm
// Options:
//   --plan=pro|scale   which plan the trial is for (default pro)
//   --days=14          trial length (default 14)
//   --confirm          actually create it (without it, dry run only)
// ============================================================================
require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { supabase } = require('../src/lib/supabase');
const { PLATFORM_PLANS } = require('../src/routes/stripe-platform');

const args = process.argv.slice(2);
const email = args.find((a) => a.includes('@'));
const plan = (args.find((a) => a.startsWith('--plan=')) || '--plan=pro').split('=')[1];
const days = Number((args.find((a) => a.startsWith('--days=')) || '--days=14').split('=')[1]) || 14;
const confirm = args.includes('--confirm');

(async () => {
  if (!email) {
    console.error('Usage: node scripts/grant-agency-trial.js <agency_email> [--plan=pro] [--days=14] --confirm');
    process.exit(1);
  }
  ['STRIPE_SECRET_KEY'].forEach((k) => { if (!process.env[k]) { console.error(`Missing env ${k}. Run this in the backend environment.`); process.exit(1); } });

  const target = PLATFORM_PLANS[plan];
  if (!target || !target.platformPrice) { console.error(`Plan "${plan}" is not configured (missing platform price env var).`); process.exit(1); }

  // Find the agency (case-insensitive exact email match).
  const { data: agency, error } = await supabase.from('agencies').select('*').ilike('email', email).single();
  if (error || !agency) { console.error(`No agency found for email "${email}".`); process.exit(1); }
  console.log(`\nAgency: ${agency.name}  (${agency.id})`);
  console.log(`  plan_type=${agency.plan_type}  status=${agency.status}  subscription_status=${agency.subscription_status}`);
  console.log(`  stripe_customer=${agency.stripe_customer_id || 'none'}  stripe_subscription=${agency.stripe_subscription_id || 'none'}`);
  console.log(`  grant: ${days}-day ${plan} trial, no card required.\n`);

  // Guard: don't stack on top of a live subscription.
  if (agency.stripe_subscription_id) {
    try {
      const existing = await stripe.subscriptions.retrieve(agency.stripe_subscription_id);
      if (['active', 'trialing', 'past_due'].includes(existing.status)) {
        console.error(`This agency already has a ${existing.status} subscription (${existing.id}).`);
        console.error('Cancel that first (or it will double-bill). Aborting.');
        process.exit(1);
      }
    } catch { /* stale/other-mode id; safe to proceed */ }
  }

  if (!confirm) { console.log('DRY RUN — nothing created. Re-run with --confirm to grant the trial.\n'); process.exit(0); }

  // Ensure a Stripe customer.
  let customerId = agency.stripe_customer_id;
  if (!customerId) {
    const c = await stripe.customers.create({ email: agency.email, name: agency.name, metadata: { agency_id: agency.id, type: 'agency' } });
    customerId = c.id;
    await supabase.from('agencies').update({ stripe_customer_id: customerId }).eq('id', agency.id);
    console.log(`Created Stripe customer ${customerId}`);
  }

  // Platform (flat) + metered-minute items. No per-client item is needed for a
  // trial (nothing is billed during it); the per-client item is set up when they
  // actually check out and start paying. No payment method is attached.
  const items = [{ price: target.platformPrice, quantity: 1 }];
  if (target.minutePrice) items.push({ price: target.minutePrice });

  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items,
    trial_period_days: days,
    // The key: allow a trial with no card, and cancel at trial end if none added.
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    metadata: { agency_id: agency.id, plan, granted_trial: 'true' },
  });

  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : new Date(Date.now() + days * 86400000);

  // Reflect the trial on the agency immediately (the webhooks also set this, but
  // writing it here means Jeff can log in and use it right away).
  await supabase.from('agencies').update({
    status: 'trial',
    subscription_status: 'trial',
    plan_type: plan,
    stripe_subscription_id: sub.id,
    trial_ends_at: trialEnd.toISOString(),
    max_team_members_agency: null,
    max_team_members_client: null,
    updated_at: new Date().toISOString(),
  }).eq('id', agency.id);

  console.log(`\n✅ Granted. ${agency.name} is on a ${days}-day ${plan} trial (sub ${sub.id}, status ${sub.status}).`);
  console.log(`   Trial ends ${trialEnd.toLocaleDateString()}. No card collected.`);
  console.log(`   If no card is added by then, Stripe cancels the subscription and the dashboard prompts them to subscribe.\n`);
})();