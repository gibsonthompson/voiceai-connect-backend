// ============================================================================
// STRIPE PLATFORM BILLING - Agencies Pay Platform
// REWRITTEN: 2026-05-06 — Pricing Restructure (free/pro/scale + metered billing)
//
// NEW MODEL:
//   Free  = $0 platform + $39.99/client + $0.12/min (no Stripe sub until first client)
//   Pro   = $199 platform + $9.99/client + $0.10/min (14-day trial)
//   Scale = $499 platform + $0/client + $0.05/min   (14-day trial)
//
// Stripe subscription items:
//   - Fixed recurring price (platform fee) — Pro & Scale only
//   - Metered price (per-client) — Free & Pro only (Scale = $0)
//   - Metered price (per-minute) — all tiers
//
// Usage is reported via the usage-reporter cron job.
// ============================================================================
const Stripe = require('stripe');
const { supabase, getAgencyByStripeCustomerId } = require('../lib/supabase');
const {
  sendEmail,
  sendAgencyTrialEndingSMS,
  sendAgencyPaymentFailedSMS,
  sendAgencySubscriptionCanceledSMS,
  sendPlatformNotificationSMS
} = require('../lib/notifications');
const { getSmsTemplate } = require('../lib/sms-templates');
const { getPlanRates } = require('../lib/usage-tracker');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================================
// PLAN CONFIGURATION
// ============================================================================
const PLAN_DETAILS = {
  free: {
    name: 'Free',
    platformFeeCents: 0,
    perClientCents: 2999,    // $29.99
    perMinuteCents: 12,      // $0.12
    trial: false,
    requiresCardAtSignup: false,
    whiteLabel: false,
  },
  pro: {
    name: 'Pro',
    platformFeeCents: 17900, // $179
    perClientCents: 999,     // $9.99
    perMinuteCents: 10,      // $0.10
    trial: true,
    trialDays: 14,
    requiresCardAtSignup: true,
    whiteLabel: true,
  },
  scale: {
    name: 'Scale',
    platformFeeCents: 49900, // $499
    perClientCents: 0,       // $0
    perMinuteCents: 5,       // $0.05
    trial: true,
    trialDays: 14,
    requiresCardAtSignup: true,
    whiteLabel: true,
  },
};

const TEAM_MEMBER_LIMITS = {
  free:  { agency: 0, client: 0 },
  pro:   { agency: 5, client: 2 },
  scale: { agency: -1, client: -1 }, // -1 = unlimited
};

// ============================================================================
// STRIPE PRICE IDS (set these in env after creating in Stripe dashboard)
// ============================================================================
// Create these in Stripe Dashboard > Products:
//
// Product: "VoiceAI Connect Pro"
//   - Price: $199/mo recurring (fixed)          → STRIPE_PRICE_PRO_PLATFORM
//   - Price: $9.99/unit metered (sum in period)  → STRIPE_PRICE_PRO_CLIENT
//   - Price: $0.10/unit metered (sum in period)  → STRIPE_PRICE_PRO_MINUTE
//
// Product: "VoiceAI Connect Scale"
//   - Price: $499/mo recurring (fixed)           → STRIPE_PRICE_SCALE_PLATFORM
//   - Price: $0.05/unit metered (sum in period)  → STRIPE_PRICE_SCALE_MINUTE
//
// Product: "VoiceAI Connect Free Usage"
//   - Price: $39.99/unit metered (sum in period) → STRIPE_PRICE_FREE_CLIENT
//   - Price: $0.12/unit metered (sum in period)  → STRIPE_PRICE_FREE_MINUTE

function getStripePriceIds(plan) {
  const ids = {
    free: {
      platform: null, // No platform fee
      client: process.env.STRIPE_PRICE_FREE_CLIENT,
      minute: process.env.STRIPE_PRICE_FREE_MINUTE,
    },
    pro: {
      platform: process.env.STRIPE_PRICE_PRO_PLATFORM,
      client: process.env.STRIPE_PRICE_PRO_CLIENT,
      minute: process.env.STRIPE_PRICE_PRO_MINUTE,
    },
    scale: {
      platform: process.env.STRIPE_PRICE_SCALE_PLATFORM,
      client: null, // $0 per client on Scale
      minute: process.env.STRIPE_PRICE_SCALE_MINUTE,
    },
  };
  return ids[plan] || ids.free;
}

