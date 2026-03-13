// ============================================================================
// STRIPE PLATFORM BILLING - Agencies Pay Platform
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

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================================
// PLAN DETAILS (USD base prices in cents)
// ============================================================================
const PLAN_DETAILS = {
  starter: { name: 'Starter', clientLimit: 25, priceUsdCents: 9900 },
  professional: { name: 'Professional', clientLimit: 100, priceUsdCents: 19900 },
  enterprise: { name: 'Enterprise', clientLimit: -1, priceUsdCents: 49900 }
}; // -1 = unlimited

// ============================================================================
// COUNTRY → CURRENCY MAPPING + EXCHANGE RATES
// ============================================================================
const CURRENCY_CONFIG = {
  USD: { code: 'usd', rate: 1.00, zeroDecimal: false },
  CAD: { code: 'cad', rate: 1.36, zeroDecimal: false },
  GBP: { code: 'gbp', rate: 0.79, zeroDecimal: false },
  EUR: { code: 'eur', rate: 0.92, zeroDecimal: false },
  AUD: { code: 'aud', rate: 1.55, zeroDecimal: false },
  NZD: { code: 'nzd', rate: 1.70, zeroDecimal: false },
  JPY: { code: 'jpy', rate: 152, zeroDecimal: true },
  SGD: { code: 'sgd', rate: 1.34, zeroDecimal: false },
  CHF: { code: 'chf', rate: 0.88, zeroDecimal: false },
  HKD: { code: 'hkd', rate: 7.82, zeroDecimal: false },
  SEK: { code: 'sek', rate: 10.5, zeroDecimal: false },
  NOK: { code: 'nok', rate: 10.8, zeroDecimal: false },
  DKK: { code: 'dkk', rate: 6.87, zeroDecimal: false },
  PLN: { code: 'pln', rate: 4.02, zeroDecimal: false },
  BRL: { code: 'brl', rate: 5.85, zeroDecimal: false },
  MXN: { code: 'mxn', rate: 17.2, zeroDecimal: false },
  INR: { code: 'inr', rate: 83.5, zeroDecimal: false },
  THB: { code: 'thb', rate: 34.5, zeroDecimal: false },
  MYR: { code: 'myr', rate: 4.42, zeroDecimal: false },
  CZK: { code: 'czk', rate: 23.5, zeroDecimal: false },
  HUF: { code: 'huf', rate: 375, zeroDecimal: false },
  RON: { code: 'ron', rate: 4.58, zeroDecimal: false },
  BGN: { code: 'bgn', rate: 1.80, zeroDecimal: false },
  AED: { code: 'aed', rate: 3.67, zeroDecimal: false },
};

const COUNTRY_CURRENCY_MAP = {
  US: 'USD', CA: 'CAD', GB: 'GBP', MX: 'MXN', BR: 'BRL',
  AT: 'EUR', BE: 'EUR', CY: 'EUR', EE: 'EUR', FI: 'EUR', FR: 'EUR',
  DE: 'EUR', GR: 'EUR', IE: 'EUR', IT: 'EUR', LV: 'EUR', LT: 'EUR',
  LU: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR', SK: 'EUR', SI: 'EUR',
  ES: 'EUR', HR: 'EUR',
  BG: 'BGN', CZ: 'CZK', DK: 'DKK', HU: 'HUF', NO: 'NOK',
  PL: 'PLN', RO: 'RON', SE: 'SEK', CH: 'CHF',
  AU: 'AUD', NZ: 'NZD', JP: 'JPY', SG: 'SGD', HK: 'HKD',
  MY: 'MYR', TH: 'THB', IN: 'INR',
  AE: 'AED',
};

function convertToStripeAmount(usdCents, countryCode) {
  const currencyKey = COUNTRY_CURRENCY_MAP[countryCode] || 'USD';
  const config = CURRENCY_CONFIG[currencyKey] || CURRENCY_CONFIG.USD;
  const usdDollars = usdCents / 100;
  const localAmount = Math.round(usdDollars * config.rate);
  return config.zeroDecimal ? localAmount : localAmount * 100;
}

