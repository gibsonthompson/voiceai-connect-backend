// ============================================================================
// STRIPE CONNECT - Clients Pay Agencies Directly
// UPDATED: expireTrials now DELETES VAPI phone number + assistant (frees slots)
// UPDATED: reactivation re-enables VAPI phone number
// UPDATED: Admin Stripe Connect notification wired to getSmsTemplate()
// FIXED: expireTrials verifies status update persisted before sending SMS
// UPDATED: 2026-05-08, Per-client billing triggers on client status changes
// UPDATED: 2026-05-16, expireTrials DELETES (not disables) VAPI resources
//          to free up phone number slots. Nulls out resource IDs in DB.
// UPDATED: 2026-05-22, Client checkout: logging, explicit FK hint, pricing
//          defaults updated to $99/$149/$299
// UPDATED: 2026-06-03, expireTrials now RELEASES the underlying Telnyx number
//          (via fullyReleaseNumber) before nulling vapi_phone_number. Deleting
//          only the VAPI object left the Telnyx rental billing monthly forever.
// UPDATED: 2026-06-08, Phase 1 double-billing fix: createClientCheckout
//          rejects with 409 if client.stripe_connected_subscription_id already
//          points to an active|trialing|past_due Stripe subscription.
// UPDATED: 2026-06-10, require_card_for_trial support:
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
// UPDATED: 2026-07-19: cancel-path hardening. (a) Subscription webhooks now
//          resolve the client by stripe_connected_subscription_id first (unique,
//          always on the event), falling back to the customer lookup, fixing
//          the silent miss that left dashboard-canceled clients stuck 'active'.
//          (b) One shared teardown (releaseClientResources/cancelClientAndRelease)
//          so deleted, updated-to-terminal, and reconciliation all RELEASE the
//          Telnyx number + delete the assistant, not just disable, so a canceled
//          client stops costing money. (c) reconcileClientSubscriptions sweeps
//          active/past_due clients against real Stripe status to self-heal rows
//          a missed webhook already broke.
// UPDATED: 2026-07-19: syncConnectBranding pushes each agency's logo and brand
//          colors onto their connected Express account. Client checkouts are
//          already created with the stripeAccount header (direct charges), so
//          Stripe renders the CONNECTED account's branding on the hosted
//          checkout, receipts, invoices, and customer portal. Express accounts
//          have no full Stripe Dashboard, so the platform is the only party
//          that can set those brand settings, which is why they have been
//          blank. Fires automatically when an account first becomes able to
//          accept charges, and is exported so a branding save can trigger it.
// UPDATED: 2026-07-30: repriceMinuteItemsForAgency. Stripe prices are immutable,
//          so a change to client_minute_rate_cents or included_minutes_* only
//          reached new signups and plan changes. This sweep rebuilds a fresh
//          minute price per existing client (at the current rate/included for
//          that client's plan) and swaps the metered item onto it, so a rate
//          change applies to the whole existing book. Called from
//          updateAgencySettings after a rate/included change; no-ops when
//          pass-through is off.
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
const { releaseBYOTNumber } = require('./byot');
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
// COUNTRY to CURRENCY MAPPING
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

// True when the platform supports Stripe Connect in this country. Backed by the
// same countryCurrencyMap that decides currency, so "supported for onboarding"
// and "has a known currency" can never disagree. Case-insensitive.
function isSupportedConnectCountry(countryCode) {
  return typeof countryCode === 'string'
    && Object.prototype.hasOwnProperty.call(countryCurrencyMap, countryCode.trim().toUpperCase());
}

// ============================================================================
// CLIENT-FACING PER-MINUTE BILLING (agency charges its own client per minute)
// ----------------------------------------------------------------------------
// This is the AGENCY-TO-CLIENT layer, entirely on the agency's connected
// account (direct charges, agency keeps 100 percent). It is separate from the
// PLATFORM-TO-AGENCY minute meter run on the platform account by usage-tracker.
//
// The whole feature is a lifecycle, not a boolean. One resolver decides
// everything, read fresh, never cached:
//
//   minutePassThroughActive(agency) === true  ->  the client pays per minute
//   minutePassThroughActive(agency) === false ->  the agency absorbs minutes
//
// "Active" requires the connected account to actually be chargeable, the agency
// to have flipped the toggle on, AND a real rate to be set. That last clause is
// what makes an accidental "on but nothing configured" state harmless: no rate,
// not active, no charge. Reporting a meter event (in usage-tracker.js) adds one
// more gate on top: the client must not be in trial.
//
// OFF is authoritative because the toggle governs REPORTING, and reporting is
// what bills. Flip off and events stop that instant regardless of what items
// still exist on the subscription. Inert metered items are removed at each
// client's next renewal (handleClientPaymentSucceeded), not mid-cycle, so
// turning off never fires a surprise invoice.
// ============================================================================

// The single source of truth. Every gate (checkout attach, plan change,
// rollover cleanup, the ON sweep, and the usage-tracker meter event) calls
// this. If it returns false, no client minute charge can happen.
function minutePassThroughActive(agency) {
  return !!(agency
    && agency.stripe_account_id
    && agency.stripe_charges_enabled === true
    && agency.minute_pass_through === true
    && Number(agency.client_minute_rate_cents) > 0);
}

// True for a subscription item backed by a Stripe meter (the per-minute item).
// The flat base-plan item has no recurring.meter, so this reliably tells the
// two apart. Used everywhere we must touch the minute item WITHOUT disturbing
// the base plan.
function findMeteredItem(subscription) {
  return (subscription?.items?.data || []).find((it) => it?.price?.recurring?.meter) || null;
}

// Create (or reuse) the voice_minutes meter on the agency's OWN connected
// account, and store its id on the agency row. Idempotent: it lists existing
// meters first and reuses a voice_minutes one, so a retry or a lost DB write
// never spawns duplicate meters. Mutates the passed agency object so the caller
// sees the id without a re-fetch. Same meter shape as the platform meter.
async function ensureConnectMinuteMeter(agency) {
  if (agency.connect_minute_meter_id) return agency.connect_minute_meter_id;
  if (!agency.stripe_account_id) throw new Error('Agency has no connected account for a minute meter');
  const acct = agency.stripe_account_id;

  let meterId = null;
  try {
    const existing = await stripe.billing.meters.list({ status: 'active', limit: 100 }, { stripeAccount: acct });
    const found = (existing.data || []).find((m) => m.event_name === 'voice_minutes');
    if (found) meterId = found.id;
  } catch (e) {
    console.warn('Connect meter list failed, will attempt create:', e.message);
  }

  if (!meterId) {
    const meter = await stripe.billing.meters.create({
      display_name: 'Voice Minutes',
      event_name: 'voice_minutes',
      default_aggregation: { formula: 'sum' },
      customer_mapping: { event_payload_key: 'stripe_customer_id', type: 'by_id' },
      value_settings: { event_payload_key: 'value' },
    }, { stripeAccount: acct });
    meterId = meter.id;
  }

  await supabase.from('agencies').update({ connect_minute_meter_id: meterId }).eq('id', agency.id);
  agency.connect_minute_meter_id = meterId;
  return meterId;
}

