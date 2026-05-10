// ============================================================================
// STRIPE PLATFORM BILLING - Agencies Pay Platform
// REWRITTEN: 2026-05-06 — Pricing Restructure (free/pro/scale + metered billing)
// UPDATED: 2026-05-09 — Trial warning guards, sendAndLogSMS
// UPDATED: 2026-05-10 — alertError() in all catch blocks for SMS alerts
//
// NEW MODEL:
//   Free  = $0 platform + $29.99/client + $0.12/min (no Stripe sub until first client)
//   Pro   = $179 platform + $9.99/client + $0.10/min (14-day trial)
//   Scale = $499 platform + $0/client + $0.05/min   (14-day trial)
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
const { sendAndLogSMS } = require('../lib/sms-logger');
const { getPlanRates } = require('../lib/usage-tracker');
const { alertError } = require('../lib/error-monitor');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================================
// PLAN CONFIGURATION
// ============================================================================
const PLAN_DETAILS = {
  free: { name: 'Free', platformFeeCents: 0, perClientCents: 2999, perMinuteCents: 12, trial: false, requiresCardAtSignup: false, whiteLabel: false },
  pro: { name: 'Pro', platformFeeCents: 17900, perClientCents: 999, perMinuteCents: 10, trial: true, trialDays: 14, requiresCardAtSignup: true, whiteLabel: true },
  scale: { name: 'Scale', platformFeeCents: 49900, perClientCents: 0, perMinuteCents: 5, trial: true, trialDays: 14, requiresCardAtSignup: true, whiteLabel: true },
};

const TEAM_MEMBER_LIMITS = {
  free:  { agency: 0, client: 0 },
  pro:   { agency: 5, client: 2 },
  scale: { agency: -1, client: -1 },
};

function getStripePriceIds(plan) {
  const ids = {
    free: { platform: null, client: process.env.STRIPE_PRICE_FREE_CLIENT, minute: process.env.STRIPE_PRICE_FREE_MINUTE },
    pro: { platform: process.env.STRIPE_PRICE_PRO_PLATFORM, client: process.env.STRIPE_PRICE_PRO_CLIENT, minute: process.env.STRIPE_PRICE_PRO_MINUTE },
    scale: { platform: process.env.STRIPE_PRICE_SCALE_PLATFORM, client: null, minute: process.env.STRIPE_PRICE_SCALE_MINUTE },
  };
  return ids[plan] || ids.free;
}

const LEGACY_PLAN_MAP = { starter: 'free', professional: 'pro', enterprise: 'scale' };
function normalizePlan(plan) { return LEGACY_PLAN_MAP[plan] || plan || 'free'; }

const COMMISSION_RATE = 0.40;