function getCurrencyCode(countryCode) {
  const currencyKey = COUNTRY_CURRENCY_MAP[countryCode] || 'USD';
  const config = CURRENCY_CONFIG[currencyKey] || CURRENCY_CONFIG.USD;
  return config.code;
}

const COMMISSION_RATE = 0.40;

// ============================================================================
// CREATE CHECKOUT SESSION (Agency subscribes to platform)
// ============================================================================
async function createAgencyCheckout(req, res) {
  try {
    const { agency_id, plan, skipTrial } = req.body;

    if (!agency_id || !plan) {
      return res.status(400).json({ error: 'Missing required fields', required: ['agency_id', 'plan'] });
    }

    const planDetails = PLAN_DETAILS[plan];
    if (!planDetails) {
      return res.status(400).json({ error: 'Invalid plan', valid_plans: Object.keys(PLAN_DETAILS) });
    }

    const { data: agency, error } = await supabase
      .from('agencies').select('*').eq('id', agency_id).single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    const countryCode = agency.country || 'US';
    const currency = getCurrencyCode(countryCode);
    const stripeAmount = convertToStripeAmount(planDetails.priceUsdCents, countryCode);

    console.log('Creating platform checkout for:', agency.email, '| Plan:', plan, '| Country:', countryCode, '| Currency:', currency.toUpperCase(), '| Amount:', stripeAmount, '| Skip trial:', !!skipTrial);

    let customerId = agency.stripe_customer_id;
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: agency.email, name: agency.name,
        metadata: { agency_id: agency_id, type: 'agency' }
      });
      customerId = customer.id;
      await supabase.from('agencies').update({ stripe_customer_id: customerId }).eq('id', agency_id);
      console.log('Stripe customer created:', customerId);
    }

    const subscriptionData = { metadata: { agency_id: agency_id, plan: plan } };
    if (!skipTrial) {
      subscriptionData.trial_period_days = 14;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId, mode: 'subscription', payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: currency, unit_amount: stripeAmount,
          recurring: { interval: 'month' },
          product_data: { name: `VoiceAI Connect ${planDetails.name} Plan`, description: `White-label AI receptionist platform - ${planDetails.name}` },
        },
        quantity: 1,
      }],
      subscription_data: subscriptionData,
      success_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing&subscribed=true`,
      cancel_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`,
      metadata: { agency_id: agency_id, plan: plan, type: 'agency_subscription' }
    });

    console.log('Checkout session created:', session.id, '| Currency:', currency.toUpperCase());
    res.json({ success: true, sessionId: session.id, url: session.url });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