// ============================================================================
// LEGACY PLAN MAPPING
// ============================================================================
const LEGACY_PLAN_MAP = {
  starter: 'free',
  professional: 'pro',
  enterprise: 'scale',
};

function normalizePlan(plan) {
  return LEGACY_PLAN_MAP[plan] || plan || 'free';
}

const COMMISSION_RATE = 0.40;

// ============================================================================
// CREATE CHECKOUT SESSION (Agency subscribes to Pro or Scale)
// ============================================================================
async function createAgencyCheckout(req, res) {
  try {
    const { agency_id, plan: rawPlan, skipTrial } = req.body;

    if (!agency_id || !rawPlan) {
      return res.status(400).json({ error: 'Missing required fields', required: ['agency_id', 'plan'] });
    }

    const plan = normalizePlan(rawPlan);
    const planDetails = PLAN_DETAILS[plan];
    if (!planDetails) {
      return res.status(400).json({ error: 'Invalid plan', valid_plans: Object.keys(PLAN_DETAILS) });
    }

    const priceIds = getStripePriceIds(plan);

    const { data: agency, error } = await supabase
      .from('agencies').select('*').eq('id', agency_id).single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    console.log(`Creating checkout for: ${agency.email} | Plan: ${plan} | Skip trial: ${!!skipTrial}`);

    // Ensure Stripe customer exists
    let customerId = agency.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: agency.email,
        name: agency.name,
        metadata: { agency_id, type: 'agency' },
      });
      customerId = customer.id;
      await supabase.from('agencies').update({ stripe_customer_id: customerId }).eq('id', agency_id);
      console.log('Stripe customer created:', customerId);
    }

    // Build line items
    const lineItems = [];

    // Fixed platform fee (Pro & Scale only)
    if (priceIds.platform) {
      lineItems.push({ price: priceIds.platform, quantity: 1 });
    }

    // Per-minute: metered via voice_minutes Stripe Meter (all tiers)
    if (priceIds.minute) {
      lineItems.push({ price: priceIds.minute });
    }

    // NOTE: Per-client price is NOT included in checkout.
    // It gets added to the subscription when the first billable client is created.
    // This avoids charging for 0 clients at signup.

    if (lineItems.length === 0) {
      return res.status(400).json({ error: 'No Stripe prices configured for this plan. Set STRIPE_PRICE_* env vars.' });
    }

    // Subscription data
    const subscriptionData = {
      metadata: { agency_id, plan },
    };
    if (planDetails.trial && !skipTrial) {
      subscriptionData.trial_period_days = planDetails.trialDays || 14;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: lineItems,
      subscription_data: subscriptionData,
      success_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing&subscribed=true`,
      cancel_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`,
      metadata: { agency_id, plan, type: 'agency_subscription' },
    });

    console.log('Checkout session created:', session.id);
    res.json({ success: true, sessionId: session.id, url: session.url });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