// ============================================================================
// CREATE CHECKOUT SESSION
// ============================================================================
async function createAgencyCheckout(req, res) {
  try {
    const { agency_id, plan: rawPlan, skipTrial } = req.body;
    if (!agency_id || !rawPlan) return res.status(400).json({ error: 'Missing required fields', required: ['agency_id', 'plan'] });

    const plan = normalizePlan(rawPlan);
    const planDetails = PLAN_DETAILS[plan];
    if (!planDetails) return res.status(400).json({ error: 'Invalid plan', valid_plans: Object.keys(PLAN_DETAILS) });

    const priceIds = getStripePriceIds(plan);
    const { data: agency, error } = await supabase.from('agencies').select('*').eq('id', agency_id).single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });

    console.log(`Creating checkout for: ${agency.email} | Plan: ${plan} | Skip trial: ${!!skipTrial}`);

    let customerId = agency.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: agency.email, name: agency.name, metadata: { agency_id, type: 'agency' } });
      customerId = customer.id;
      await supabase.from('agencies').update({ stripe_customer_id: customerId }).eq('id', agency_id);
      console.log('Stripe customer created:', customerId);
    }

    const lineItems = [];
    if (priceIds.platform) lineItems.push({ price: priceIds.platform, quantity: 1 });
    if (priceIds.minute) lineItems.push({ price: priceIds.minute });
    if (lineItems.length === 0) return res.status(400).json({ error: 'No Stripe prices configured for this plan. Set STRIPE_PRICE_* env vars.' });

    const subscriptionData = { metadata: { agency_id, plan } };
    if (planDetails.trial && !skipTrial) subscriptionData.trial_period_days = planDetails.trialDays || 14;

    const session = await stripe.checkout.sessions.create({
      customer: customerId, mode: 'subscription', payment_method_types: ['card'],
      line_items: lineItems, subscription_data: subscriptionData,
      success_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing&subscribed=true`,
      cancel_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`,
      metadata: { agency_id, plan, type: 'agency_subscription' },
    });

    console.log('Checkout session created:', session.id);
    res.json({ success: true, sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    alertError('stripe-checkout', error, { body: JSON.stringify(req.body).slice(0, 200) });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

// ============================================================================
// CREATE FREE TIER METERED SUBSCRIPTION
// ============================================================================
async function createFreeUsageSubscription(agencyId) {
  const priceIds = getStripePriceIds('free');
  if (!priceIds.client && !priceIds.minute) { console.warn('⚠️ Free tier Stripe prices not configured'); return null; }

  const { data: agency } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
  if (!agency) return null;

  let customerId = agency.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: agency.email, name: agency.name, metadata: { agency_id: agencyId, type: 'agency' } });
    customerId = customer.id;
    await supabase.from('agencies').update({ stripe_customer_id: customerId }).eq('id', agencyId);
  }

  const items = [];
  if (priceIds.client) items.push({ price: priceIds.client, quantity: 1 });
  if (priceIds.minute) items.push({ price: priceIds.minute });

  try {
    const subscription = await stripe.subscriptions.create({ customer: customerId, items, metadata: { agency_id: agencyId, plan: 'free' } });
    const updateData = { stripe_subscription_id: subscription.id, usage_billing_enabled: true, subscription_status: 'active', status: 'active' };
    for (const item of subscription.items.data) {
      if (item.price.id === priceIds.client) updateData.stripe_client_meter_item_id = item.id;
      else if (item.price.id === priceIds.minute) updateData.stripe_minute_meter_item_id = item.id;
    }
    await supabase.from('agencies').update(updateData).eq('id', agencyId);
    console.log(`✅ Free usage subscription created for ${agency.name}: ${subscription.id}`);
    return subscription;
  } catch (err) {
    console.error(`❌ Free usage subscription failed for ${agency.name}:`, err.message);
    alertError('free-subscription-create', err, { agencyId, agencyName: agency.name });
    return null;
  }
}