// ============================================================================
// CREATE PORTAL SESSION (Agency manages subscription)
// Handles two cases:
// 1. Has stripe_customer_id → open Stripe billing portal
// 2. No stripe_customer_id (no-card trial) → create checkout session (no trial)
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

    // CASE 1: Has Stripe customer — open billing portal
    if (agency.stripe_customer_id) {
      console.log('Opening billing portal for:', agency.name, '| Customer:', agency.stripe_customer_id);
      const session = await stripe.billingPortal.sessions.create({
        customer: agency.stripe_customer_id,
        return_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`
      });
      return res.json({ success: true, url: session.url });
    }

    // CASE 2: No Stripe customer (no-card trial) — create checkout, no trial
    console.log('No Stripe customer for:', agency.name, '— creating checkout session instead of portal');

    const plan = agency.plan_type || 'starter';
    const planDetails = PLAN_DETAILS[plan];
    if (!planDetails) {
      return res.status(400).json({ error: 'Invalid plan type on agency record' });
    }

    const countryCode = agency.country || 'US';
    const currency = getCurrencyCode(countryCode);
    const stripeAmount = convertToStripeAmount(planDetails.priceUsdCents, countryCode);

    const customer = await stripe.customers.create({
      email: agency.email, name: agency.name,
      metadata: { agency_id: agency_id, type: 'agency' }
    });

    await supabase.from('agencies').update({ stripe_customer_id: customer.id }).eq('id', agency_id);
    console.log('Stripe customer created on-demand:', customer.id);

    const session = await stripe.checkout.sessions.create({
      customer: customer.id, mode: 'subscription', payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: currency, unit_amount: stripeAmount,
          recurring: { interval: 'month' },
          product_data: { name: `VoiceAI Connect ${planDetails.name} Plan`, description: `White-label AI receptionist platform - ${planDetails.name}` },
        },
        quantity: 1,
      }],
      subscription_data: { metadata: { agency_id: agency_id, plan: plan } },
      success_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing&subscribed=true`,
      cancel_url: `${process.env.FRONTEND_URL}/agency/settings?tab=billing`,
      metadata: { agency_id: agency_id, plan: plan, type: 'agency_subscription' }
    });

    console.log('Checkout session created for no-card trial agency:', session.id);
    return res.json({ success: true, url: session.url });

  } catch (error) {
    console.error('Portal/checkout error:', error);
    res.status(500).json({ error: 'Failed to create billing session' });
  }
}

// ============================================================================
// GET CLIENT LIMIT FOR PLAN
// ============================================================================
function getClientLimitForPlan(plan) {
  const details = PLAN_DETAILS[plan];
  if (!details) return 25;
  return details.clientLimit;
}

// ============================================================================
// CHECK IF AGENCY CAN ADD MORE CLIENTS
// ============================================================================
async function canAgencyAddClient(agencyId) {
  const { data: agency, error } = await supabase
    .from('agencies').select('plan_type, subscription_status').eq('id', agencyId).single();

  if (error || !agency) return { allowed: false, reason: 'Agency not found' };
  if (!['active', 'trialing', 'trial'].includes(agency.subscription_status)) return { allowed: false, reason: 'Subscription not active' };

  const isTrialing = ['trialing', 'trial'].includes(agency.subscription_status);
  const effectivePlan = isTrialing ? 'enterprise' : agency.plan_type;
  const clientLimit = getClientLimitForPlan(effectivePlan);
  
  if (clientLimit === -1) return { allowed: true, limit: 'unlimited', current: 0 };

  const { count, error: countError } = await supabase
    .from('clients').select('*', { count: 'exact', head: true }).eq('agency_id', agencyId).neq('status', 'deleted');

  if (countError) return { allowed: false, reason: 'Error counting clients' };

  const currentCount = count || 0;
  if (currentCount >= clientLimit) {
    return { allowed: false, reason: `Client limit reached (${currentCount}/${clientLimit}). Upgrade your plan to add more clients.`, limit: clientLimit, current: currentCount };
  }

  return { allowed: true, limit: clientLimit, current: currentCount, remaining: clientLimit - currentCount };
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
  const plan = session.metadata?.plan_type || session.metadata?.plan || 'starter';
  if (!agencyId) return;

  let updateData = { plan_type: plan, stripe_subscription_id: session.subscription, updated_at: new Date().toISOString() };

  if (session.subscription) {
    try {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
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
      agency_id: agencyId, event_type: 'checkout_completed', stripe_event_id: session.id, metadata: { plan }
    });
  } catch (e) { /* Non-critical */ }
  
  console.log('Agency activated:', agencyId, 'Plan:', plan, 'Status:', updateData.subscription_status);
}

async function handleAgencySubscriptionCreated(subscription) {
  console.log('Agency subscription created:', subscription.id);
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;
  const plan = subscription.metadata?.plan_type || subscription.metadata?.plan || 'starter';
  await supabase.from('agencies').update({ stripe_subscription_id: subscription.id, subscription_status: subscription.status, plan_type: plan }).eq('id', agency.id);
  console.log(`   Status: ${subscription.status}, Plan: ${plan}`);
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
    subscription_status: status, status: agencyStatus,
    trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null
  }).eq('id', agency.id);
  console.log(`   Stripe status: ${status} -> agency status: ${agencyStatus}`);
}