// ============================================================================
// CREATE FREE TIER METERED SUBSCRIPTION
// Called when a free-tier agency adds their first client (needs payment method)
// ============================================================================
async function createFreeUsageSubscription(agencyId) {
  const priceIds = getStripePriceIds('free');
  if (!priceIds.client && !priceIds.minute) {
    console.warn('⚠️ Free tier Stripe prices not configured');
    return null;
  }

  const { data: agency } = await supabase
    .from('agencies').select('*').eq('id', agencyId).single();

  if (!agency) return null;

  let customerId = agency.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: agency.email,
      name: agency.name,
      metadata: { agency_id: agencyId, type: 'agency' },
    });
    customerId = customer.id;
    await supabase.from('agencies').update({ stripe_customer_id: customerId }).eq('id', agencyId);
  }

  const items = [];
  if (priceIds.client) items.push({ price: priceIds.client, quantity: 1 }); // 1 billable client
  if (priceIds.minute) items.push({ price: priceIds.minute }); // metered via meter — no quantity

  try {
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items,
      metadata: { agency_id: agencyId, plan: 'free' },
    });

    // Store subscription item IDs for usage reporting
    const updateData = {
      stripe_subscription_id: subscription.id,
      usage_billing_enabled: true,
      subscription_status: 'active',
      status: 'active',
    };

    for (const item of subscription.items.data) {
      if (item.price.id === priceIds.client) {
        updateData.stripe_client_meter_item_id = item.id;
      } else if (item.price.id === priceIds.minute) {
        updateData.stripe_minute_meter_item_id = item.id;
      }
    }

    await supabase.from('agencies').update(updateData).eq('id', agencyId);
    console.log(`✅ Free usage subscription created for ${agency.name}: ${subscription.id}`);
    return subscription;

  } catch (err) {
    console.error(`❌ Free usage subscription failed for ${agency.name}:`, err.message);
    return null;
  }
}

