// ============================================================================
// STRIPE CONNECT - Clients Pay Agencies Directly
// UPDATED: expireTrials now DELETES VAPI phone number + assistant (frees slots)
// UPDATED: reactivation re-enables VAPI phone number
// UPDATED: Admin Stripe Connect notification wired to getSmsTemplate()
// FIXED: expireTrials verifies status update persisted before sending SMS
// UPDATED: 2026-05-08 — Per-client billing triggers on client status changes
// UPDATED: 2026-05-16 — expireTrials DELETES (not disables) VAPI resources
//          to free up phone number slots. Nulls out resource IDs in DB.
// UPDATED: 2026-05-22 — Client checkout: logging, explicit FK hint, pricing
//          defaults updated to $99/$149/$299
// UPDATED: 2026-06-03 — expireTrials now RELEASES the underlying Telnyx number
//          (via fullyReleaseNumber) before nulling vapi_phone_number. Deleting
//          only the VAPI object left the Telnyx rental billing monthly forever.
// UPDATED: 2026-06-08 — Phase 1 double-billing fix: createClientCheckout
//          rejects with 409 if client.stripe_connected_subscription_id already
//          points to an active|trialing|past_due Stripe subscription.
// UPDATED: 2026-06-10 — require_card_for_trial support:
//          (a) createTrialCheckoutForSignup creates a Stripe Connect Checkout
//              with trial_period_days=7 for card-required signups, called from
//              handleClientSignup in routes/client-signup.js.
//          (b) handleClientCheckoutCompleted detects trial-mode sessions
//              (subscription.status='trialing') and writes subscription_status
//              ='trial' (not 'active'), setting trial_ends_at from Stripe.
//              Sends welcome SMS when status flips from 'pending_payment'.
//          (c) expireTrials skips Stripe-managed trials via
//              .is('stripe_connected_subscription_id', null) so it only
//              touches DB-only trials.
//          (d) disconnectConnectAccount auto-sets require_card_for_trial=false
//              since the toggle is meaningless without Stripe Connect.
// UPDATED: 2026-07-11: getConnectFinancials (balance, payouts, and recent
//          charges for the agency Payments page) and createConnectAccountSession
//          (embedded Connect components, phase 2). Both are read-only against
//          the connected Express account via the stripeAccount header, so they
//          add no new money movement and change nothing in the existing flow.
// UPDATED: 2026-07-17: changeClientPlan (in-app upgrade/downgrade for an active
//          connected subscription). Swaps the subscription item to a fresh
//          target-plan price with proration and writes plan_type AND
//          monthly_call_limit in the same handler, so the two plan-defining
//          fields can no longer desync from Stripe. Fixes the dead end where
//          createClientCheckout 409s active clients to a portal that has no
//          plan-switch configured.
// ============================================================================
const Stripe = require('stripe');
const fetch = require('node-fetch');
const {
  supabase,
  getAgencyById,
  getAgencyByStripeAccountId,
  getClientByStripeConnectedCustomerId,
  getClientById
} = require('../lib/supabase');
const {
  sendEmail,
  sendWelcomeSMS,
  sendClientTrialExpiredSMS,
  sendClientPaymentFailedSMS,
  sendClientSubscriptionActivatedSMS,
  sendPlatformNotificationSMS
} = require('../lib/notifications');
const { enableAssistant, disableAssistant, disablePhoneNumber, enablePhoneNumber, fullyReleaseNumber } = require('../lib/vapi');
const { getSmsTemplate } = require('../lib/sms-templates');
const { updateClientBillingQuantity } = require('../lib/usage-tracker');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const VAPI_API_KEY = process.env.VAPI_API_KEY;

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Decode the caller's JWT (or null). Used by changeClientPlan to enforce that
// only the client themselves, the managing agency, or a super_admin can change
// a client's plan. Unlike checkout/portal, that endpoint mutates a live
// subscription and can charge a prorated difference, so it is not left open to
// an anonymous body-only caller.
function decodeToken(req) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch { return null; }
}

// ============================================================================
// COUNTRY → CURRENCY MAPPING
// ============================================================================
const countryCurrencyMap = {
  US: 'usd', CA: 'cad', GB: 'gbp', MX: 'mxn', BR: 'brl',
  AT: 'eur', BE: 'eur', CY: 'eur', EE: 'eur', FI: 'eur', FR: 'eur',
  DE: 'eur', GR: 'eur', IE: 'eur', IT: 'eur', LV: 'eur', LT: 'eur',
  LU: 'eur', MT: 'eur', NL: 'eur', PT: 'eur', SK: 'eur', SI: 'eur',
  ES: 'eur', HR: 'eur',
  BG: 'bgn', CZ: 'czk', DK: 'dkk', HU: 'huf', NO: 'nok',
  PL: 'pln', RO: 'ron', SE: 'sek', CH: 'chf',
  AU: 'aud', NZ: 'nzd', JP: 'jpy', SG: 'sgd', HK: 'hkd',
  MY: 'myr', TH: 'thb', IN: 'inr',
  AE: 'aed',
};

function getCurrencyForCountry(countryCode) {
  return countryCurrencyMap[countryCode] || 'usd';
}