async function handleAgencySubscriptionDeleted(subscription) {
  console.log('Agency subscription deleted:', subscription.id);
  const agency = await getAgencyByStripeCustomerId(subscription.customer);
  if (!agency) return;
  await supabase.from('agencies').update({ subscription_status: 'canceled', status: 'suspended' }).eq('id', agency.id);
  await sendAgencySubscriptionCanceledSMS(agency);
}

async function handleAgencyPaymentSucceeded(invoice) {
  console.log('Agency payment succeeded:', invoice.id, `Amount: ${(invoice.currency || 'usd').toUpperCase()} ${(invoice.amount_paid / 100).toFixed(2)}`);
  
  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;
  
  if (invoice.amount_paid === 0) {
    console.log(`$0 invoice (trial) for ${agency.name} — skipping status update, keeping: ${agency.subscription_status}`);
    try {
      await supabase.from('agency_subscription_events').insert({
        agency_id: agency.id, event_type: 'trial_invoice_paid', stripe_event_id: invoice.id,
        metadata: { amount: 0, note: 'Trial $0 invoice — status preserved' }
      });
    } catch (e) { /* Non-critical */ }
    return;
  }
  
  console.log(`Real payment received for ${agency.name}: ${(invoice.currency || 'usd').toUpperCase()} ${(invoice.amount_paid / 100).toFixed(2)}`);
  
  await supabase.from('agencies').update({
    subscription_status: 'active', status: 'active', updated_at: new Date().toISOString()
  }).eq('id', agency.id);

  // Notify platform owner — agency converted to paid
  sendPlatformNotificationSMS(
    `Agency Payment Received\n` +
    `Name: ${agency.name}\n` +
    `Amount: ${(invoice.currency || 'usd').toUpperCase()} ${(invoice.amount_paid / 100).toFixed(2)}\n` +
    `Plan: ${agency.plan_type || 'unknown'}`
  ).catch(err => console.error('Failed to send payment notification:', err));

  // =========================================================================
  // PROCESS REFERRAL COMMISSION (40%)
  // =========================================================================
  if (agency.referred_by) {
    try {
      const { data: referrer, error: referrerError } = await supabase
        .from('agencies')
        .select('id, name, referral_earnings_cents, referral_balance_cents, stripe_account_id')
        .eq('referral_code', agency.referred_by).single();

      if (referrerError || !referrer) {
        console.warn(`Referrer not found for code: ${agency.referred_by}`);
      } else {
        const { data: existingCommission } = await supabase
          .from('referral_commissions').select('id').eq('stripe_invoice_id', invoice.id).single();

        if (existingCommission) {
          console.log(`Commission already processed for invoice: ${invoice.id}`);
        } else {
          const paymentAmount = invoice.amount_paid;
          const commissionAmount = Math.round(paymentAmount * COMMISSION_RATE);

          const { error: insertError } = await supabase.from('referral_commissions').insert({
            referrer_id: referrer.id, referred_id: agency.id,
            payment_amount_cents: paymentAmount, commission_rate: COMMISSION_RATE,
            commission_amount_cents: commissionAmount, stripe_invoice_id: invoice.id, status: 'pending'
          });

          if (insertError) {
            console.error('Error inserting commission:', insertError);
          } else {
            await supabase.from('agencies').update({
              referral_earnings_cents: (referrer.referral_earnings_cents || 0) + commissionAmount,
              referral_balance_cents: (referrer.referral_balance_cents || 0) + commissionAmount
            }).eq('id', referrer.id);
            console.log(`Referral commission: $${(commissionAmount / 100).toFixed(2)} for ${referrer.name} (referred ${agency.name})`);
          }
        }
      }
    } catch (commissionError) {
      console.error('Error processing referral commission:', commissionError);
    }
  }
}