// ============================================================================
// CREATE PORTAL SESSION (Agency manages subscription)
// ============================================================================
async function createAgencyPortal(req, res) {
  try {
    const { agency_id } = req.body;

    if (!agency_id) {
      return res.status(400).json({ error: 'agency_id required' });
    }

    const { data: agency, error } = await supabase
      .from('agencies').select('*').eq('id', agency_id).single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Has Stripe customer — open billing portal
    if (agency.stripe_customer_id) {
      console.log('Opening billing portal for:', agency.name);
      const session = await stripe.billingPortal.sessions.create({
        customer: agency.stripe_customer_id,
        return_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`,
      });
      return res.json({ success: true, url: session.url });
    }

    // No Stripe customer — create checkout for their current plan
    const plan = normalizePlan(agency.plan_type);
    
    if (plan === 'free') {
      // Free tier with no card — redirect to checkout to add payment method
      return res.json({
        success: false,
        needs_payment_method: true,
        message: 'Add a payment method to start billing.',
      });
    }

    // Pro/Scale without Stripe customer (shouldn't happen, but handle it)
    const planDetails = PLAN_DETAILS[plan];
    const priceIds = getStripePriceIds(plan);

    const customer = await stripe.customers.create({
      email: agency.email,
      name: agency.name,
      metadata: { agency_id, type: 'agency' },
    });
    await supabase.from('agencies').update({ stripe_customer_id: customer.id }).eq('id', agency_id);

    const lineItems = [];
    if (priceIds.platform) lineItems.push({ price: priceIds.platform, quantity: 1 });
    if (priceIds.client) lineItems.push({ price: priceIds.client });
    if (priceIds.minute) lineItems.push({ price: priceIds.minute });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: lineItems,
      subscription_data: { metadata: { agency_id, plan } },
      success_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing&subscribed=true`,
      cancel_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`,
      metadata: { agency_id, plan, type: 'agency_subscription' },
    });

    return res.json({ success: true, url: session.url });

  } catch (error) {
    console.error('Portal/checkout error:', error);
    res.status(500).json({ error: 'Failed to create billing session' });
  }
}

// ============================================================================
// WEBHOOK HANDLER - Platform Stripe Events
// ============================================================================
async function handlePlatformStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Platform Stripe webhook:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleAgencyCheckoutCompleted(event.data.object); break;
      case 'customer.subscription.created':
        await handleAgencySubscriptionCreated(event.data.object); break;
      case 'customer.subscription.updated':
        await handleAgencySubscriptionUpdated(event.data.object); break;
      case 'customer.subscription.deleted':
        await handleAgencySubscriptionDeleted(event.data.object); break;
      case 'invoice.payment_succeeded':
        await handleAgencyPaymentSucceeded(event.data.object); break;
      case 'invoice.payment_failed':
        await handleAgencyPaymentFailed(event.data.object); break;
      case 'customer.subscription.trial_will_end':
        await handleAgencyTrialEnding(event.data.object); break;
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// ============================================================================
// WEBHOOK HANDLERS
// ============================================================================

async function handleAgencyCheckoutCompleted(session) {
  console.log('Agency checkout completed:', session.id);

  const agencyId = session.metadata?.agency_id;
  const plan = normalizePlan(session.metadata?.plan_type || session.metadata?.plan);
  if (!agencyId) return;

  const teamLimits = TEAM_MEMBER_LIMITS[plan] || TEAM_MEMBER_LIMITS.free;

  let updateData = {
    plan_type: plan,
    stripe_subscription_id: session.subscription,
    usage_billing_enabled: true,
    updated_at: new Date().toISOString(),
    max_team_members_agency: teamLimits.agency,
    max_team_members_client: teamLimits.client,
  };

  // Retrieve subscription to get item IDs and status
  if (session.subscription) {
    try {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      const priceIds = getStripePriceIds(plan);

      // Store metered subscription item IDs for usage reporting
      for (const item of sub.items.data) {
        if (priceIds.client && item.price.id === priceIds.client) {
          updateData.stripe_client_meter_item_id = item.id;
        }
        if (priceIds.minute && item.price.id === priceIds.minute) {
          updateData.stripe_minute_meter_item_id = item.id;
        }
      }

      if (sub.status === 'trialing') {
        updateData.status = 'trial';
        updateData.subscription_status = 'trialing';
        updateData.trial_ends_at = new Date(sub.trial_end * 1000).toISOString();
      } else if (sub.status === 'active') {
        updateData.status = 'active';
        updateData.subscription_status = 'active';
        updateData.trial_ends_at = null;
      }
    } catch (subErr) {
      console.warn('Could not fetch subscription status:', subErr.message);
      updateData.status = 'active';
      updateData.subscription_status = 'active';
    }
  }

  await supabase.from('agencies').update(updateData).eq('id', agencyId);

  try {
    await supabase.from('agency_subscription_events').insert({
      agency_id: agencyId,
      event_type: 'checkout_completed',
      stripe_event_id: session.id,
      metadata: { plan },
    });
  } catch (e) { /* Non-critical */ }

  console.log(`Agency activated: ${agencyId} | Plan: ${plan} | Status: ${updateData.subscription_status} | Team: ${teamLimits.agency}/${teamLimits.client}`);
}

async function handleAgencySubscriptionCreated(subscription) {
  console.log('Agency subscription created:', subscription.id);
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  const plan = normalizePlan(subscription.metadata?.plan_type || subscription.metadata?.plan);
  const teamLimits = TEAM_MEMBER_LIMITS[plan] || TEAM_MEMBER_LIMITS.free;
  const priceIds = getStripePriceIds(plan);

  const updateData = {
    stripe_subscription_id: subscription.id,
    subscription_status: subscription.status,
    plan_type: plan,
    usage_billing_enabled: true,
    max_team_members_agency: teamLimits.agency,
    max_team_members_client: teamLimits.client,
  };

  // Store metered item IDs
  for (const item of subscription.items.data) {
    if (priceIds.client && item.price.id === priceIds.client) {
      updateData.stripe_client_meter_item_id = item.id;
    }
    if (priceIds.minute && item.price.id === priceIds.minute) {
      updateData.stripe_minute_meter_item_id = item.id;
    }
  }

  await supabase.from('agencies').update(updateData).eq('id', agency.id);
  console.log(`   Status: ${subscription.status} | Plan: ${plan} | Team: ${teamLimits.agency}/${teamLimits.client}`);
}

async function handleAgencySubscriptionUpdated(subscription) {
  console.log('Agency subscription updated:', subscription.id);
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  let status = subscription.status;
  let agencyStatus = agency.status;
  if (status === 'active') agencyStatus = 'active';
  else if (status === 'trialing') agencyStatus = 'trial';
  else if (status === 'past_due') agencyStatus = 'active';
  else if (status === 'canceled' || status === 'unpaid') agencyStatus = 'suspended';

  await supabase.from('agencies').update({
    subscription_status: status,
    status: agencyStatus,
    trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
  }).eq('id', agency.id);

  console.log(`   Stripe: ${status} → agency: ${agencyStatus}`);
}

async function handleAgencySubscriptionDeleted(subscription) {
  console.log('Agency subscription deleted:', subscription.id);
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  await supabase.from('agencies').update({
    subscription_status: 'canceled',
    status: 'suspended',
    usage_billing_enabled: false,
  }).eq('id', agency.id);

  await sendAgencySubscriptionCanceledSMS(agency);
}

async function handleAgencyPaymentSucceeded(invoice) {
  const amountDisplay = `${(invoice.currency || 'usd').toUpperCase()} ${(invoice.amount_paid / 100).toFixed(2)}`;
  console.log('Agency payment succeeded:', invoice.id, amountDisplay);

  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;

  if (invoice.amount_paid === 0) {
    console.log(`$0 invoice (trial) for ${agency.name} — skipping`);
    return;
  }

  console.log(`Real payment from ${agency.name}: ${amountDisplay}`);

  await supabase.from('agencies').update({
    subscription_status: 'active',
    status: 'active',
    updated_at: new Date().toISOString(),
  }).eq('id', agency.id);

  // Notify platform owner
  const templateMsg = await getSmsTemplate('admin_agency_payment', {
    name: agency.name,
    amount: amountDisplay,
    plan: agency.plan_type || 'unknown',
  });
  sendPlatformNotificationSMS(
    templateMsg || `Agency Payment Received\nName: ${agency.name}\nAmount: ${amountDisplay}\nPlan: ${agency.plan_type || 'unknown'}`
  ).catch(err => console.error('Failed to send payment notification:', err));

  // Process referral commission
  if (agency.referred_by) {
    try {
      const { data: referrer } = await supabase
        .from('agencies')
        .select('id, name, referral_earnings_cents, referral_balance_cents')
        .eq('referral_code', agency.referred_by).single();

      if (referrer) {
        const { data: existingCommission } = await supabase
          .from('referral_commissions').select('id').eq('stripe_invoice_id', invoice.id).single();

        if (!existingCommission) {
          const commissionAmount = Math.round(invoice.amount_paid * COMMISSION_RATE);
          await supabase.from('referral_commissions').insert({
            referrer_id: referrer.id,
            referred_id: agency.id,
            payment_amount_cents: invoice.amount_paid,
            commission_rate: COMMISSION_RATE,
            commission_amount_cents: commissionAmount,
            stripe_invoice_id: invoice.id,
            status: 'pending',
          });
          await supabase.from('agencies').update({
            referral_earnings_cents: (referrer.referral_earnings_cents || 0) + commissionAmount,
            referral_balance_cents: (referrer.referral_balance_cents || 0) + commissionAmount,
          }).eq('id', referrer.id);
          console.log(`Referral commission: $${(commissionAmount / 100).toFixed(2)} for ${referrer.name}`);
        }
      }
    } catch (commErr) {
      console.error('Referral commission error:', commErr);
    }
  }
}

async function handleAgencyPaymentFailed(invoice) {
  console.log('Agency payment failed:', invoice.id);
  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;
  if (invoice.amount_due === 0) return;

  await supabase.from('agencies').update({ subscription_status: 'past_due' }).eq('id', agency.id);
  await sendAgencyPaymentFailedSMS(agency);
}

async function handleAgencyTrialEnding(subscription) {
  console.log('Agency trial ending:', subscription.id);
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;
  const trialEnd = new Date(subscription.trial_end * 1000);
  const daysLeft = Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24));
  await sendAgencyTrialEndingSMS(agency, daysLeft);
}

// ============================================================================
// WARN NO-CARD TRIAL AGENCIES (3 days before expiry)
// ============================================================================
async function warnExpiringAgencyTrials() {
  console.log('Checking for expiring agency trials (no-card)...');

  const now = new Date();
  const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const { data: expiringAgencies, error } = await supabase
    .from('agencies')
    .select('id, name, email, phone, plan_type, trial_ends_at, country')
    .in('subscription_status', ['trial', 'trialing'])
    .is('stripe_subscription_id', null)
    .lt('trial_ends_at', threeDaysFromNow.toISOString())
    .gt('trial_ends_at', now.toISOString());

  if (error) {
    console.error('Error fetching expiring trials:', error);
    return { success: false, error: error.message };
  }

  console.log(`Found ${expiringAgencies?.length || 0} expiring no-card agency trials`);
  const results = [];

  for (const agency of expiringAgencies || []) {
    try {
      const trialEnd = new Date(agency.trial_ends_at);
      const hoursLeft = (trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60);
      const daysLeft = Math.ceil(hoursLeft / 24);
      const trialEndDate = trialEnd.toLocaleDateString();

      let agencyMessage = null;

      if (daysLeft >= 3) {
        const templateMsg = await getSmsTemplate('agency_trial_warning_day3', { name: agency.name, trial_end_date: trialEndDate });
        agencyMessage = templateMsg ||
          `Hey ${agency.name} — your VoiceAI Connect trial wraps up on ${trialEndDate}.\n\nSubscribe here:\nmyvoiceaiconnect.com/agency/settings?tab=billing\n\nQuestions? Reply to this text.`;
      } else if (daysLeft === 2) {
        const templateMsg = await getSmsTemplate('agency_trial_warning_day2', { name: agency.name, trial_end_date: trialEndDate });
        agencyMessage = templateMsg ||
          `Hey ${agency.name} — your trial ends ${trialEndDate}. After that your dashboard goes offline.\n\nSubscribe:\nmyvoiceaiconnect.com/agency/settings?tab=billing`;
      } else if (daysLeft <= 1) {
        const templateMsg = await getSmsTemplate('agency_trial_warning_day1', { name: agency.name });
        agencyMessage = templateMsg ||
          `Hey ${agency.name} — your VoiceAI Connect trial ends tomorrow. Subscribe to keep running:\nmyvoiceaiconnect.com/agency/settings?tab=billing`;
      }

      if (agency.phone && agencyMessage) {
        const { sendTelnyxSMS } = require('../lib/notifications');
        await sendTelnyxSMS(agency.phone, agencyMessage);
      }

      const adminTemplate = await getSmsTemplate('admin_agency_trial_expiring', {
        days_left: daysLeft, name: agency.name, email: agency.email, plan: agency.plan_type || 'free',
      });
      await sendPlatformNotificationSMS(
        adminTemplate || `Agency Trial Expiring (${daysLeft}d)\n${agency.name}\n${agency.email}\nPlan: ${agency.plan_type || 'free'}`
      );

      results.push({ id: agency.id, name: agency.name, daysLeft, success: true });
    } catch (err) {
      console.error(`Error warning agency ${agency.id}:`, err);
      results.push({ id: agency.id, name: agency.name, success: false, error: err.message });
    }
  }

  return { success: true, processed: results.length, results };
}

// ============================================================================
// HELPER: CAN AGENCY ADD CLIENT (updated for usage-based — always yes if active)
// ============================================================================
async function canAgencyAddClient(agencyId) {
  const { data: agency, error } = await supabase
    .from('agencies').select('plan_type, subscription_status').eq('id', agencyId).single();

  if (error || !agency) return { allowed: false, reason: 'Agency not found' };
  if (!['active', 'trialing', 'trial'].includes(agency.subscription_status))
    return { allowed: false, reason: 'Subscription not active' };

  // No client limits in new pricing — all usage-based
  return { allowed: true, limit: 'unlimited' };
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  PLAN_DETAILS,
  TEAM_MEMBER_LIMITS,
  createAgencyCheckout,
  createAgencyPortal,
  createFreeUsageSubscription,
  handlePlatformStripeWebhook,
  canAgencyAddClient,
  warnExpiringAgencyTrials,
  normalizePlan,
  getStripePriceIds,
};