// ============================================================================
// CREATE CONNECT ACCOUNT LINK
// ============================================================================
async function createConnectAccountLink(req, res) {
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

    console.log('Creating Stripe Connect account for:', agency.name, '| Country:', agency.country || 'US');

    let accountId = agency.stripe_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: agency.country || 'US',
        email: agency.email,
        metadata: { agency_id: agency_id },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });

      accountId = account.id;

      await supabase.from('agencies').update({ stripe_account_id: accountId }).eq('id', agency_id);
      console.log('Connect account created:', accountId, '| Country:', agency.country || 'US');
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.FRONTEND_URL}/agency/settings?tab=payments&refresh=true`,
      return_url: `${process.env.FRONTEND_URL}/agency/settings?tab=payments&success=true`,
      type: 'account_onboarding'
    });

    console.log('Connect onboarding link created');

    res.json({ success: true, url: accountLink.url, account_id: accountId });

  } catch (error) {
    console.error('Connect account error:', error);
    res.status(500).json({ error: 'Failed to create Connect account' });
  }
}

// ============================================================================
// GET CONNECT STATUS
// ============================================================================
async function getConnectStatus(req, res) {
  try {
    const { agencyId } = req.params;

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('stripe_account_id, stripe_onboarding_complete, stripe_charges_enabled, stripe_payouts_enabled')
      .eq('id', agencyId).single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.stripe_account_id) {
      return res.json({ connected: false, onboarding_complete: false, charges_enabled: false, payouts_enabled: false });
    }

    const account = await stripe.accounts.retrieve(agency.stripe_account_id);

    if (account.charges_enabled !== agency.stripe_charges_enabled || account.payouts_enabled !== agency.stripe_payouts_enabled) {
      await supabase.from('agencies').update({
        stripe_charges_enabled: account.charges_enabled,
        stripe_payouts_enabled: account.payouts_enabled,
        stripe_onboarding_complete: account.charges_enabled && account.payouts_enabled
      }).eq('id', agencyId);
    }

    res.json({
      connected: true, account_id: agency.stripe_account_id,
      onboarding_complete: account.charges_enabled && account.payouts_enabled,
      charges_enabled: account.charges_enabled, payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted
    });

  } catch (error) {
    console.error('Connect status error:', error);
    res.status(500).json({ error: 'Failed to get Connect status' });
  }
}

// ============================================================================
// GET CONNECT FINANCIALS
// ----------------------------------------------------------------------------
// Powers the agency Payments page. Under direct charges the money (balance,
// payouts, customers, charges) all live on the connected Express account, so
// everything here is read with the stripeAccount header. Nothing is written.
//
// Returns:
//   available / pending / instant_available : per-currency balance arrays
//     (usually a single currency). Amounts are in the smallest unit.
//   payout_schedule : { interval, delay_days, weekly_anchor, monthly_anchor }
//   next_payout     : earliest not-yet-settled payout (pending | in_transit)
//   recent_payouts  : last 8 payouts (paid | pending | in_transit | ...)
//   recent_charges  : last 10 charges with light customer info for a
//                     "recent client payments" list
// ============================================================================
async function getConnectFinancials(req, res) {
  try {
    const { agencyId } = req.params;

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('stripe_account_id, currency, display_currency')
      .eq('id', agencyId)
      .single();

    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });
    if (!agency.stripe_account_id) return res.json({ connected: false });

    const acct = agency.stripe_account_id;

    const [balance, payoutList, chargeList, account] = await Promise.all([
      stripe.balance.retrieve({ stripeAccount: acct }),
      stripe.payouts.list({ limit: 8 }, { stripeAccount: acct }),
      stripe.charges.list({ limit: 10 }, { stripeAccount: acct }),
      stripe.accounts.retrieve(acct),
    ]);

    const mapAmounts = (arr) => (arr || []).map((b) => ({ amount: b.amount, currency: b.currency }));

    const payouts = (payoutList.data || []).map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status, // paid | pending | in_transit | canceled | failed
      arrival_date: p.arrival_date ? p.arrival_date * 1000 : null,
      created: p.created ? p.created * 1000 : null,
    }));

    // Next payout = earliest payout not yet settled.
    const upcoming = payouts
      .filter((p) => p.status === 'pending' || p.status === 'in_transit')
      .sort((a, b) => (a.arrival_date || 0) - (b.arrival_date || 0));

    const charges = (chargeList.data || []).map((c) => ({
      id: c.id,
      amount: c.amount,
      currency: c.currency,
      status: c.status, // succeeded | pending | failed
      paid: c.paid,
      refunded: c.refunded,
      created: c.created ? c.created * 1000 : null,
      customer_name: c.billing_details?.name || null,
      customer_email: c.billing_details?.email || c.receipt_email || null,
      description: c.description || null,
    }));

    res.json({
      connected: true,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      display_currency: agency.display_currency || agency.currency || 'usd',
      available: mapAmounts(balance.available),
      pending: mapAmounts(balance.pending),
      instant_available: mapAmounts(balance.instant_available),
      payout_schedule: account.settings?.payouts?.schedule || null,
      next_payout: upcoming[0] || null,
      recent_payouts: payouts,
      recent_charges: charges,
    });
  } catch (error) {
    console.error('Connect financials error:', error);
    res.status(500).json({ error: 'Failed to load financials' });
  }
}

// ============================================================================
// CREATE CONNECT ACCOUNT SESSION (embedded components, phase 2)
// ----------------------------------------------------------------------------
// Mints an AccountSession client_secret for Stripe's embedded Connect
// components (Balances, Payouts, Payments) rendered inside the agency
// dashboard, replacing the hosted Express Dashboard experience. Not used by
// the cards-only Payments page; wired ahead of time so phase 2 is a frontend
// only change. Some components may need enabling under Connect settings in the
// Stripe Dashboard before they render.
// ============================================================================
async function createConnectAccountSession(req, res) {
  try {
    const { agencyId } = req.params;

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('stripe_account_id')
      .eq('id', agencyId)
      .single();

    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });
    if (!agency.stripe_account_id) return res.status(400).json({ error: 'Stripe not connected' });

    const session = await stripe.accountSessions.create({
      account: agency.stripe_account_id,
      components: {
        payments: { enabled: true, features: { refund_management: true, dispute_management: true, capture_payments: true } },
        payouts: { enabled: true, features: { instant_payouts: true, standard_payouts: true, edit_payout_schedule: true } },
        balances: { enabled: true, features: { instant_payouts: true, standard_payouts: true, edit_payout_schedule: true } },
        account_management: { enabled: true },
        notification_banner: { enabled: true },
      },
    });

    res.json({ client_secret: session.client_secret });
  } catch (error) {
    console.error('Account session error:', error);
    res.status(500).json({ error: 'Failed to create account session' });
  }
}

// ============================================================================
// DISCONNECT CONNECT ACCOUNT
// ----------------------------------------------------------------------------
// Also disables require_card_for_trial since the toggle is meaningless without
// Stripe Connect. Without this, an agency could disconnect Stripe and then
// the embed widget would throw 500 trying to create a checkout session.
// ============================================================================
async function disconnectConnectAccount(req, res) {
  try {
    const { agencyId } = req.params;

    if (!agencyId) {
      return res.status(400).json({ error: 'agencyId required' });
    }

    const { data: agency, error: fetchError } = await supabase
      .from('agencies').select('stripe_account_id, name').eq('id', agencyId).single();

    if (fetchError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.stripe_account_id) {
      return res.status(400).json({ error: 'No Stripe account connected' });
    }

    console.log('Disconnecting Stripe Connect for:', agency.name);

    const { error: updateError } = await supabase.from('agencies').update({
      stripe_account_id: null,
      stripe_onboarding_complete: false,
      stripe_charges_enabled: false,
      stripe_payouts_enabled: false,
      require_card_for_trial: false, // auto-disable, meaningless without Connect
      updated_at: new Date().toISOString()
    }).eq('id', agencyId);

    if (updateError) {
      console.error('Failed to update agency:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect account' });
    }

    console.log('Stripe Connect disconnected for:', agency.name);
    res.json({ success: true, message: 'Stripe account disconnected' });

  } catch (error) {
    console.error('Disconnect Connect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Stripe account' });
  }
}

// ============================================================================
// CREATE TRIAL CHECKOUT FOR SIGNUP (card-required trial mode)
// ----------------------------------------------------------------------------
// Called from handleClientSignup in routes/client-signup.js when the agency
// has require_card_for_trial=true. Creates a Stripe Connect Checkout session
// with trial_period_days=7. Client enters card, gets 7-day free trial, Stripe
// auto-charges at trial end.
//
// On success, the subsequent checkout.session.completed webhook fires
// handleClientCheckoutCompleted below, which detects the trialing status and
// transitions the client from 'pending_payment' to 'trial' (not 'active').
//
// Mirrors createClientCheckout structure but adds trial_period_days and uses
// different status_url paths since this is a fresh signup, not an upgrade.
//
// Returns: { url } on success, throws on error. Caller handles errors.
// ============================================================================
async function createTrialCheckoutForSignup({ client, agency, plan }) {
  if (!agency.stripe_account_id || !agency.stripe_charges_enabled) {
    throw new Error('Agency Stripe Connect not configured');
  }

  const priceAmounts = {
    starter: agency.price_starter || 9900,
    pro: agency.price_pro || 14900,
    growth: agency.price_growth || 29900,
  };
  const callLimits = {
    starter: agency.limit_starter || 50,
    pro: agency.limit_pro || 150,
    growth: agency.limit_growth || 500,
  };
  const priceAmount = priceAmounts[plan];
  if (!priceAmount) throw new Error(`Invalid plan: ${plan}`);

  const currency = getCurrencyForCountry(agency.country || 'US');

  // Create customer on the connected account
  let connectedCustomerId = client.stripe_connected_customer_id;
  if (!connectedCustomerId) {
    const customer = await stripe.customers.create({
      email: client.email,
      name: client.owner_name || client.business_name,
      metadata: { client_id: client.id, business_name: client.business_name },
    }, { stripeAccount: agency.stripe_account_id });
    connectedCustomerId = customer.id;

    await supabase
      .from('clients')
      .update({ stripe_connected_customer_id: connectedCustomerId })
      .eq('id', client.id);
  }

  // Create product + price on connected account (per-client pricing matches createClientCheckout)
  const product = await stripe.products.create({
    name: `AI Receptionist - ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
    metadata: { client_id: client.id, plan },
  }, { stripeAccount: agency.stripe_account_id });

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: priceAmount,
    currency,
    recurring: { interval: 'month' },
  }, { stripeAccount: agency.stripe_account_id });

  const agencyUrl = agency.marketing_domain && agency.domain_verified
    ? `https://${agency.marketing_domain}`
    : `https://${agency.slug}.myvoiceaiconnect.com`;

  const session = await stripe.checkout.sessions.create({
    customer: connectedCustomerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: `${agencyUrl}/client/welcome?trial=started`,
    cancel_url: `${agencyUrl}/client/signup?canceled=true`,
    metadata: {
      client_id: client.id,
      agency_id: agency.id,
      plan,
      call_limit: callLimits[plan].toString(),
      type: 'trial_signup', // distinguishes from upgrade-mode checkouts
    },
    subscription_data: {
      trial_period_days: 7,
      metadata: { client_id: client.id, agency_id: agency.id, plan, type: 'trial_signup' },
    },
  }, { stripeAccount: agency.stripe_account_id });

  console.log(`✅ Trial checkout created for client ${client.id}: session ${session.id}, plan ${plan}, currency ${currency}`);
  return { url: session.url, sessionId: session.id };
}