async function handleAgencyPaymentFailed(invoice) {
  console.log('Agency payment failed:', invoice.id);
  const agency = await getAgencyByStripeCustomerId(invoice.customer);
  if (!agency) return;
  if (invoice.amount_due === 0) { console.log(`$0 invoice failure for ${agency.name} — skipping`); return; }
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
// Called by cron — sends escalating SMS to agencies whose no-card trial is
// ending soon. Each day has a different message and tone.
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
    console.error('Error fetching expiring agency trials:', error);
    return { success: false, error: error.message };
  }

  console.log(`Found ${expiringAgencies?.length || 0} expiring no-card agency trials`);

  const results = [];

  for (const agency of expiringAgencies || []) {
    try {
      const trialEnd = new Date(agency.trial_ends_at);
      const hoursLeft = (trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60);
      const daysLeft = Math.ceil(hoursLeft / 24);

      let agencyMessage = null;

      if (daysLeft >= 3) {
        // ================================================================
        // DAY 3 — Friendly check-in, remind them what's ready
        // ================================================================
        agencyMessage =
          `Hey ${agency.name} — quick heads up, your VoiceAI Connect trial wraps up on ${trialEnd.toLocaleDateString()}.\n\n` +
          `Your agency is fully set up — branding, pricing, signup page, all of it. You're ready to start bringing on clients whenever you want.\n\n` +
          `If you'd like to keep everything as-is, you can subscribe here:\n` +
          `myvoiceaiconnect.com/agency/settings?tab=billing\n\n` +
          `Any questions, just reply to this text.`;

      } else if (daysLeft === 2) {
        // ================================================================
        // DAY 2 — Honest about what happens, still helpful
        // ================================================================
        agencyMessage =
          `Hey ${agency.name} — just wanted to make sure this doesn't catch you off guard. Your VoiceAI Connect trial ends ${trialEnd.toLocaleDateString()}.\n\n` +
          `After that, your dashboard and client signup page will go offline, and any active AI receptionists will stop taking calls.\n\n` +
          `If you're planning to keep going, subscribing takes about 30 seconds:\n` +
          `myvoiceaiconnect.com/agency/settings?tab=billing\n\n` +
          `And if it's not the right time, no worries at all.`;

      } else if (daysLeft <= 1) {
        // ================================================================
        // DAY 1 — Last day, short and direct
        // ================================================================
        agencyMessage =
          `Hey ${agency.name} — your VoiceAI Connect trial ends tomorrow. After that your agency goes offline and any AI receptionists stop answering.\n\n` +
          `If you want to keep things running:\n` +
          `myvoiceaiconnect.com/agency/settings?tab=billing\n\n` +
          `Takes less than a minute. Let me know if you need anything.`;
      }

      if (agency.phone && agencyMessage) {
        const { sendTelnyxSMS } = require('../lib/notifications');
        await sendTelnyxSMS(agency.phone, agencyMessage);
        console.log(`Trial warning (day ${daysLeft}) sent to ${agency.name}`);
      }

      await sendPlatformNotificationSMS(
        `Agency Trial Expiring (${daysLeft}d)\n` +
        `Name: ${agency.name}\n` +
        `Email: ${agency.email}\n` +
        `Plan: ${agency.plan_type || 'starter'}\n` +
        `No card on file`
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
// EXPORTS
// ============================================================================
module.exports = {
  createAgencyCheckout,
  createAgencyPortal,
  handlePlatformStripeWebhook,
  getClientLimitForPlan,
  canAgencyAddClient,
  warnExpiringAgencyTrials,
  PLAN_DETAILS,
  convertToStripeAmount,
  getCurrencyCode,
  COUNTRY_CURRENCY_MAP
};