// Included minutes for a plan (free allotment before overage). 0 = pure
// per-minute, no free tier. Falls back to 0 for unknown plans.
function includedMinutesForPlan(agency, plan) {
  const map = {
    starter: agency.included_minutes_starter || 0,
    pro: agency.included_minutes_pro || 0,
    growth: agency.included_minutes_growth || 0,
  };
  return map[plan] || 0;
}

// Build a metered price on the connected account for this plan's minutes.
//   included > 0 -> graduated tiers: the allotment at $0, then the rate.
//   included = 0 -> plain per-unit metered price at the rate.
// client_minute_rate_cents is cents per minute and may be fractional, so it is
// passed as unit_amount_decimal (a string of cents). All minutes are reported
// to the meter and Stripe zero-rates the allotment, so there is no app-side
// allotment math.
async function createConnectMinutePrice(agency, plan) {
  const acct = agency.stripe_account_id;
  const meterId = await ensureConnectMinuteMeter(agency);
  const currency = getCurrencyForCountry(agency.country || 'US');
  const rateCents = Number(agency.client_minute_rate_cents);
  if (!(rateCents > 0)) throw new Error('client_minute_rate_cents must be greater than 0 to bill minutes');
  const included = includedMinutesForPlan(agency, plan);

  const product = await stripe.products.create({
    name: `Voice Minutes - ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
    metadata: { plan, kind: 'voice_minutes' },
  }, { stripeAccount: acct });

  const recurring = { interval: 'month', usage_type: 'metered', meter: meterId };

  if (included > 0) {
    return stripe.prices.create({
      product: product.id,
      currency,
      recurring,
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers: [
        { up_to: included, unit_amount: 0 },
        { up_to: 'inf', unit_amount_decimal: String(rateCents) },
      ],
      metadata: { plan, kind: 'voice_minutes' },
    }, { stripeAccount: acct });
  }

  return stripe.prices.create({
    product: product.id,
    currency,
    recurring,
    billing_scheme: 'per_unit',
    unit_amount_decimal: String(rateCents),
    metadata: { plan, kind: 'voice_minutes' },
  }, { stripeAccount: acct });
}

// Attach the metered minute item to an EXISTING live subscription. Used by the
// ON sweep and the backfill for clients who already had a flat-only sub before
// pass-through was turned on. New signups get the item at checkout instead.
// Idempotent: no-ops if a metered item is already present. Returns a summary,
// never throws on the "nothing to do" paths.
async function ensureClientMinuteItem(client, agency) {
  if (!minutePassThroughActive(agency)) return { attached: false, reason: 'not_active' };
  if (!client.stripe_connected_subscription_id) return { attached: false, reason: 'no_subscription' };
  const acct = agency.stripe_account_id;

  let sub;
  try {
    sub = await stripe.subscriptions.retrieve(client.stripe_connected_subscription_id, { stripeAccount: acct });
  } catch (e) {
    if (e.code === 'resource_missing') return { attached: false, reason: 'sub_missing' };
    throw e;
  }
  if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
    return { attached: false, reason: `status_${sub.status}` };
  }
  if (findMeteredItem(sub)) return { attached: false, reason: 'already_attached' };

  const price = await createConnectMinutePrice(agency, client.plan_type || 'starter');
  await stripe.subscriptionItems.create(
    { subscription: sub.id, price: price.id }, // metered items reject quantity
    { stripeAccount: acct }
  );
  return { attached: true };
}

// ON sweep. When an agency flips pass-through on, attach the metered item to
// every existing client that has a live subscription. New signups are handled
// at checkout, so this only backfills the existing book. Partial failures are
// fine: each client either ends up with the item or not, and a re-run finishes
// the rest. Never lets one client's Stripe hiccup abort the whole sweep.
async function attachMinuteItemsForAgency(agencyId) {
  const { data: agency } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
  if (!agency) return { ok: false, reason: 'agency_not_found' };
  if (!minutePassThroughActive(agency)) return { ok: false, reason: 'not_active' };

  await ensureConnectMinuteMeter(agency);

  const { data: clients } = await supabase
    .from('clients')
    .select('id, business_name, plan_type, stripe_connected_subscription_id')
    .eq('agency_id', agencyId)
    .not('stripe_connected_subscription_id', 'is', null);

  let attached = 0, skipped = 0;
  for (const c of clients || []) {
    try {
      const r = await ensureClientMinuteItem(c, agency);
      if (r.attached) attached++; else skipped++;
    } catch (e) {
      skipped++;
      console.warn(`Minute item attach failed for ${c.business_name}:`, e.message);
    }
  }
  return { ok: true, attached, skipped };
}

// ============================================================================
// REPRICE MINUTE ITEMS FOR AGENCY  (rate / included-minutes change sweep)
// ----------------------------------------------------------------------------
// Stripe prices are immutable. When an agency changes client_minute_rate_cents
// or a plan's included_minutes_*, clients who already have a metered item keep
// the OLD price until something re-points them, so a settings rate change would
// otherwise only affect new signups and plan changes. This sweep rebuilds a
// fresh minute price per client (at the CURRENT rate/included for that client's
// plan) and swaps the existing metered item onto it, applying the change to the
// whole existing book.
//
// Only runs when pass-through is active. A client with a live sub but no metered
// item yet (e.g. added after the ON sweep) gets one attached at the fresh price,
// so it also bills at the new rate. proration_behavior 'none' on the swap: a
// metered price carries no fixed amount, so there is nothing to prorate and this
// keeps the change from generating an invoice line. Never lets one client's
// Stripe hiccup abort the rest; returns a summary. Called from
// updateAgencySettings after a rate/included change.
// ============================================================================
async function repriceMinuteItemsForAgency(agencyId) {
  const { data: agency } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
  if (!agency) return { ok: false, reason: 'agency_not_found' };
  if (!minutePassThroughActive(agency)) return { ok: false, reason: 'not_active' };

  const acct = agency.stripe_account_id;

  const { data: clients } = await supabase
    .from('clients')
    .select('id, business_name, plan_type, stripe_connected_subscription_id')
    .eq('agency_id', agencyId)
    .not('stripe_connected_subscription_id', 'is', null);

  let repriced = 0, attached = 0, skipped = 0;
  for (const c of clients || []) {
    try {
      let sub;
      try {
        sub = await stripe.subscriptions.retrieve(c.stripe_connected_subscription_id, { stripeAccount: acct });
      } catch (e) {
        if (e.code === 'resource_missing') { skipped++; continue; }
        throw e;
      }
      if (!['active', 'trialing', 'past_due'].includes(sub.status)) { skipped++; continue; }

      const price = await createConnectMinutePrice(agency, c.plan_type || 'starter');
      const meterItem = findMeteredItem(sub);
      if (meterItem) {
        await stripe.subscriptionItems.update(
          meterItem.id,
          { price: price.id, proration_behavior: 'none' },
          { stripeAccount: acct }
        );
        repriced++;
      } else {
        await stripe.subscriptionItems.create(
          { subscription: sub.id, price: price.id }, // metered, no quantity
          { stripeAccount: acct }
        );
        attached++;
      }
    } catch (e) {
      skipped++;
      console.warn(`Minute item reprice failed for ${c.business_name}:`, e.message);
    }
  }
  return { ok: true, repriced, attached, skipped };
}

// ============================================================================
// SET MINUTE PASS-THROUGH  (POST /api/agency/:agencyId/minute-pass-through)
// ----------------------------------------------------------------------------
// The toggle endpoint. Validates BEFORE flipping on so the misconfigured
// "on but no rate / not connected" state can never exist. Turning on ensures
// the meter and sweeps existing clients. Turning off just flips the flag:
// reporting stops immediately via the resolver, and inert items are cleaned up
// at each client's next renewal, so there is no mid-cycle charge and nothing
// else to do here. Mount behind the same billing guard as the other agency
// billing routes in server.js.
// ============================================================================
async function setMinutePassThrough(req, res) {
  try {
    const { agencyId } = req.params;
    if (!agencyId) return res.status(400).json({ error: 'agencyId required' });

    const enabled = req.body?.enabled === true;

    const { data: agency, error } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });

    if (enabled) {
      if (!agency.stripe_account_id || !agency.stripe_charges_enabled) {
        return res.status(400).json({
          error: 'stripe_not_ready',
          message: 'Connect Stripe and finish onboarding before enabling per-minute billing.',
        });
      }
      if (!(Number(agency.client_minute_rate_cents) > 0)) {
        return res.status(400).json({
          error: 'rate_required',
          message: 'Set a per-minute rate above zero before enabling per-minute billing.',
        });
      }

      await ensureConnectMinuteMeter(agency);
      await supabase.from('agencies').update({ minute_pass_through: true }).eq('id', agencyId);
      agency.minute_pass_through = true;

      const sweep = await attachMinuteItemsForAgency(agencyId);
      return res.json({ success: true, enabled: true, sweep });
    }

    // Turn off. Reporting stops now; inert items are removed at renewal.
    await supabase.from('agencies').update({ minute_pass_through: false }).eq('id', agencyId);
    return res.json({ success: true, enabled: false });
  } catch (e) {
    console.error('setMinutePassThrough error:', e.message);
    return res.status(500).json({ error: 'Failed to update per-minute billing' });
  }
}

// ============================================================================
// CREATE CONNECT ACCOUNT LINK  (POST /api/agency/connect/onboard)
// ----------------------------------------------------------------------------
// Creates (or resumes onboarding for) the agency's Express Connect account and
// returns a hosted onboarding link.
//
// COUNTRY HANDLING (the fix). A connected account's country is set at creation
// and is IMMUTABLE afterward, so it has to be right the first time. Before this,
// the account was always created with `agency.country || 'US'`, which silently
// trapped every non-US agency that had no stored country as a US account (this
// is what put a UK agency on US onboarding and left it unable to take GBP).
//
// Now:
//   - The onboarding country comes from the request body (the settings-page
//     picker sends it), falling back to the agency's stored country, then 'US'.
//   - It is validated against countryCurrencyMap (the same map that drives
//     currency), so an unsupported code is rejected with 400 instead of quietly
//     defaulting to US.
//   - The resolved country is PERSISTED on the agency row. createClientCheckout,
//     createTrialCheckoutForSignup, and changeClientPlan all derive currency
//     from agency.country, so persisting here also fixes client-charge currency.
//   - If an account already exists in a DIFFERENT country than the one now
//     requested, we return 409 instead of reusing it. Reusing it would keep the
//     agency on the wrong-country (and wrong-currency) account forever. To move,
//     the agency disconnects (which nulls stripe_account_id) and reconnects.
//   - A stale stripe_account_id that Stripe no longer knows (resource_missing)
//     is treated as no account, and a fresh one is created.
// ============================================================================
async function createConnectAccountLink(req, res) {
  try {
    const { agency_id } = req.body;

    if (!agency_id) {
      return res.status(400).json({ error: 'agency_id required' });
    }

    // Requested country (optional). Present when the settings picker sends it.
    // Normalized to an uppercase 2-letter code; blank/whitespace counts as absent.
    const rawCountry = typeof req.body.country === 'string' ? req.body.country.trim().toUpperCase() : '';
    const requestedCountry = rawCountry || null;

    // Reject an explicitly requested country we do not support, rather than
    // letting it fall through to a US default the caller never asked for.
    if (requestedCountry && !isSupportedConnectCountry(requestedCountry)) {
      return res.status(400).json({
        error: 'country_unsupported',
        message: `Stripe Connect is not available in ${requestedCountry} on this platform yet.`,
        requested_country: requestedCountry,
      });
    }

    const { data: agency, error } = await supabase
      .from('agencies').select('*').eq('id', agency_id).single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    let accountId = agency.stripe_account_id;

    // ---- Existing account: resume onboarding, or block a country change ----
    if (accountId) {
      let existingAccount = null;
      try {
        existingAccount = await stripe.accounts.retrieve(accountId);
      } catch (retrieveErr) {
        if (retrieveErr.code === 'resource_missing') {
          // Stored id no longer exists at Stripe (deleted, or a different Stripe
          // environment). Drop it and fall through to create a fresh account.
          console.warn(`Connect: stored account ${accountId} missing at Stripe for ${agency.name}, recreating`);
          await supabase.from('agencies').update({
            stripe_account_id: null,
            stripe_onboarding_complete: false,
            stripe_charges_enabled: false,
            stripe_payouts_enabled: false,
          }).eq('id', agency_id);
          accountId = null;
        } else {
          throw retrieveErr;
        }
      }

      if (existingAccount) {
        const existingCountry = (existingAccount.country || '').toUpperCase();

        // A country change was explicitly requested and it conflicts with the
        // account that already exists. Country cannot be changed on a live
        // account, so do not silently keep them on the old one.
        if (requestedCountry && existingCountry && requestedCountry !== existingCountry) {
          return res.status(409).json({
            error: 'account_country_mismatch',
            message: `Your Stripe account is set to ${existingCountry} and a country cannot be changed after it is created. Disconnect Stripe first, then reconnect and choose ${requestedCountry}.`,
            existing_country: existingCountry,
            requested_country: requestedCountry,
          });
        }

        // Self-heal: if the agency row never stored a country (or it drifted),
        // backfill it from the real account so currency lookups are correct.
        if (existingCountry && (agency.country || '').toUpperCase() !== existingCountry) {
          await supabase.from('agencies').update({ country: existingCountry }).eq('id', agency_id);
        }

        console.log('Resuming Connect onboarding for:', agency.name, '| Country:', existingCountry || 'unknown');
      }
    }

    // ---- No account (or a stale one was just cleared): create a fresh one ----
    if (!accountId) {
      // Resolve the onboarding country: explicit request, else stored, else US.
      const storedCountry = typeof agency.country === 'string' ? agency.country.trim().toUpperCase() : '';
      let resolvedCountry = requestedCountry || storedCountry || 'US';

      // Guard the stored/default path too. A bad value sitting in agency.country
      // must not create an account in it; fall back to US and log.
      if (!isSupportedConnectCountry(resolvedCountry)) {
        console.warn(`Connect: resolved country ${resolvedCountry} for ${agency.name} is unsupported, defaulting to US`);
        resolvedCountry = 'US';
      }

      console.log('Creating Stripe Connect account for:', agency.name, '| Country:', resolvedCountry);

      const account = await stripe.accounts.create({
        type: 'express',
        country: resolvedCountry,
        email: agency.email,
        metadata: { agency_id: agency_id },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });

      accountId = account.id;

      // Persist BOTH the account id and the resolved country. Persisting country
      // is what makes client-charge currency (getCurrencyForCountry(agency.country))
      // correct for non-US agencies.
      await supabase.from('agencies')
        .update({ stripe_account_id: accountId, country: resolvedCountry })
        .eq('id', agency_id);

      console.log('Connect account created:', accountId, '| Country:', resolvedCountry);
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
// SYNC AGENCY BRANDING TO THE CONNECTED ACCOUNT
// ----------------------------------------------------------------------------
// Client checkouts are created with { stripeAccount: agency.stripe_account_id }
// (see createClientCheckout / createTrialCheckoutForSignup), which makes the
// agency the merchant of record. Stripe therefore renders the CONNECTED
// account's brand settings on the hosted checkout page, receipts, invoices, and
// the customer portal, not the platform's. Connected accounts are created as
// type 'express', and an Express account has no full Stripe Dashboard to set
// those settings in, so the platform has to write them through the Accounts
// API. Until this ran, every agency's brand settings were empty and their
// clients saw an unbranded checkout.
//
// What lands where (per Stripe's brand settings):
//   icon            -> checkout, emails, customer portal, invoices
//   logo            -> checkout, invoice PDFs
//   primary_color   -> receipts, invoices, customer portal (NOT checkout)
//   secondary_color -> checkout background, emails, customer portal
// Because Stripe's secondary_color is the accent, it is fed from the agency's
// accent_color (falling back to secondary_color), not from the darker
// secondary shade we use for hover states.
//
// Deliberately does NOT touch business_profile.name. The agency typed their
// real business name during Stripe onboarding, card network rules expect the
// displayed name to match the actual business, and silently overwriting it
// with our display name risks chargeback disputes. Left as a separate decision.
//
// Never throws. Callers treat it as fire and forget so a branding hiccup can
// never break onboarding or a settings save.
// ============================================================================

// Stripe brand assets: JPG or PNG, under 512kb, at least 128x128.
const BRANDING_MAX_BYTES = 512 * 1024;
const BRANDING_ALLOWED_MIME = ['image/png', 'image/jpeg'];

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

// Resolve agency.logo_url into raw bytes. The settings page stores whatever the
// upload produced, which is a base64 data URL for a freshly uploaded file and an
// https URL for one already hosted, so both shapes have to work. Returns null
// when there is no usable image; throws only on a genuine fetch failure.
async function loadBrandingImage(logoUrl) {
  if (!logoUrl || typeof logoUrl !== 'string') return null;
  const src = logoUrl.trim();
  if (!src) return null;

  const dataUrl = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(src);
  if (dataUrl) {
    let mime = dataUrl[1].toLowerCase();
    if (mime === 'image/jpg') mime = 'image/jpeg';
    if (!BRANDING_ALLOWED_MIME.includes(mime)) {
      throw new Error(`unsupported logo type ${mime} (Stripe accepts PNG or JPG)`);
    }
    return { buffer: Buffer.from(dataUrl[2], 'base64'), mime };
  }

  if (!/^https?:\/\//i.test(src)) return null;

  const res = await fetch(src);
  if (!res.ok) throw new Error(`logo fetch failed (HTTP ${res.status})`);
  let mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (!BRANDING_ALLOWED_MIME.includes(mime)) {
    throw new Error(`unsupported logo type ${mime || 'unknown'} (Stripe accepts PNG or JPG)`);
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), mime };
}

// agencyOrId: an agency row (must carry the fields selected below) or an id.
// Returns { synced, reason?, accountId?, fileId?, colors? }. Never throws.
async function syncConnectBranding(agencyOrId) {
  try {
    let agency = agencyOrId;

    if (!agency || typeof agency === 'string') {
      const agencyId = typeof agencyOrId === 'string' ? agencyOrId : null;
      if (!agencyId) return { synced: false, reason: 'no_agency' };
      const { data, error } = await supabase
        .from('agencies')
        .select('id, name, logo_url, primary_color, secondary_color, accent_color, stripe_account_id')
        .eq('id', agencyId)
        .single();
      if (error || !data) return { synced: false, reason: 'agency_not_found' };
      agency = data;
    }

    if (!agency.stripe_account_id) return { synced: false, reason: 'not_connected' };

    const brandingUpdate = {};

    // Colors first. These are cheap and apply even when there is no logo.
    const primary = isHexColor(agency.primary_color) ? agency.primary_color.trim() : null;
    const accentSource = isHexColor(agency.accent_color)
      ? agency.accent_color
      : (isHexColor(agency.secondary_color) ? agency.secondary_color : null);
    const secondary = accentSource ? accentSource.trim() : null;

    if (primary) brandingUpdate.primary_color = primary;
    if (secondary) brandingUpdate.secondary_color = secondary;

    // Logo. Upload the bytes to Stripe Files ON the connected account, then
    // reference the returned file id. settings.branding takes a Stripe file id,
    // never a URL, which is the part that trips people up here.
    let fileId = null;
    try {
      const image = await loadBrandingImage(agency.logo_url);
      if (image) {
        if (image.buffer.length > BRANDING_MAX_BYTES) {
          console.warn(`Branding sync: logo for ${agency.name} is ${(image.buffer.length / 1024).toFixed(0)}kb, over Stripe's 512kb limit. Colors will still sync.`);
        } else {
          const ext = image.mime === 'image/png' ? 'png' : 'jpg';
          const upload = await stripe.files.create(
            {
              // purpose must be the brand-asset purpose; a wrong value comes
              // back as an explicit Stripe parameter error rather than failing
              // silently, so a mismatch is loud.
              purpose: 'business_logo',
              file: {
                data: image.buffer,
                name: `agency-${agency.id}-logo.${ext}`,
                type: image.mime,
              },
            },
            { stripeAccount: agency.stripe_account_id }
          );
          fileId = upload.id;
          // icon is the square mark used on checkout and emails; logo is the
          // wider lockup used on checkout and invoice PDFs. We only hold one
          // asset per agency, so it serves as both.
          brandingUpdate.icon = fileId;
          brandingUpdate.logo = fileId;
        }
      }
    } catch (imgErr) {
      // A bad or unreachable logo must not stop the colors from syncing.
      console.warn(`Branding sync: logo skipped for ${agency.name}: ${imgErr.message}`);
    }

    if (Object.keys(brandingUpdate).length === 0) {
      return { synced: false, reason: 'nothing_to_sync', accountId: agency.stripe_account_id };
    }

    await stripe.accounts.update(agency.stripe_account_id, {
      settings: { branding: brandingUpdate },
    });

    console.log(`🎨 Branding synced to Connect account ${agency.stripe_account_id} for ${agency.name}: ${Object.keys(brandingUpdate).join(', ')}`);
    return {
      synced: true,
      accountId: agency.stripe_account_id,
      fileId,
      colors: { primary_color: primary, secondary_color: secondary },
    };
  } catch (error) {
    console.error('❌ Branding sync failed:', error.message);
    return { synced: false, reason: 'error', error: error.message };
  }
}