// ============================================================================
// CREATE PORTAL SESSION
// ============================================================================
async function createAgencyPortal(req, res) {
  try {
    const { agency_id } = req.body;
    if (!agency_id) return res.status(400).json({ error: 'agency_id required' });

    const { data: agency, error } = await supabase.from('agencies').select('*').eq('id', agency_id).single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });

    if (agency.stripe_customer_id) {
      console.log('Opening billing portal for:', agency.name);
      const session = await stripe.billingPortal.sessions.create({ customer: agency.stripe_customer_id, return_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing` });
      return res.json({ success: true, url: session.url });
    }

    const plan = normalizePlan(agency.plan_type);
    if (plan === 'free') return res.json({ success: false, needs_payment_method: true, message: 'Add a payment method to start billing.' });

    const priceIds = getStripePriceIds(plan);
    const customer = await stripe.customers.create({ email: agency.email, name: agency.name, metadata: { agency_id, type: 'agency' } });
    await supabase.from('agencies').update({ stripe_customer_id: customer.id }).eq('id', agency_id);

    const lineItems = [];
    if (priceIds.platform) lineItems.push({ price: priceIds.platform, quantity: 1 });
    if (priceIds.client) lineItems.push({ price: priceIds.client });
    if (priceIds.minute) lineItems.push({ price: priceIds.minute });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id, mode: 'subscription', payment_method_types: ['card'],
      line_items: lineItems, subscription_data: { metadata: { agency_id, plan } },
      success_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing&subscribed=true`,
      cancel_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`,
      metadata: { agency_id, plan, type: 'agency_subscription' },
    });
    return res.json({ success: true, url: session.url });
  } catch (error) {
    console.error('Portal/checkout error:', error);
    alertError('stripe-portal', error, { agency_id: req.body?.agency_id });
    res.status(500).json({ error: 'Failed to create billing session' });
  }
}

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================
async function handlePlatformStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    alertError('stripe-webhook-signature', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Platform Stripe webhook:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed': await handleAgencyCheckoutCompleted(event.data.object); break;
      case 'customer.subscription.created': await handleAgencySubscriptionCreated(event.data.object); break;
      case 'customer.subscription.updated': await handleAgencySubscriptionUpdated(event.data.object); break;
      case 'customer.subscription.deleted': await handleAgencySubscriptionDeleted(event.data.object); break;
      case 'invoice.payment_succeeded': await handleAgencyPaymentSucceeded(event.data.object); break;
      case 'invoice.payment_failed': await handleAgencyPaymentFailed(event.data.object); break;
      case 'customer.subscription.trial_will_end': await handleAgencyTrialEnding(event.data.object); break;
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    alertError('stripe-webhook-processing', error, { eventType: event.type, eventId: event.id });
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
  let updateData = { plan_type: plan, stripe_subscription_id: session.subscription, usage_billing_enabled: true, updated_at: new Date().toISOString(), max_team_members_agency: teamLimits.agency, max_team_members_client: teamLimits.client };

  if (session.subscription) {
    try {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      const priceIds = getStripePriceIds(plan);
      for (const item of sub.items.data) {
        if (priceIds.client && item.price.id === priceIds.client) updateData.stripe_client_meter_item_id = item.id;
        if (priceIds.minute && item.price.id === priceIds.minute) updateData.stripe_minute_meter_item_id = item.id;
      }
      if (sub.status === 'trialing') { updateData.status = 'trial'; updateData.subscription_status = 'trialing'; updateData.trial_ends_at = new Date(sub.trial_end * 1000).toISOString(); }
      else if (sub.status === 'active') { updateData.status = 'active'; updateData.subscription_status = 'active'; updateData.trial_ends_at = null; }
    } catch (subErr) {
      console.warn('Could not fetch subscription status:', subErr.message);
      alertError('checkout-sub-fetch', subErr, { agencyId, subscriptionId: session.subscription });
      updateData.status = 'active'; updateData.subscription_status = 'active';
    }
  }

  await supabase.from('agencies').update(updateData).eq('id', agencyId);
  try { await supabase.from('agency_subscription_events').insert({ agency_id: agencyId, event_type: 'checkout_completed', stripe_event_id: session.id, metadata: { plan } }); } catch (e) { /* Non-critical */ }
  console.log(`Agency activated: ${agencyId} | Plan: ${plan} | Status: ${updateData.subscription_status} | Team: ${teamLimits.agency}/${teamLimits.client}`);
}

async function handleAgencySubscriptionCreated(subscription) {
  console.log('Agency subscription created:', subscription.id);
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;

  const plan = normalizePlan(subscription.metadata?.plan_type || subscription.metadata?.plan);
  const teamLimits = TEAM_MEMBER_LIMITS[plan] || TEAM_MEMBER_LIMITS.free;
  const priceIds = getStripePriceIds(plan);
  const updateData = { stripe_subscription_id: subscription.id, subscription_status: subscription.status, plan_type: plan, usage_billing_enabled: true, max_team_members_agency: teamLimits.agency, max_team_members_client: teamLimits.client };
  for (const item of subscription.items.data) {
    if (priceIds.client && item.price.id === priceIds.client) updateData.stripe_client_meter_item_id = item.id;
    if (priceIds.minute && item.price.id === priceIds.minute) updateData.stripe_minute_meter_item_id = item.id;
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
  await supabase.from('agencies').update({ subscription_status: status, status: agencyStatus, trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null }).eq('id', agency.id);
  console.log(`   Stripe: ${status} → agency: ${agencyStatus}`);
}

async function handleAgencySubscriptionDeleted(subscription) {
  console.log('Agency subscription deleted:', subscription.id);
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;
  await supabase.from('agencies').update({ subscription_status: 'canceled', status: 'suspended', usage_billing_enabled: false }).eq('id', agency.id);
  await sendAgencySubscriptionCanceledSMS(agency);
}

async function handleAgencyPaymentSucceeded(invoice) {
  const amountDisplay = `${(invoice.currency || 'usd').toUpperCase()} ${(invoice.amount_paid / 100).toFixed(2)}`;
  console.log('Agency payment succeeded:', invoice.id, amountDisplay);
  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;
  if (invoice.amount_paid === 0) { console.log(`$0 invoice (trial) for ${agency.name} — skipping`); return; }

  console.log(`Real payment from ${agency.name}: ${amountDisplay}`);
  await supabase.from('agencies').update({ subscription_status: 'active', status: 'active', updated_at: new Date().toISOString() }).eq('id', agency.id);

  const templateMsg = await getSmsTemplate('admin_agency_payment', { name: agency.name, amount: amountDisplay, plan: agency.plan_type || 'unknown' });
  sendPlatformNotificationSMS(templateMsg || `Agency Payment Received\nName: ${agency.name}\nAmount: ${amountDisplay}\nPlan: ${agency.plan_type || 'unknown'}`).catch(err => console.error('Failed to send payment notification:', err));

  if (agency.referred_by) {
    try {
      const { data: referrer } = await supabase.from('agencies').select('id, name, referral_earnings_cents, referral_balance_cents').eq('referral_code', agency.referred_by).single();
      if (referrer) {
        const { data: existingCommission } = await supabase.from('referral_commissions').select('id').eq('stripe_invoice_id', invoice.id).single();
        if (!existingCommission) {
          const commissionAmount = Math.round(invoice.amount_paid * COMMISSION_RATE);
          await supabase.from('referral_commissions').insert({ referrer_id: referrer.id, referred_id: agency.id, payment_amount_cents: invoice.amount_paid, commission_rate: COMMISSION_RATE, commission_amount_cents: commissionAmount, stripe_invoice_id: invoice.id, status: 'pending' });
          await supabase.from('agencies').update({ referral_earnings_cents: (referrer.referral_earnings_cents || 0) + commissionAmount, referral_balance_cents: (referrer.referral_balance_cents || 0) + commissionAmount }).eq('id', referrer.id);
          console.log(`Referral commission: $${(commissionAmount / 100).toFixed(2)} for ${referrer.name}`);
        }
      }
    } catch (commErr) {
      console.error('Referral commission error:', commErr);
      alertError('referral-commission', commErr, { agencyId: agency.id, invoiceId: invoice.id });
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
  alertError('stripe-payment-failed', new Error(`Payment failed for ${agency.name}`), { agencyId: agency.id, invoiceId: invoice.id, amount: invoice.amount_due });
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
    .select('id, name, email, phone, plan_type, trial_ends_at, country, trial_warning_last_sent_at')
    .in('subscription_status', ['trial', 'trialing'])
    .is('stripe_subscription_id', null)
    .lt('trial_ends_at', threeDaysFromNow.toISOString())
    .gt('trial_ends_at', now.toISOString());

  if (error) { console.error('Error fetching expiring trials:', error); return { success: false, error: error.message }; }
  console.log(`Found ${expiringAgencies?.length || 0} expiring no-card agency trials`);
  const results = [];

  for (const agency of expiringAgencies || []) {
    try {
      const plan = agency.plan_type || 'free';
      if (plan === 'free' || plan === 'starter') { console.log(`⏭️ Skipping ${agency.name} — Free plan, no trial`); continue; }
      if (agency.trial_warning_last_sent_at) {
        const hoursSinceLastWarning = (now.getTime() - new Date(agency.trial_warning_last_sent_at).getTime()) / (1000 * 60 * 60);
        if (hoursSinceLastWarning < 20) { console.log(`⏭️ Skipping ${agency.name} — already warned ${Math.round(hoursSinceLastWarning)}h ago`); continue; }
      }

      const trialEnd = new Date(agency.trial_ends_at);
      const hoursLeft = (trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60);
      const daysLeft = Math.ceil(hoursLeft / 24);
      const trialEndDate = trialEnd.toLocaleDateString();
      let agencyMessage = null;

      if (daysLeft >= 3) {
        const templateMsg = await getSmsTemplate('agency_trial_warning_day3', { name: agency.name, trial_end_date: trialEndDate });
        agencyMessage = templateMsg || `Hey ${agency.name} — quick heads up, your VoiceAI Connect trial wraps up on ${trialEndDate}.\n\nYour agency is fully set up — branding, pricing, signup page, all of it. You're ready to start bringing on clients whenever you want.\n\nIf you'd like to keep everything as-is, you can subscribe here:\nmyvoiceaiconnect.com/agency/settings?tab=billing\n\nAny questions, just reply to this text.`;
      } else if (daysLeft === 2) {
        const templateMsg = await getSmsTemplate('agency_trial_warning_day2', { name: agency.name, trial_end_date: trialEndDate });
        agencyMessage = templateMsg || `Hey ${agency.name} — just wanted to make sure this doesn't catch you off guard. Your VoiceAI Connect trial ends ${trialEndDate}.\n\nAfter that, your dashboard and client signup page will go offline, and any active AI receptionists will stop taking calls.\n\nIf you're planning to keep going, subscribing takes about 30 seconds:\nmyvoiceaiconnect.com/agency/settings?tab=billing\n\nAnd if it's not the right time, no worries at all.`;
      } else if (daysLeft <= 1) {
        const templateMsg = await getSmsTemplate('agency_trial_warning_day1', { name: agency.name });
        agencyMessage = templateMsg || `Hey ${agency.name} — your VoiceAI Connect trial ends tomorrow. After that your agency goes offline and any AI receptionists stop answering.\n\nIf you want to keep things running:\nmyvoiceaiconnect.com/agency/settings?tab=billing\n\nTakes less than a minute. Let me know if you need anything.`;
      }

      if (agency.phone && agencyMessage) {
        await sendAndLogSMS({ phone: agency.phone, message: agencyMessage, agencyId: agency.id, recipientType: 'agency_owner', messageType: `trial_warning_day${daysLeft}`, metadata: { daysLeft, plan, trialEndDate } });
        await supabase.from('agencies').update({ trial_warning_last_sent_at: now.toISOString() }).eq('id', agency.id);
      }

      const adminTemplate = await getSmsTemplate('admin_agency_trial_expiring', { days_left: daysLeft, name: agency.name, email: agency.email, plan: plan });
      await sendPlatformNotificationSMS(adminTemplate || `Agency Trial Expiring (${daysLeft}d)\n${agency.name}\n${agency.email}\nPlan: ${plan}`);
      results.push({ id: agency.id, name: agency.name, daysLeft, success: true });
    } catch (err) {
      console.error(`Error warning agency ${agency.id}:`, err);
      alertError('trial-warning', err, { agencyId: agency.id, agencyName: agency.name });
      results.push({ id: agency.id, name: agency.name, success: false, error: err.message });
    }
  }

  return { success: true, processed: results.length, results };
}

// ============================================================================
// HELPER: CAN AGENCY ADD CLIENT
// ============================================================================
async function canAgencyAddClient(agencyId) {
  const { data: agency, error } = await supabase.from('agencies').select('plan_type, subscription_status, stripe_subscription_id').eq('id', agencyId).single();
  if (error || !agency) return { allowed: false, reason: 'Agency not found' };
  if (!['active', 'trialing', 'trial'].includes(agency.subscription_status)) return { allowed: false, reason: 'Subscription not active' };
  const plan = normalizePlan(agency.plan_type);
  if (plan === 'free' && !agency.stripe_subscription_id) {
    return { allowed: false, reason: 'billing_required', message: 'Add a payment method to start adding clients. You will be charged per client and per minute of voice usage.' };
  }
  return { allowed: true, limit: 'unlimited' };
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  PLAN_DETAILS, TEAM_MEMBER_LIMITS,
  createAgencyCheckout, createAgencyPortal, createFreeUsageSubscription,
  handlePlatformStripeWebhook, canAgencyAddClient, warnExpiringAgencyTrials,
  normalizePlan, getStripePriceIds,
};