// ============================================================================
// CREATE CLIENT CHECKOUT (upgrade flow, used by /api/client/checkout)
// UPDATED 2026-06-08 — Phase 1 active-subscription guard.
// ============================================================================
async function createClientCheckout(req, res) {
  try {
    const { client_id, plan } = req.body;

    if (!client_id || !plan) {
      return res.status(400).json({ error: 'Missing required fields', required: ['client_id', 'plan'] });
    }

    console.log('🛒 Client checkout attempt:', { client_id, plan });

    const { data: client, error: clientError } = await supabase
      .from('clients').select('*, agencies!clients_agency_id_fkey(*)').eq('id', client_id).single();

    if (clientError || !client) {
      console.error('❌ Client checkout lookup failed:', { client_id, error: clientError?.message, code: clientError?.code, details: clientError?.details });
      return res.status(404).json({ error: 'Client not found' });
    }

    const agency = client.agencies;
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    if (!agency.stripe_account_id || !agency.stripe_charges_enabled) {
      return res.status(400).json({ error: 'Agency has not completed Stripe Connect setup' });
    }

    // Phase 1 active-subscription guard
    if (client.stripe_connected_subscription_id) {
      try {
        const existingSub = await stripe.subscriptions.retrieve(
          client.stripe_connected_subscription_id,
          { stripeAccount: agency.stripe_account_id }
        );
        if (['active', 'trialing', 'past_due'].includes(existingSub.status)) {
          console.log(`🚫 Blocked duplicate checkout for client ${client_id}: existing sub ${existingSub.id} (${existingSub.status})`);
          return res.status(409).json({
            error: 'active_subscription_exists',
            message: 'You already have an active subscription. Use the billing portal to change plans.',
            existing_subscription_id: existingSub.id,
            existing_status: existingSub.status,
          });
        }
      } catch (subErr) {
        if (subErr.code !== 'resource_missing') {
          console.error('Existing-sub lookup failed:', subErr);
          throw subErr;
        }
        console.warn(`Stale stripe_connected_subscription_id ${client.stripe_connected_subscription_id} for client ${client_id} — proceeding with fresh checkout`);
      }
    }

    console.log('Creating client checkout for:', client.email, 'via agency:', agency.name);

    const priceAmounts = { starter: agency.price_starter || 9900, pro: agency.price_pro || 14900, growth: agency.price_growth || 29900 };
    const callLimits = { starter: agency.limit_starter || 50, pro: agency.limit_pro || 150, growth: agency.limit_growth || 500 };
    const priceAmount = priceAmounts[plan];
    if (!priceAmount) return res.status(400).json({ error: 'Invalid plan' });

    const currency = getCurrencyForCountry(agency.country || 'US');

    let connectedCustomerId = client.stripe_connected_customer_id;

    if (!connectedCustomerId) {
      const customer = await stripe.customers.create({
        email: client.email, name: client.owner_name || client.business_name,
        metadata: { client_id: client_id, business_name: client.business_name }
      }, { stripeAccount: agency.stripe_account_id });

      connectedCustomerId = customer.id;
      await supabase.from('clients').update({ stripe_connected_customer_id: connectedCustomerId }).eq('id', client_id);
    }

    const product = await stripe.products.create({
      name: `AI Receptionist - ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
      metadata: { client_id, plan }
    }, { stripeAccount: agency.stripe_account_id });

    const price = await stripe.prices.create({
      product: product.id, unit_amount: priceAmount, currency: currency,
      recurring: { interval: 'month' }
    }, { stripeAccount: agency.stripe_account_id });

    const agencyUrl = agency.marketing_domain && agency.domain_verified
      ? `https://${agency.marketing_domain}`
      : `https://${agency.slug}.myvoiceaiconnect.com`;

    const session = await stripe.checkout.sessions.create({
      customer: connectedCustomerId, mode: 'subscription', payment_method_types: ['card'],
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${agencyUrl}/client/dashboard?upgrade=success`,
      cancel_url: `${agencyUrl}/client/upgrade-required?canceled=true`,
      metadata: { client_id, agency_id: agency.id, plan, call_limit: callLimits[plan].toString(), type: 'client_subscription' },
      subscription_data: { metadata: { client_id, agency_id: agency.id, plan } }
    }, { stripeAccount: agency.stripe_account_id });

    console.log('✅ Client checkout created:', session.id, '| Currency:', currency, '| Amount:', priceAmount);
    res.json({ success: true, sessionId: session.id, url: session.url });

  } catch (error) {
    console.error('❌ Client checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

// ============================================================================
// CREATE CLIENT PORTAL
// ============================================================================
async function createClientPortal(req, res) {
  try {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const client = await getClientById(client_id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.stripe_connected_customer_id) return res.status(400).json({ error: 'No Stripe customer found' });

    const agency = client.agencies;
    if (!agency?.stripe_account_id) return res.status(400).json({ error: 'Agency Connect not configured' });

    const agencyUrl = agency.marketing_domain && agency.domain_verified
      ? `https://${agency.marketing_domain}`
      : `https://${agency.slug}.myvoiceaiconnect.com`;

    const session = await stripe.billingPortal.sessions.create({
      customer: client.stripe_connected_customer_id,
      return_url: `${agencyUrl}/client/billing`
    }, { stripeAccount: agency.stripe_account_id });

    res.json({ success: true, url: session.url });

  } catch (error) {
    console.error('Client portal error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
}

// ============================================================================
// CHANGE CLIENT PLAN (in-app upgrade/downgrade for an ACTIVE subscription)
// ----------------------------------------------------------------------------
// Fixes the plan-change dead end. createClientCheckout 409s any client that
// already has an active|trialing|past_due connected subscription and tells them
// to use the billing portal, but the portal has no plan-switch configured (and
// prices are created ad hoc per checkout, so there is no catalog for it to
// switch between). handleClientSubscriptionUpdated also never writes plan_type
// or monthly_call_limit. Net effect before this: an active client cannot change
// plans at all.
//
// This endpoint changes the plan directly on the connected subscription:
//   1. Verifies the caller owns the client (client themselves, managing agency,
//      or super_admin). This moves money, so it is not left open.
//   2. Confirms the client has a changeable connected subscription.
//   3. Creates a fresh product + price for the target plan on the connected
//      account (same ad-hoc pattern as createClientCheckout; no stable catalog).
//   4. Swaps the subscription's single item to the new price with
//      proration_behavior 'create_prorations' (the prorated difference settles
//      on the next invoice; during a trial there is no immediate charge and the
//      new price applies at trial end).
//   5. Writes plan_type AND monthly_call_limit in the SAME handler, so the two
//      fields that define the plan can never desync from Stripe again.
//
// The resulting customer.subscription.updated webhook fires
// handleClientSubscriptionUpdated, which only touches status fields and so does
// not clobber the plan_type/limit written here. Usage (calls_this_month) is left
// as-is: a mid-cycle plan change should not wipe the month's count.
// ============================================================================
async function changeClientPlan(req, res) {
  try {
    const { client_id, plan } = req.body;

    if (!client_id || !plan) {
      return res.status(400).json({ error: 'Missing required fields', required: ['client_id', 'plan'] });
    }

    const VALID_PLANS = ['starter', 'pro', 'growth'];
    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan', valid_plans: VALID_PLANS });
    }

    // Auth: this endpoint mutates a live subscription and can charge a prorated
    // difference, so require a valid token whose owner is allowed to act on this
    // client. Allowed: super_admin, the client itself (clientId match), or the
    // managing agency (agencyId match).
    const decoded = decodeToken(req);
    if (!decoded) return res.status(401).json({ error: 'Authentication required' });

    const { data: client, error: clientError } = await supabase
      .from('clients').select('*, agencies!clients_agency_id_fkey(*)').eq('id', client_id).single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const isSuperAdmin = decoded.role === 'super_admin';
    const isOwnClient = decoded.clientId && decoded.clientId === client.id;
    const isManagingAgency = decoded.agencyId && decoded.agencyId === client.agency_id;
    if (!isSuperAdmin && !isOwnClient && !isManagingAgency) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const agency = client.agencies;
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    if (!agency.stripe_account_id || !agency.stripe_charges_enabled) {
      return res.status(400).json({ error: 'Agency has not completed Stripe Connect setup' });
    }

    // No connected subscription => nothing to change. These clients (no-card
    // trial, expired, canceled) start a fresh subscription via checkout instead.
    if (!client.stripe_connected_subscription_id) {
      return res.status(400).json({
        error: 'no_active_subscription',
        message: 'This account does not have an active subscription to change. Please choose a plan to subscribe.',
      });
    }

    // Already on this plan => no-op.
    if (client.plan_type === plan) {
      return res.status(200).json({ success: true, unchanged: true, plan, message: 'You are already on this plan.' });
    }

    // Retrieve the live subscription and confirm it is in a changeable state.
    let subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(
        client.stripe_connected_subscription_id,
        { stripeAccount: agency.stripe_account_id }
      );
    } catch (subErr) {
      if (subErr.code === 'resource_missing') {
        return res.status(400).json({
          error: 'no_active_subscription',
          message: 'Your subscription could not be found. Please choose a plan to subscribe.',
        });
      }
      throw subErr;
    }

    if (!['active', 'trialing', 'past_due'].includes(subscription.status)) {
      return res.status(400).json({
        error: 'subscription_not_changeable',
        message: 'Your subscription is not in a state that can be changed. Please contact support.',
        status: subscription.status,
      });
    }

    const currentItem = subscription.items?.data?.[0];
    if (!currentItem) {
      return res.status(400).json({ error: 'Subscription has no billable item to change' });
    }

    // Target price + call limit (same defaults as createClientCheckout).
    const priceAmounts = { starter: agency.price_starter || 9900, pro: agency.price_pro || 14900, growth: agency.price_growth || 29900 };
    const callLimits = { starter: agency.limit_starter || 50, pro: agency.limit_pro || 150, growth: agency.limit_growth || 500 };
    const priceAmount = priceAmounts[plan];
    const callLimit = callLimits[plan];
    const currency = getCurrencyForCountry(agency.country || 'US');

    // Fresh product + price for the target plan on the connected account.
    const product = await stripe.products.create({
      name: `AI Receptionist - ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
      metadata: { client_id, plan },
    }, { stripeAccount: agency.stripe_account_id });

    const price = await stripe.prices.create({
      product: product.id, unit_amount: priceAmount, currency,
      recurring: { interval: 'month' },
    }, { stripeAccount: agency.stripe_account_id });

    // Swap the single subscription item to the new price. create_prorations
    // credits/debits the difference on the next invoice; during a trial this
    // produces no immediate charge and the new price applies at trial end.
    await stripe.subscriptions.update(
      client.stripe_connected_subscription_id,
      {
        items: [{ id: currentItem.id, price: price.id }],
        proration_behavior: 'create_prorations',
        metadata: { client_id, agency_id: agency.id, plan },
      },
      { stripeAccount: agency.stripe_account_id }
    );

    // Write BOTH plan-defining fields in the same handler. This is the actual
    // fix: plan_type and monthly_call_limit can no longer drift from Stripe.
    const { error: updateError } = await supabase
      .from('clients')
      .update({ plan_type: plan, monthly_call_limit: callLimit })
      .eq('id', client.id);

    if (updateError) {
      console.error('❌ Plan change: Stripe updated but DB write failed:', updateError.message);
      return res.status(500).json({ error: 'Plan changed in billing but failed to update your account. Please contact support.' });
    }

    console.log(`✅ Client ${client.id} plan changed ${client.plan_type} -> ${plan} (limit ${callLimit})`);
    res.json({ success: true, plan, monthly_call_limit: callLimit });

  } catch (error) {
    console.error('❌ Change plan error:', error);
    res.status(500).json({ error: 'Failed to change plan' });
  }
}

// ============================================================================
// EXPIRE TRIALS (DB-only trials)
// ----------------------------------------------------------------------------
// UPDATED 2026-05-16: DELETES VAPI phone + assistant, frees slots
// UPDATED 2026-06-03: RELEASES underlying Telnyx number
// UPDATED 2026-06-10: Skips Stripe-managed trials. When an agency has
//   require_card_for_trial=true, the client has a Stripe Connect subscription
//   whose trial Stripe converts automatically via invoice.payment_succeeded
//   (or invoice.payment_failed). The DB-only cron must not touch those.
//   Filter: stripe_connected_subscription_id IS NULL.
// ============================================================================
async function expireTrials() {
  console.log('Checking for expired trials...');

  const now = new Date().toISOString();

  const { data: expiredClients, error } = await supabase
    .from('clients')
    .select('*, agencies!clients_agency_id_fkey(*)')
    .in('subscription_status', ['trial', 'trialing'])
    .is('stripe_connected_subscription_id', null) // skip Stripe-managed trials
    .lt('trial_ends_at', now);

  if (error) { console.error('Error fetching expired trials:', error); return { success: false, error: error.message }; }

  console.log(`Found ${expiredClients?.length || 0} expired trials (DB-only)`);

  const results = [];

  for (const client of expiredClients || []) {
    try {
      // ── RELEASE the phone number: delete VAPI + release Telnyx ──
      if (client.vapi_phone_id || client.vapi_phone_number) {
        try {
          const release = await fullyReleaseNumber(client.vapi_phone_id, client.vapi_phone_number);
          console.log(`📞 Release ${client.business_name}: VAPI=${release.vapiDeleted} Telnyx=${release.telnyxReleased}`);
          if (!release.telnyxReleased) {
            console.error(`⚠️ Telnyx NOT released for ${client.business_name} (${client.vapi_phone_number}) — orphan sweep will catch it`);
          }
        } catch (relErr) {
          console.error('❌ Number release failed:', relErr.message);
          if (client.vapi_phone_id) { try { await disablePhoneNumber(client.vapi_phone_id); } catch {} }
        }
      }

      // ── DELETE VAPI assistant ──
      if (client.vapi_assistant_id && VAPI_API_KEY) {
        try {
          const asstRes = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
          });
          if (asstRes.ok || asstRes.status === 404) {
            console.log('✅ VAPI assistant DELETED:', client.vapi_assistant_id);
          } else {
            try { await disableAssistant(client.vapi_assistant_id); } catch {}
          }
        } catch (vapiError) {
          console.error('⚠️ Failed to delete VAPI assistant:', vapiError.message);
          try { await disableAssistant(client.vapi_assistant_id); } catch {}
        }
      }

      // ── Update status + null out VAPI resource IDs ──
      //    Also null phone_number + phone_area_code. The number was just
      //    released back to Telnyx's pool, so this dead row must stop claiming
      //    it. The clients_phone_number_key unique constraint sits on
      //    phone_number, and leaving it populated makes the released number
      //    un-reassignable when Telnyx recycles it into a future signup (23505).
      const { error: updateError } = await supabase
        .from('clients')
        .update({
          subscription_status: 'trial_expired',
          status: 'expired',
          vapi_phone_id: null,
          vapi_phone_number: null,
          vapi_assistant_id: null,
          phone_number: null,
          phone_area_code: null,
        })
        .eq('id', client.id);

      if (updateError) {
        console.error('❌ Failed to update client status:', client.business_name, updateError);
        results.push({ id: client.id, business_name: client.business_name, success: false, error: updateError.message });
        continue;
      }

      // ── Verify update persisted (RLS check) ──
      const { data: verifyClient } = await supabase
        .from('clients')
        .select('subscription_status')
        .eq('id', client.id)
        .single();

      if (verifyClient?.subscription_status !== 'trial_expired') {
        console.error('❌ Status update did not persist for:', client.business_name,
          '— still:', verifyClient?.subscription_status,
          '(likely RLS policy blocking the update)');
        results.push({ id: client.id, business_name: client.business_name, success: false, error: 'Update did not persist — check RLS policies on clients table' });
        continue;
      }

      // ── Send SMS after confirmed status change ──
      const agency = client.agencies;
      await sendClientTrialExpiredSMS(client, agency);

      // ── Update agency per-client billing (decrease quantity) ──
      try { await updateClientBillingQuantity(client.agency_id); } catch (e) { console.warn('⚠️ Billing quantity update failed:', e.message); }

      console.log('✅ Trial expired + VAPI resources released for:', client.business_name);
      results.push({ id: client.id, business_name: client.business_name, success: true });

    } catch (err) {
      console.error('Error expiring trial for', client.id, err);
      results.push({ id: client.id, business_name: client.business_name, success: false, error: err.message });
    }
  }

  return { success: true, processed: results.length, results };
}

// ============================================================================
// WEBHOOK HANDLER - Connected Account Events
// ============================================================================
async function handleConnectStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_CONNECT_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Connect webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Connect webhook:', event.type, '| Account:', event.account);

  try {
    switch (event.type) {
      case 'account.updated': await handleAccountUpdated(event.data.object); break;
      case 'checkout.session.completed': await handleClientCheckoutCompleted(event.data.object, event.account); break;
      case 'customer.subscription.updated': await handleClientSubscriptionUpdated(event.data.object, event.account); break;
      case 'customer.subscription.deleted': await handleClientSubscriptionDeleted(event.data.object, event.account); break;
      case 'invoice.payment_succeeded': await handleClientPaymentSucceeded(event.data.object, event.account); break;
      case 'invoice.payment_failed': await handleClientPaymentFailed(event.data.object, event.account); break;
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Connect webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// ============================================================================
// CONNECT WEBHOOK HANDLERS
// ============================================================================

async function handleAccountUpdated(account) {
  console.log('Connect account updated:', account.id);

  const agency = await getAgencyByStripeAccountId(account.id);
  if (!agency) return;

  await supabase.from('agencies').update({
    stripe_charges_enabled: account.charges_enabled,
    stripe_payouts_enabled: account.payouts_enabled,
    stripe_onboarding_complete: account.charges_enabled && account.payouts_enabled
  }).eq('id', agency.id);

  if (account.charges_enabled && !agency.stripe_charges_enabled) {
    console.log('Agency can now accept payments:', agency.name);

    const stripeMsg = await getSmsTemplate('admin_agency_stripe_connected', {
      name: agency.name,
      email: agency.email || 'N/A',
      plan: agency.plan_type || 'starter',
    });
    sendPlatformNotificationSMS(
      stripeMsg || `Agency Connected Stripe\nName: ${agency.name}\nEmail: ${agency.email || 'N/A'}\nPlan: ${agency.plan_type || 'starter'}\nReady to accept client payments`
    ).catch(err => console.error('Failed to send Stripe connect notification:', err));
  }
}

// ----------------------------------------------------------------------------
// handleClientCheckoutCompleted
// ----------------------------------------------------------------------------
// Two flows converge here:
//
//   1. UPGRADE: client was on a no-card DB trial (or expired/canceled), went
//      to /client/upgrade-required, picked a plan, completed Stripe checkout
//      with no trial. We set subscription_status='active' immediately.
//
//   2. CARD-REQUIRED TRIAL SIGNUP: client filled embed widget on agency with
//      require_card_for_trial=true. Backend set client to 'pending_payment'
//      and created a Stripe checkout with trial_period_days=7. Client entered
//      card. We must set subscription_status='trial' (not 'active') with
//      trial_ends_at from Stripe, and send the welcome SMS now (deferred at
//      signup since they hadn't paid yet).
//
// Discriminator: retrieve the subscription, check status. 'trialing' = card-
// required trial signup. 'active' (or anything else) = upgrade flow.
// ----------------------------------------------------------------------------
async function handleClientCheckoutCompleted(session, stripeAccountId) {
  console.log('Client checkout completed:', session.id);

  const clientId = session.metadata?.client_id;
  const plan = session.metadata?.plan || 'starter';
  const callLimit = parseInt(session.metadata?.call_limit) || 50;
  if (!clientId) { console.error('No client_id in checkout metadata'); return; }

  const { data: client, error } = await supabase
    .from('clients').select('*, agencies!clients_agency_id_fkey(*)').eq('id', clientId).single();
  if (error || !client) { console.error('Client not found:', clientId); return; }

  const wasPendingPayment = client.subscription_status === 'pending_payment';
  const isUpgrade = client.subscription_status === 'trial_expired'
    || client.subscription_status === 'canceled'
    || client.subscription_status === 'past_due';

  // Inspect subscription to know if Stripe started it in trialing or active
  let subStatus = 'active';
  let subTrialEnd = null;
  if (session.subscription) {
    try {
      const sub = await stripe.subscriptions.retrieve(session.subscription, { stripeAccount: stripeAccountId });
      subStatus = sub.status; // 'trialing' or 'active' typically
      subTrialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
    } catch (subErr) {
      console.error('Failed to retrieve subscription for status check:', subErr.message);
      // Fall back to assuming active so we don't block activation
    }
  }

  const isTrialing = subStatus === 'trialing' && subTrialEnd;
  const dbStatus = isTrialing ? 'trial' : 'active';

  const { error: updateError } = await supabase.from('clients').update({
    subscription_status: dbStatus,
    plan_type: plan,
    monthly_call_limit: callLimit,
    stripe_connected_subscription_id: session.subscription,
    trial_ends_at: isTrialing ? subTrialEnd : null,
    status: 'active',
    calls_this_month: 0,
  }).eq('id', clientId);

  if (updateError) { console.error('Failed to update client:', updateError); return; }

  console.log(`Client ${wasPendingPayment ? 'trial-activated' : (isUpgrade ? 'upgraded' : 'activated')}:`, client.business_name, `(${dbStatus})`);

  // Update agency per-client billing
  try { await updateClientBillingQuantity(client.agency_id); } catch (e) { console.warn('⚠️ Billing quantity update failed:', e.message); }

  // Re-enable VAPI resources (idempotent if they were never disabled)
  if (client.vapi_phone_id) {
    try { await enablePhoneNumber(client.vapi_phone_id); console.log('✅ VAPI phone number enabled:', client.vapi_phone_id); }
    catch (phoneError) { console.error('❌ Failed to enable VAPI phone number:', phoneError.message); }
  }

  if (client.vapi_assistant_id) {
    try { await enableAssistant(client.vapi_assistant_id); console.log('✅ VAPI assistant enabled:', client.vapi_assistant_id); }
    catch (vapiError) { console.error('⚠️ Failed to enable VAPI assistant (non-critical):', vapiError.message); }
  }

  // Record payment if Stripe collected money on this session (not for trial signups, amount_total=0)
  if (session.amount_total > 0) {
    await supabase.from('payments').insert({
      client_id: clientId, agency_id: client.agency_id, stripe_payment_intent_id: session.payment_intent,
      stripe_subscription_id: session.subscription, amount: session.amount_total,
      currency: session.currency || 'usd', status: 'succeeded', type: 'subscription',
      description: `${isUpgrade ? 'Upgrade' : 'Initial'} subscription - ${plan} plan`,
      plan_type: plan, paid_out: false
    });
    console.log(`Payment recorded: ${session.currency?.toUpperCase() || 'USD'} ${(session.amount_total / 100).toFixed(2)}`);
  }

  const agency = client.agencies;

  // Card-required trial signups: send the welcome SMS NOW since it was
  // deferred at signup time (we didn't know if they'd complete checkout).
  if (wasPendingPayment && client.owner_phone && client.vapi_phone_number) {
    try {
      await sendWelcomeSMS(client.owner_phone, client.business_name, client.vapi_phone_number, agency);
      console.log('✅ Deferred welcome SMS sent to', client.owner_phone);
    } catch (e) {
      console.error('Failed to send deferred welcome SMS:', e.message);
    }
  }

  // Always send the subscription-activated notification (this is a different
  // message from the welcome SMS and goes to the client either way).
  await sendClientSubscriptionActivatedSMS(client, agency, plan);
}

async function handleClientSubscriptionUpdated(subscription, stripeAccountId) {
  console.log('Client subscription updated:', subscription.id);

  const client = await getClientByStripeConnectedCustomerId(subscription.customer, stripeAccountId);
  if (!client) return;

  let status = subscription.status;
  let clientStatus = client.status;

  if (status === 'active') {
    clientStatus = 'active';
    if (client.vapi_phone_id) { await enablePhoneNumber(client.vapi_phone_id).catch(err => console.error('Failed to enable phone:', err.message)); }
    if (client.vapi_assistant_id) { await enableAssistant(client.vapi_assistant_id); }
  } else if (status === 'canceled' || status === 'unpaid') {
    clientStatus = 'cancelled';
    if (client.vapi_phone_id) { await disablePhoneNumber(client.vapi_phone_id).catch(err => console.error('Failed to disable phone:', err.message)); }
    if (client.vapi_assistant_id) { await disableAssistant(client.vapi_assistant_id); }
  }

  // Map Stripe 'trialing' to our 'trial' for consistency with DB-only trials.
  // Other statuses ('active', 'canceled', 'past_due', etc.) pass through.
  const dbSubStatus = status === 'trialing' ? 'trial' : status;

  await supabase.from('clients').update({
    subscription_status: dbSubStatus, status: clientStatus,
    trial_ends_at: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null
  }).eq('id', client.id);

  // Update agency per-client billing when client status changes
  try { await updateClientBillingQuantity(client.agency_id); } catch (e) { console.warn('⚠️ Billing quantity update failed:', e.message); }
}

async function handleClientSubscriptionDeleted(subscription, stripeAccountId) {
  console.log('Client subscription deleted:', subscription.id);
  const client = await getClientByStripeConnectedCustomerId(subscription.customer, stripeAccountId);
  if (!client) return;

  if (client.vapi_phone_id) {
    try { await disablePhoneNumber(client.vapi_phone_id); console.log('✅ VAPI phone number disabled:', client.vapi_phone_id); }
    catch (phoneError) { console.error('❌ Failed to disable VAPI phone number:', phoneError.message); }
  }
  if (client.vapi_assistant_id) {
    try { await disableAssistant(client.vapi_assistant_id); console.log('✅ VAPI assistant disabled:', client.vapi_assistant_id); }
    catch (vapiError) { console.error('Failed to disable VAPI assistant:', vapiError); }
  }

  await supabase.from('clients').update({ subscription_status: 'canceled', status: 'cancelled' }).eq('id', client.id);

  // Update agency per-client billing (decrease quantity)
  try { await updateClientBillingQuantity(client.agency_id); } catch (e) { console.warn('⚠️ Billing quantity update failed:', e.message); }
}

async function handleClientPaymentSucceeded(invoice, stripeAccountId) {
  console.log('Client payment succeeded:', invoice.id);
  const client = await getClientByStripeConnectedCustomerId(invoice.customer, stripeAccountId);
  if (!client) { console.error('Client not found for payment:', invoice.customer); return; }

  await supabase.from('clients').update({ subscription_status: 'active', status: 'active', calls_this_month: 0 }).eq('id', client.id);

  if (client.vapi_phone_id) {
    try { await enablePhoneNumber(client.vapi_phone_id); } catch (phoneError) { console.error('Failed to enable VAPI phone number:', phoneError.message); }
  }
  if (client.vapi_assistant_id) {
    try { await enableAssistant(client.vapi_assistant_id); } catch (vapiError) { console.error('Failed to enable VAPI assistant:', vapiError); }
  }

  await supabase.from('payments').insert({
    client_id: client.id, agency_id: client.agency_id, stripe_invoice_id: invoice.id,
    stripe_payment_intent_id: invoice.payment_intent, stripe_charge_id: invoice.charge,
    stripe_subscription_id: invoice.subscription, amount: invoice.amount_paid || 0,
    currency: invoice.currency || 'usd', status: 'succeeded', type: 'subscription',
    description: invoice.lines?.data?.[0]?.description || 'Subscription payment',
    plan_type: client.plan_type, paid_out: false
  });
  console.log(`Payment recorded: ${(invoice.currency || 'usd').toUpperCase()} ${((invoice.amount_paid || 0) / 100).toFixed(2)}`);
}

async function handleClientPaymentFailed(invoice, stripeAccountId) {
  console.log('Client payment failed:', invoice.id);
  const client = await getClientByStripeConnectedCustomerId(invoice.customer, stripeAccountId);
  if (!client) return;
  await supabase.from('clients').update({ subscription_status: 'past_due' }).eq('id', client.id);
  const agency = client.agencies;
  await sendClientPaymentFailedSMS(client, agency, invoice.hosted_invoice_url);
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  createConnectAccountLink,
  getConnectStatus,
  getConnectFinancials,          // NEW: agency Payments page (balance, payouts, charges)
  createConnectAccountSession,   // NEW: embedded Connect components (phase 2)
  disconnectConnectAccount,
  createClientCheckout,
  createTrialCheckoutForSignup, // NEW: called from routes/client-signup.js
  createClientPortal,
  changeClientPlan,             // NEW: in-app plan change for active subscriptions
  handleConnectStripeWebhook,
  expireTrials
};