// Express handler for an explicit resync, useful for backfilling agencies that
// connected before this existed. Mount it wherever the other connect routes are
// mounted, behind the same access guard as the rest of the Payments tab.
async function syncConnectBrandingHandler(req, res) {
  try {
    const { agencyId } = req.params;
    if (!agencyId) return res.status(400).json({ error: 'agencyId required' });

    const result = await syncConnectBranding(agencyId);

    if (!result.synced) {
      const status = result.reason === 'agency_not_found' ? 404
        : result.reason === 'not_connected' ? 400
        : result.reason === 'error' ? 500
        : 200;
      return res.status(status).json({ success: false, ...result });
    }

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Branding sync endpoint error:', error);
    res.status(500).json({ error: 'Failed to sync branding' });
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
// CREATE CONNECT LOGIN LINK (Express dashboard access)
// ----------------------------------------------------------------------------
// Express accounts have no standalone Stripe login, so a plain dashboard.stripe
// .com link is useless to them. createLoginLink mints a single-use, short-lived
// URL straight into the agency's Express dashboard, where they can see payouts,
// update their bank account, and view transactions. This is the correct target
// for the "Open Stripe dashboard" button on the Payments page.
//
// Guarded upstream by requireAgencyAccess('billing') in server.js, so by the
// time we get here the caller is a verified owner of :agencyId. Fails cleanly
// if the account cannot accept charges yet (onboarding incomplete), because
// login links only work once the account is set up.
// ============================================================================
async function createConnectLoginLink(req, res) {
  try {
    const { agencyId } = req.params;

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('stripe_account_id, stripe_charges_enabled')
      .eq('id', agencyId)
      .single();

    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });
    if (!agency.stripe_account_id) return res.status(400).json({ error: 'Stripe not connected' });

    try {
      const link = await stripe.accounts.createLoginLink(agency.stripe_account_id);
      return res.json({ url: link.url });
    } catch (stripeErr) {
      // Most common cause: the account hasn't finished onboarding, so Stripe
      // won't issue a login link yet. Surface a clear, actionable message.
      console.error('Login link error:', stripeErr.message);
      return res.status(400).json({
        error: 'dashboard_unavailable',
        message: 'Finish Stripe setup before opening the dashboard.',
      });
    }
  } catch (error) {
    console.error('Create login link error:', error);
    res.status(500).json({ error: 'Failed to create dashboard link' });
  }
}
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
      // A disconnected agency has no connected account, so it has no meter and
      // cannot charge clients per minute. Force pass-through off and drop the
      // dead meter reference, otherwise minutePassThroughActive would still gate
      // false (no stripe_account_id) but the row would misleadingly read "on".
      minute_pass_through: false,
      connect_minute_meter_id: null,
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
// passwordToken (optional): the fresh set-password token generated at signup.
// When present, success_url lands the paid client on the agency's own
// /auth/set-password page instead of /client/welcome, so they set a password
// once (which mints a session on the agency origin and drops them into the
// dashboard logged in) with no email round-trip. Falls back to /client/welcome
// when no token is supplied, so nothing breaks if it is ever missing.
//
// Returns: { url } on success, throws on error. Caller handles errors.
// ============================================================================
async function createTrialCheckoutForSignup({ client, agency, plan, passwordToken }) {
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

  // When we have a password token, send the paid client straight to set their
  // password on the agency domain (which then logs them into the dashboard on
  // that origin). Otherwise fall back to the welcome page.
  const successUrl = passwordToken
    ? `${agencyUrl}/auth/set-password?token=${encodeURIComponent(passwordToken)}`
    : `${agencyUrl}/client/welcome?trial=started`;

  // Flat base item, plus the metered minute item when pass-through is active.
  // The metered item accrues nothing during the 7-day trial because the meter
  // event in usage-tracker is gated on the client not being in trial.
  const lineItems = [{ price: price.id, quantity: 1 }];
  if (minutePassThroughActive(agency)) {
    const minutePrice = await createConnectMinutePrice(agency, plan);
    lineItems.push({ price: minutePrice.id }); // metered, no quantity
  }

  const session = await stripe.checkout.sessions.create({
    customer: connectedCustomerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: lineItems,
    success_url: successUrl,
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
// UPDATED 2026-06-08, Phase 1 active-subscription guard.
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
        console.warn(`Stale stripe_connected_subscription_id ${client.stripe_connected_subscription_id} for client ${client_id}, proceeding with fresh checkout`);
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

    // Flat base item, plus the metered minute item when pass-through is active.
    const upgradeLineItems = [{ price: price.id, quantity: 1 }];
    if (minutePassThroughActive(agency)) {
      const minutePrice = await createConnectMinutePrice(agency, plan);
      upgradeLineItems.push({ price: minutePrice.id }); // metered, no quantity
    }

    const session = await stripe.checkout.sessions.create({
      customer: connectedCustomerId, mode: 'subscription', payment_method_types: ['card'],
      line_items: upgradeLineItems,
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

    // Identify the flat base item by identity, NOT by index. Once a metered
    // minute item is attached, items.data[0] may be either one, so swapping
    // the wrong item would corrupt billing. The flat item is the one with no
    // recurring.meter; the metered item (if any) is handled separately below.
    const meterItem = findMeteredItem(subscription);
    const flatItem = (subscription.items?.data || []).find((it) => !it?.price?.recurring?.meter)
      || subscription.items?.data?.[0];
    if (!flatItem) {
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

    // Build the items update: always swap the flat base item to the new plan
    // price. For the minute item, re-point it to a price built for the new
    // plan's included-minutes tier when pass-through is active (adding it if it
    // was missing). If pass-through is off, leave any inert item alone; it is
    // cleaned up at renewal. Minutes carry no dollar amount on the meter event,
    // so re-pointing changes the rate/allotment going forward without touching
    // usage already reported.
    const itemsUpdate = [{ id: flatItem.id, price: price.id }];
    if (minutePassThroughActive(agency)) {
      const minutePrice = await createConnectMinutePrice(agency, plan);
      if (meterItem) {
        itemsUpdate.push({ id: meterItem.id, price: minutePrice.id });
      } else {
        itemsUpdate.push({ price: minutePrice.id });
      }
    }

    // create_prorations credits/debits the flat difference on the next invoice;
    // during a trial this produces no immediate charge and the new price applies
    // at trial end. Metered items carry no fixed amount, so they do not prorate.
    await stripe.subscriptions.update(
      client.stripe_connected_subscription_id,
      {
        items: itemsUpdate,
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
      // -- RELEASE the phone number: delete VAPI + release Telnyx --
      if (client.vapi_phone_id || client.vapi_phone_number) {
        try {
          const release = await fullyReleaseNumber(client.vapi_phone_id, client.vapi_phone_number);
          console.log(`📞 Release ${client.business_name}: VAPI=${release.vapiDeleted} Telnyx=${release.telnyxReleased}`);
          if (!release.telnyxReleased) {
            console.error(`⚠️ Telnyx NOT released for ${client.business_name} (${client.vapi_phone_number}), orphan sweep will catch it`);
          }
        } catch (relErr) {
          console.error('❌ Number release failed:', relErr.message);
          if (client.vapi_phone_id) { try { await disablePhoneNumber(client.vapi_phone_id); } catch {} }
        }

        // BYOT: the number may have been bought on the AGENCY'S own Twilio, not
        // the platform Telnyx. fullyReleaseNumber deletes the VAPI object and
        // releases Telnyx, but never touches the agency's Twilio, so without
        // this a BYOT number keeps billing on the agency's account forever.
        // releaseBYOTNumber is idempotent and never throws; gated on the agency
        // actually having Twilio creds so non-BYOT teardowns stay silent.
        const relAgency = client.agencies;
        if (relAgency && relAgency.twilio_account_sid && relAgency.twilio_api_key_encrypted && client.vapi_phone_number) {
          try { await releaseBYOTNumber(relAgency, client.vapi_phone_number); }
          catch (byotErr) { console.error('❌ BYOT release failed:', byotErr.message); }
        }
      }

      // -- DELETE VAPI assistant --
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

      // -- Update status + null out VAPI resource IDs --
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

      // -- Verify update persisted (RLS check) --
      const { data: verifyClient } = await supabase
        .from('clients')
        .select('subscription_status')
        .eq('id', client.id)
        .single();

      if (verifyClient?.subscription_status !== 'trial_expired') {
        console.error('❌ Status update did not persist for:', client.business_name,
          ', still:', verifyClient?.subscription_status,
          '(likely RLS policy blocking the update)');
        results.push({ id: client.id, business_name: client.business_name, success: false, error: 'Update did not persist, check RLS policies on clients table' });
        continue;
      }

      // -- Send SMS after confirmed status change --
      const agency = client.agencies;
      await sendClientTrialExpiredSMS(client, agency);

      // -- Update agency per-client billing (decrease quantity) --
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
// SUBSCRIPTION-EVENT CLIENT RESOLUTION
// ----------------------------------------------------------------------------
// The bug: handleClientSubscriptionDeleted / ...Updated looked the client up
// ONLY by customer id + account (getClientByStripeConnectedCustomerId). When a
// subscription was canceled from the Stripe dashboard, if the row's
// stripe_connected_customer_id was stale or the lookup otherwise missed, the
// handler hit `if (!client) return` and the row stayed 'active' forever, which
// is exactly what left canceled clients counted as active in analytics.
//
// Fix: resolve by stripe_connected_subscription_id FIRST. That id is unique,
// is present on every subscription.* event, and is what we store at checkout,
// so it is the most reliable key. Fall back to the legacy customer lookup only
// if the sub-id match misses (e.g. very old rows that predate storing it).
//
// Done inline against the already-imported supabase client (same join shape as
// createClientCheckout / changeClientPlan) so this needs no new export from
// lib/supabase.js.
// ============================================================================
async function getClientByConnectedSubscriptionId(subscriptionId) {
  if (!subscriptionId) return null;
  const { data, error } = await supabase
    .from('clients')
    .select('*, agencies!clients_agency_id_fkey(*)')
    .eq('stripe_connected_subscription_id', subscriptionId)
    .limit(1);
  if (error) { console.error('Sub-id client lookup failed:', error.message); return null; }
  return (data && data[0]) || null;
}

async function resolveClientForSubscriptionEvent(subscription, stripeAccountId) {
  const bySub = await getClientByConnectedSubscriptionId(subscription.id);
  if (bySub) return bySub;
  // Legacy fallback: customer id (+ account) for rows that never stored the sub id.
  const byCustomer = await getClientByStripeConnectedCustomerId(subscription.customer, stripeAccountId);
  if (byCustomer) {
    console.warn(`Sub ${subscription.id}: matched client ${byCustomer.id} by customer id fallback (sub id not on row)`);
  } else {
    console.error(`Sub ${subscription.id}: no client matched by sub id OR customer id ${subscription.customer}. Event dropped.`);
  }
  return byCustomer;
}

// ============================================================================
// UNIFIED CLIENT TELEPHONY TEARDOWN
// ----------------------------------------------------------------------------
// One place that releases a client's paid resources, so every cancel path
// converges on the same behavior instead of three different ones (deleted:
// disable only; expireTrials: full release; payment_failed: nothing). A truly
// canceled subscription should RELEASE the Telnyx number, not just disable it,
// or the number keeps billing every month for a client who is gone.
//
// Mirrors the expireTrials teardown: release the number (VAPI object + Telnyx
// rental), delete the assistant, delete the query tool, and null the resource
// fields so the freed number cannot collide with a future signup (the
// clients_phone_number_key unique constraint). Never throws; returns a summary.
// ============================================================================
async function releaseClientResources(client) {
  const result = { telnyxReleased: false, vapiDeleted: false, assistantDeleted: false, byotReleased: false };

  if (client.vapi_phone_id || client.vapi_phone_number) {
    try {
      const r = await fullyReleaseNumber(client.vapi_phone_id, client.vapi_phone_number);
      result.telnyxReleased = r.telnyxReleased;
      result.vapiDeleted = r.vapiDeleted;
      if (!r.telnyxReleased) {
        console.error(`⚠️ Telnyx NOT released for ${client.business_name} (${client.vapi_phone_number}), orphan sweep will catch it`);
      }
    } catch (relErr) {
      console.error('❌ Number release failed:', relErr.message);
      if (client.vapi_phone_id) { try { await disablePhoneNumber(client.vapi_phone_id); } catch {} }
    }

    // BYOT: for a client provisioned on the AGENCY'S own Twilio, the number is
    // not a platform Telnyx number, so fullyReleaseNumber above cannot release
    // it and it keeps billing on the agency's Twilio. Release it there too.
    // Idempotent and never throws; gated on the agency having Twilio creds so
    // non-BYOT teardowns stay silent.
    const relAgency = client.agencies;
    if (relAgency && relAgency.twilio_account_sid && relAgency.twilio_api_key_encrypted && client.vapi_phone_number) {
      try { result.byotReleased = await releaseBYOTNumber(relAgency, client.vapi_phone_number); }
      catch (byotErr) { console.error('❌ BYOT release failed:', byotErr.message); }
    }
  }

  if (client.vapi_assistant_id && VAPI_API_KEY) {
    try {
      const res = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
      });
      result.assistantDeleted = res.ok || res.status === 404;
      if (!result.assistantDeleted) { try { await disableAssistant(client.vapi_assistant_id); } catch {} }
    } catch (vapiErr) {
      console.error('⚠️ Assistant delete failed:', vapiErr.message);
      try { await disableAssistant(client.vapi_assistant_id); } catch {}
    }
  }

  if (client.vapi_query_tool_id && VAPI_API_KEY) {
    try {
      await fetch(`https://api.vapi.ai/tool/${client.vapi_query_tool_id}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
      });
    } catch { /* non-fatal */ }
  }

  return result;
}

// Canonical "this client's subscription has ended for good" transition. Marks
// the row canceled, releases resources, nulls the telephony fields, and updates
// agency billing quantity. Idempotent: a second call finds the fields already
// nulled and simply no-ops the release. reason is for logging only.
async function cancelClientAndRelease(client, reason) {
  const release = await releaseClientResources(client);

  const { error } = await supabase.from('clients').update({
    subscription_status: 'canceled',
    status: 'cancelled',
    vapi_phone_id: null,
    vapi_phone_number: null,
    vapi_assistant_id: null,
    vapi_query_tool_id: null,
    phone_number: null,
    phone_area_code: null,
    updated_at: new Date().toISOString(),
  }).eq('id', client.id);

  if (error) {
    console.error(`❌ Failed to mark client ${client.id} canceled:`, error.message);
    return { ok: false, release };
  }

  try { await updateClientBillingQuantity(client.agency_id); }
  catch (e) { console.warn('⚠️ Billing quantity update failed:', e.message); }

  console.log(`✅ Client canceled + resources released: ${client.business_name} (${reason})`);
  return { ok: true, release };
}

// Stripe subscription statuses that mean the subscription is over for good.
const TERMINAL_SUB_STATUSES = ['canceled', 'incomplete_expired'];

// ============================================================================
// RECONCILE CLIENT SUBSCRIPTIONS
// ----------------------------------------------------------------------------
// Self-healing sweep for the rows a missed webhook already left wrong (patching
// the handler does NOT retroactively fix them). Walks every client the DB still
// believes is active or past_due WITH a connected subscription id, retrieves
// the real subscription from Stripe on the connected account, and:
//   - Stripe terminal (canceled / incomplete_expired) OR the subscription no
//     longer exists (resource_missing) -> cancelClientAndRelease. This is the
//     fix for a dashboard-side cancel whose webhook missed.
//   - Stripe 'active'/'trialing' but DB 'past_due' -> correct DB back to
//     active/trial (a recovery whose invoice.payment_succeeded webhook missed).
//   - Stripe 'past_due'/'unpaid' -> leave as-is; Stripe is still retrying and a
//     live retry must not be torn down.
//
// dryRun reports what WOULD change and touches nothing. Guarded by CRON_SECRET
// like the other cron functions; server.js wraps it in a route.
// ============================================================================
async function reconcileClientSubscriptions({ dryRun = false } = {}) {
  console.log(`🔁 Reconciling client subscriptions (dryRun=${dryRun})`);

  const { data: clients, error } = await supabase
    .from('clients')
    .select('*, agencies!clients_agency_id_fkey(*)')
    .in('subscription_status', ['active', 'past_due'])
    .not('stripe_connected_subscription_id', 'is', null);

  if (error) {
    console.error('Reconcile query failed:', error.message);
    return { success: false, error: error.message };
  }

  const rows = clients || [];
  console.log(`🔁 ${rows.length} active/past_due client(s) to verify against Stripe`);

  const results = [];
  let corrected = 0, released = 0, reactivated = 0, unchanged = 0, skipped = 0;

  for (const client of rows) {
    const agency = client.agencies;
    const acct = agency?.stripe_account_id;
    if (!acct) {
      skipped++;
      results.push({ client_id: client.id, business_name: client.business_name, action: 'skipped_no_account' });
      continue;
    }

    let sub = null;
    let missing = false;
    try {
      sub = await stripe.subscriptions.retrieve(client.stripe_connected_subscription_id, { stripeAccount: acct });
    } catch (e) {
      if (e.code === 'resource_missing') { missing = true; }
      else {
        console.error(`Reconcile: retrieve failed for ${client.business_name}:`, e.message);
        skipped++;
        results.push({ client_id: client.id, business_name: client.business_name, action: 'skipped_stripe_error', error: e.message });
        continue;
      }
    }

    const stripeStatus = missing ? 'missing' : sub.status;
    const isTerminal = missing || TERMINAL_SUB_STATUSES.includes(stripeStatus);

    // DB says alive, Stripe says dead -> cancel + release.
    if (isTerminal) {
      if (dryRun) {
        results.push({ client_id: client.id, business_name: client.business_name, db_status: client.subscription_status, stripe_status: stripeStatus, action: 'would_cancel_and_release' });
        corrected++; released++;
        continue;
      }
      const r = await cancelClientAndRelease(client, `reconcile: stripe=${stripeStatus}`);
      results.push({ client_id: client.id, business_name: client.business_name, stripe_status: stripeStatus, action: r.ok ? 'canceled_and_released' : 'cancel_failed', release: r.release });
      if (r.ok) { corrected++; released++; }
      continue;
    }

    // DB past_due but Stripe recovered to active/trialing -> correct forward.
    if (client.subscription_status === 'past_due' && (stripeStatus === 'active' || stripeStatus === 'trialing')) {
      const dbStatus = stripeStatus === 'trialing' ? 'trial' : 'active';
      if (dryRun) {
        results.push({ client_id: client.id, business_name: client.business_name, action: `would_correct_to_${dbStatus}` });
        corrected++; reactivated++;
        continue;
      }
      await supabase.from('clients').update({ subscription_status: dbStatus, status: 'active', updated_at: new Date().toISOString() }).eq('id', client.id);
      if (client.vapi_phone_id) { try { await enablePhoneNumber(client.vapi_phone_id); } catch {} }
      if (client.vapi_assistant_id) { try { await enableAssistant(client.vapi_assistant_id); } catch {} }
      results.push({ client_id: client.id, business_name: client.business_name, action: `corrected_to_${dbStatus}` });
      corrected++; reactivated++;
      continue;
    }

    unchanged++;
  }

  console.log(`🔁 Reconcile done: ${corrected} corrected (${released} released, ${reactivated} reactivated), ${unchanged} already correct, ${skipped} skipped`);
  return { success: true, dryRun, scanned: rows.length, corrected, released, reactivated, unchanged, skipped, results };
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

    // First moment the account can actually charge, so push the agency's logo
    // and brand colors onto it now. Their clients' checkout pages then carry
    // the agency's branding instead of an unbranded default. Fire and forget:
    // syncConnectBranding never throws, and a branding problem must not affect
    // the onboarding status write above or the notification below.
    syncConnectBranding({
      id: agency.id,
      name: agency.name,
      logo_url: agency.logo_url,
      primary_color: agency.primary_color,
      secondary_color: agency.secondary_color,
      accent_color: agency.accent_color,
      stripe_account_id: account.id,
    }).catch(err => console.error('Branding sync on account activation failed:', err.message));

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
    minutes_this_period: 0,
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
  console.log('Client subscription updated:', subscription.id, '| status:', subscription.status);

  const client = await resolveClientForSubscriptionEvent(subscription, stripeAccountId);
  if (!client) return;

  const status = subscription.status;

  // Terminal statuses: subscription is over for good. Full release via the
  // shared path so a dashboard-side cancel that arrives as `updated` (not
  // `deleted`) tears down exactly like a deleted event. Idempotent if the
  // deleted event also lands.
  if (TERMINAL_SUB_STATUSES.includes(status)) {
    await cancelClientAndRelease(client, `subscription.updated status=${status}`);
    return;
  }

  let clientStatus = client.status;

  if (status === 'active') {
    clientStatus = 'active';
    if (client.vapi_phone_id) { await enablePhoneNumber(client.vapi_phone_id).catch(err => console.error('Failed to enable phone:', err.message)); }
    if (client.vapi_assistant_id) { await enableAssistant(client.vapi_assistant_id); }
  } else if (status === 'unpaid') {
    // Retries exhausted but not canceled. Stop service, but DISABLE rather than
    // release, so the client can recover the same number by paying. A true
    // cancel (terminal above) is what releases the number.
    clientStatus = 'cancelled';
    if (client.vapi_phone_id) { await disablePhoneNumber(client.vapi_phone_id).catch(err => console.error('Failed to disable phone:', err.message)); }
    if (client.vapi_assistant_id) { await disableAssistant(client.vapi_assistant_id); }
  }
  // Note: 'past_due' intentionally leaves service ON. Stripe is still retrying
  // the card, and cutting off a client who is about to pay is worse than the
  // brief risk. 'cancel_at_period_end' arrives here as status='active' and is
  // handled by the active branch (stays live until it actually ends).

  // Map Stripe 'trialing' to our 'trial' for consistency with DB-only trials.
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

  // Sub-id-first resolution. The old customer-id-only lookup silently returned
  // when the row's customer id was stale, which is what left dashboard-canceled
  // clients stuck 'active'. Full release so the canceled client's number stops
  // billing instead of merely being disabled.
  const client = await resolveClientForSubscriptionEvent(subscription, stripeAccountId);
  if (!client) return;

  await cancelClientAndRelease(client, 'subscription.deleted');
}

async function handleClientPaymentSucceeded(invoice, stripeAccountId) {
  console.log('Client payment succeeded:', invoice.id);
  // Prefer the subscription id on the invoice (unique, reliable), fall back to
  // the customer lookup, matching the subscription handlers.
  let client = invoice.subscription ? await getClientByConnectedSubscriptionId(invoice.subscription) : null;
  if (!client) client = await getClientByStripeConnectedCustomerId(invoice.customer, stripeAccountId);
  if (!client) { console.error('Client not found for payment:', invoice.customer); return; }

  // New period begins: reset both per-period counters.
  await supabase.from('clients').update({ subscription_status: 'active', status: 'active', calls_this_month: 0, minutes_this_period: 0 }).eq('id', client.id);

  if (client.vapi_phone_id) {
    try { await enablePhoneNumber(client.vapi_phone_id); } catch (phoneError) { console.error('Failed to enable VAPI phone number:', phoneError.message); }
  }
  if (client.vapi_assistant_id) {
    try { await enableAssistant(client.vapi_assistant_id); } catch (vapiError) { console.error('Failed to enable VAPI assistant:', vapiError); }
  }

  // Minute pass-through OFF cleanup, executed at renewal. If the agency has
  // turned per-minute billing off, an inert metered item may still be attached
  // from when it was on. Remove it now. This runs AFTER the invoice that just
  // succeeded (which already billed the prior period's real minute usage), and
  // the new period has zero accrued usage because reporting has been off, so
  // deleting here bills nothing. This is the "no mid-cycle surprise" step: the
  // item only disappears at a clean period boundary. If pass-through is still
  // on, the item is left in place and simply keeps accruing.
  try {
    const agency = client.agencies || (client.agency_id ? await getAgencyById(client.agency_id) : null);
    if (agency && agency.stripe_account_id && client.stripe_connected_subscription_id && !minutePassThroughActive(agency)) {
      const sub = await stripe.subscriptions.retrieve(client.stripe_connected_subscription_id, { stripeAccount: agency.stripe_account_id });
      const meterItem = findMeteredItem(sub);
      if (meterItem) {
        await stripe.subscriptionItems.del(meterItem.id, { stripeAccount: agency.stripe_account_id });
        console.log(`🧹 Removed inert minute item ${meterItem.id} for ${client.business_name} (pass-through off at rollover)`);
      }
    }
  } catch (cleanupErr) {
    console.warn('Minute item rollover cleanup failed (non-fatal):', cleanupErr.message);
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
  let client = invoice.subscription ? await getClientByConnectedSubscriptionId(invoice.subscription) : null;
  if (!client) client = await getClientByStripeConnectedCustomerId(invoice.customer, stripeAccountId);
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
  getConnectFinancials,          // agency Payments page (balance, payouts, charges)
  createConnectAccountSession,   // embedded Connect components (phase 2)
  createConnectLoginLink,        // Express dashboard login link
  disconnectConnectAccount,
  createClientCheckout,
  createTrialCheckoutForSignup, // called from routes/client-signup.js
  createClientPortal,
  changeClientPlan,             // in-app plan change for active subscriptions
  syncConnectBranding,          // push agency logo + colors to their Connect account
  syncConnectBrandingHandler,   // express handler for an explicit resync
  handleConnectStripeWebhook,
  expireTrials,
  reconcileClientSubscriptions, // self-heal DB rows vs real Stripe status
  // Client-facing per-minute billing (agency charges its client per minute)
  minutePassThroughActive,      // resolver: is per-minute billing live for this agency
  ensureConnectMinuteMeter,     // create/reuse the voice_minutes meter on the connected account
  createConnectMinutePrice,     // build a metered minute price for a plan on the connected account
  ensureClientMinuteItem,       // attach the metered item to one existing subscription
  attachMinuteItemsForAgency,   // ON sweep: attach to every existing client (used by toggle + backfill)
  repriceMinuteItemsForAgency,  // rate/included change sweep: re-point existing metered items to a fresh price
  setMinutePassThrough          // POST handler for the on/off toggle
};