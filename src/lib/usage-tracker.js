// ============================================================================
// USAGE TRACKER, Per-Call Voice Minute Tracking + Stripe Meter Events
// Location: src/lib/usage-tracker.js
// Created: 2026-05-06, Pricing Restructure Phase 1
// Updated: 2026-05-07, Migrated to Stripe Meters API (replaces legacy usage records)
// Updated: 2026-05-10, Fixed per-client billing for Free agencies
// Updated: 2026-05-10, Added alertError() to all catch blocks for SMS alerts
// Updated: 2026-06-09, PLAN_RATES.pro.platformFee corrected 179 → 99 (stale
//   pre-restructure value was inflating getAgencyUsageSummary estimated totals
//   by $80/mo for every Pro agency on their billing dashboard)
// Updated: 2026-07-22. insertUsageRecord now also captures VAPI's actual
//   reported per-call cost (vapi_cost) and the per-stage costBreakdown onto the
//   usage_records row. VAPI sends message.cost on the end-of-call-report, which
//   is the real dollar cost of the call (hosting + STT + LLM + TTS + transport).
//   Storing it here makes platform margin computable from actual cost instead
//   of an estimate. Requires the usage_records.vapi_cost + cost_breakdown
//   columns (see migration). Fully backward compatible: both params default to
//   null, so existing callers that do not pass a cost store null and behave
//   exactly as before.
// ============================================================================
const Stripe = require('stripe');
const { supabase } = require('./supabase');
const { alertError } = require('./error-monitor');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================================
// PLAN RATES (for dashboard display + internal calculations)
// ============================================================================
const PLAN_RATES = {
  free:  { platformFee: 0,     perClient: 29.99, perMinute: 0.12 },
  pro:   { platformFee: 99,    perClient: 9.99,  perMinute: 0.10 },
  scale: { platformFee: 499,   perClient: 0,     perMinute: 0.05 },
};

function getPlanRates(planType) {
  return PLAN_RATES[planType] || PLAN_RATES.free;
}

// ============================================================================
// CLIENT PRICE ENV VARS (inline to avoid circular dep with stripe-platform.js)
// ============================================================================
function getClientPriceId(planType) {
  const map = {
    free: process.env.STRIPE_PRICE_FREE_CLIENT,
    starter: process.env.STRIPE_PRICE_FREE_CLIENT,
    pro: process.env.STRIPE_PRICE_PRO_CLIENT,
    professional: process.env.STRIPE_PRICE_PRO_CLIENT,
  };
  return map[planType] || null;
}

// ============================================================================
// CLIENT-FACING PER-MINUTE BILLING RESOLVER (inline copy)
// ----------------------------------------------------------------------------
// Same rule as minutePassThroughActive in stripe-connect.js, duplicated here on
// purpose: stripe-connect.js already imports updateClientBillingQuantity FROM
// this file, so importing back would create a circular dependency (the file
// already inlines getClientPriceId for exactly this reason). This is a tiny
// pure function, so a copy is cheaper than restructuring. If the rule changes,
// change both. Active means: connected + charges enabled + toggle on + a rate.
// ============================================================================
function minutePassThroughActive(agency) {
  return !!(agency
    && agency.stripe_account_id
    && agency.stripe_charges_enabled === true
    && agency.minute_pass_through === true
    && Number(agency.client_minute_rate_cents) > 0);
}

// ============================================================================
// INSERT USAGE RECORD + SEND STRIPE METER EVENT
// ----------------------------------------------------------------------------
// vapiCost / costBreakdown (added 2026-07-22): the actual cost VAPI reported
// for this call on the end-of-call-report. Optional; both default to null so
// older callers are unaffected. vapiCost is coerced to a finite number or null
// before storage, so a malformed value never breaks the insert.
// ============================================================================
async function insertUsageRecord({ agencyId, clientId, callId, durationSeconds, vapiCost = null, costBreakdown = null }) {
  if (!agencyId || !clientId) {
    console.warn('⚠️ Usage record skipped, missing agencyId or clientId');
    return null;
  }

  const seconds = Math.max(0, Math.round(durationSeconds || 0));
  if (seconds === 0) return null;

  const billedMinutes = Math.ceil(seconds / 60);

  // Coerce the VAPI-reported cost to a finite number, else null. Never throws.
  const cost = (vapiCost !== null && vapiCost !== undefined && Number.isFinite(Number(vapiCost)))
    ? Number(vapiCost)
    : null;

  const billingMonth = new Date();
  billingMonth.setDate(1);
  billingMonth.setHours(0, 0, 0, 0);

  try {
    const { data, error } = await supabase
      .from('usage_records')
      .insert({
        agency_id: agencyId,
        client_id: clientId,
        call_id: callId || null,
        duration_seconds: seconds,
        duration_minutes: billedMinutes,
        vapi_cost: cost,
        cost_breakdown: costBreakdown || null,
        billing_month: billingMonth.toISOString().split('T')[0],
        reported_to_stripe: false,
      })
      .select('id')
      .single();

    if (error) {
      console.error('❌ Usage record insert failed:', error.message);
      alertError('usage-record-insert', error, { agencyId, clientId, seconds });
      return null;
    }

    console.log(`📊 Usage recorded: ${seconds}s (${billedMinutes} billed min)${cost !== null ? ` | cost $${cost}` : ''} | agency=${agencyId.slice(0, 8)} client=${clientId.slice(0, 8)}`);

    // Two independent meter events off the SAME billed-minute value and the same
    // usage_records row. Platform side (agency pays the platform) on the platform
    // account, then client side (client pays the agency) on the agency's connected
    // account. Each tracks its own reported flag so a failure on one is never
    // undone by the other. The client side is a no-op unless pass-through is on.
    await sendVoiceMinutesMeterEvent(agencyId, billedMinutes, data.id);
    await sendClientMinuteMeterEvent(clientId, billedMinutes, data.id);

    return data;
  } catch (err) {
    console.error('❌ Usage record error:', err.message);
    alertError('usage-record', err, { agencyId, clientId, seconds });
    return null;
  }
}

// ============================================================================
// SEND VOICE MINUTES METER EVENT TO STRIPE
// ============================================================================
async function sendVoiceMinutesMeterEvent(agencyId, minutes, usageRecordId) {
  if (!minutes || minutes <= 0) return;

  try {
    const { data: agency } = await supabase
      .from('agencies')
      .select('stripe_customer_id, usage_billing_enabled')
      .eq('id', agencyId)
      .single();

    if (!agency?.stripe_customer_id) return;
    if (!agency.usage_billing_enabled) {
      console.log(`   ⏭ Meter event skipped, billing not enabled for agency ${agencyId.slice(0, 8)}`);
      return;
    }

    await stripe.billing.meterEvents.create({
      event_name: 'voice_minutes',
      payload: {
        stripe_customer_id: agency.stripe_customer_id,
        value: String(minutes),
      },
      identifier: usageRecordId || undefined,
    });

    if (usageRecordId) {
      await supabase
        .from('usage_records')
        .update({ reported_to_stripe: true })
        .eq('id', usageRecordId);
    }

    console.log(`   ⚡ Meter event sent: ${minutes} min → Stripe customer ${agency.stripe_customer_id.slice(0, 12)}...`);
  } catch (err) {
    console.warn(`   ⚠️ Meter event failed (non-fatal): ${err.message}`);
    alertError('stripe-meter-event', err, { agencyId, minutes });
  }
}

// ============================================================================
// SEND CLIENT MINUTE METER EVENT (agency-to-client, on the CONNECTED account)
// ----------------------------------------------------------------------------
// The client side of the same call. Reports the identical billed-minute value
// to the voice_minutes meter on the AGENCY'S connected account, with the client
// as the customer, so the agency (merchant of record, keeps 100 percent) bills
// its client per minute. Separate from the platform-to-agency event above.
//
// Fetches the client with its agency so it can resolve pass-through, the
// connected account, the connected customer, and the trial gate itself. This
// keeps insertUsageRecord's signature unchanged (it is called from the VAPI
// webhook with fixed args).
//
// Reporting is gated on: pass-through active for the agency, the client having
// a connected customer AND a live connected subscription (the metered item
// lives on it), and the client NOT being in trial (trial minutes are free).
//
// client_reported_to_stripe is marked true on EVERY terminal path that should
// not retry, both the skips (nothing owed) and a successful send. It is left
// false ONLY when the Stripe call itself throws, so the retry cron picks up
// genuine failures and does NOT churn on non-pass-through agencies forever.
// Deduped by a client-prefixed identifier so a retry cannot double-bill.
// ============================================================================
async function sendClientMinuteMeterEvent(clientId, minutes, usageRecordId) {
  if (!clientId || !minutes || minutes <= 0) return;

  const markSettled = async () => {
    if (!usageRecordId) return;
    try {
      await supabase
        .from('usage_records')
        .update({ client_reported_to_stripe: true })
        .eq('id', usageRecordId);
    } catch { /* non-fatal; the retry cron will re-attempt */ }
  };

  try {
    const { data: client } = await supabase
      .from('clients')
      .select('id, business_name, subscription_status, stripe_connected_customer_id, stripe_connected_subscription_id, agency_id, agencies!clients_agency_id_fkey(*)')
      .eq('id', clientId)
      .single();

    if (!client) { await markSettled(); return; }
    const agency = client.agencies;

    // Not billing minutes to clients for this agency: settle, do not retry.
    if (!minutePassThroughActive(agency)) { await markSettled(); return; }

    // No connected customer or no live subscription means there is no metered
    // item to bill against (for example a no-card trial). Settle, do not retry.
    if (!client.stripe_connected_customer_id || !client.stripe_connected_subscription_id) {
      console.log(`   ⏭ Client minute event skipped, no connected customer/subscription for ${clientId.slice(0, 8)}`);
      await markSettled();
      return;
    }

    // Trial minutes are free.
    if (client.subscription_status === 'trial' || client.subscription_status === 'trialing') {
      console.log(`   ⏭ Client minute event skipped, client ${clientId.slice(0, 8)} in trial`);
      await markSettled();
      return;
    }

    await stripe.billing.meterEvents.create({
      event_name: 'voice_minutes',
      payload: {
        stripe_customer_id: client.stripe_connected_customer_id,
        value: String(minutes),
      },
      identifier: usageRecordId ? `client_${usageRecordId}` : undefined,
    }, { stripeAccount: agency.stripe_account_id });

    await markSettled();
    console.log(`   ⚡ Client minute event sent: ${minutes} min → connected customer ${client.stripe_connected_customer_id.slice(0, 12)}... (acct ${agency.stripe_account_id.slice(0, 12)}...)`);
  } catch (err) {
    // Leave client_reported_to_stripe = false so the retry cron picks it up.
    console.warn(`   ⚠️ Client minute event failed (non-fatal): ${err.message}`);
    alertError('stripe-client-meter-event', err, { clientId, minutes });
  }
}

// ============================================================================
// UPDATE CLIENT COUNT ON SUBSCRIPTION (per-client billing)
// ============================================================================
async function updateClientBillingQuantity(agencyId) {
  try {
    const { data: agency } = await supabase
      .from('agencies')
      .select('stripe_subscription_id, stripe_client_meter_item_id, plan_type, usage_billing_enabled')
      .eq('id', agencyId)
      .single();

    if (!agency?.stripe_subscription_id) {
      return { updated: false, reason: 'No subscription' };
    }

    if (!agency.usage_billing_enabled) {
      return { updated: false, reason: 'Billing not enabled' };
    }

    if (agency.plan_type === 'scale' || agency.plan_type === 'enterprise') {
      return { updated: false, reason: 'Scale tier, no per-client fee' };
    }

    const { count } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId)
      .eq('status', 'active')
      .eq('is_test_client', false);

    const billableCount = count || 0;

    // ── CASE 1: Client price item exists → update quantity ──────────
    if (agency.stripe_client_meter_item_id) {
      await stripe.subscriptionItems.update(agency.stripe_client_meter_item_id, {
        quantity: billableCount,
      });

      await supabase
        .from('agencies')
        .update({ billable_clients_count: billableCount })
        .eq('id', agencyId);

      console.log(`📊 Client billing updated: ${billableCount} billable clients for agency ${agencyId.slice(0, 8)}`);
      return { updated: true, billableCount };
    }

    // ── CASE 2: Client price item MISSING → add it to subscription ──
    const clientPriceId = getClientPriceId(agency.plan_type);

    if (!clientPriceId) {
      console.warn(`⚠️ No client price configured for plan ${agency.plan_type}, per-client billing skipped`);
      return { updated: false, reason: `No client price for plan ${agency.plan_type}` };
    }

    console.log(`📊 Adding per-client price item to subscription for agency ${agencyId.slice(0, 8)}...`);

    const newItem = await stripe.subscriptionItems.create({
      subscription: agency.stripe_subscription_id,
      price: clientPriceId,
      quantity: billableCount,
    });

    await supabase
      .from('agencies')
      .update({
        stripe_client_meter_item_id: newItem.id,
        billable_clients_count: billableCount,
      })
      .eq('id', agencyId);

    console.log(`✅ Per-client price item created: ${newItem.id} | ${billableCount} billable clients`);
    return { updated: true, billableCount, clientItemCreated: true };

  } catch (err) {
    console.error('❌ Client billing update error:', err.message);
    alertError('client-billing-update', err, { agencyId });
    return { updated: false, reason: err.message };
  }
}

// ============================================================================
// GET AGENCY USAGE SUMMARY
// ============================================================================
async function getAgencyUsageSummary(agencyId) {
  const billingMonth = new Date();
  billingMonth.setDate(1);
  billingMonth.setHours(0, 0, 0, 0);
  const billingMonthStr = billingMonth.toISOString().split('T')[0];

  try {
    const { data: agency } = await supabase
      .from('agencies')
      .select('plan_type, test_client_id, usage_billing_enabled')
      .eq('id', agencyId)
      .single();

    if (!agency) return null;

    const rates = getPlanRates(agency.plan_type);

    const { count: billableClients } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId)
      .eq('status', 'active')
      .eq('is_test_client', false);

    const { data: usageData } = await supabase
      .from('usage_records')
      .select('duration_seconds')
      .eq('agency_id', agencyId)
      .eq('billing_month', billingMonthStr);

    const totalSeconds = (usageData || []).reduce((sum, r) => sum + (r.duration_seconds || 0), 0);
    const totalMinutes = Math.ceil(totalSeconds / 60);
    const totalCalls = (usageData || []).length;

    const clientCharge = (billableClients || 0) * rates.perClient;
    const minuteCharge = totalMinutes * rates.perMinute;
    const platformFee = rates.platformFee;
    const estimatedTotal = platformFee + clientCharge + minuteCharge;

    return {
      plan_type: agency.plan_type,
      billing_month: billingMonthStr,
      billable_clients: billableClients || 0,
      total_calls: totalCalls,
      total_seconds: totalSeconds,
      total_minutes: totalMinutes,
      charges: {
        platform_fee: platformFee,
        per_client_rate: rates.perClient,
        client_charge: Math.round(clientCharge * 100) / 100,
        per_minute_rate: rates.perMinute,
        minute_charge: Math.round(minuteCharge * 100) / 100,
        estimated_total: Math.round(estimatedTotal * 100) / 100,
      },
    };
  } catch (err) {
    console.error('❌ Usage summary error:', err.message);
    alertError('usage-summary', err, { agencyId });
    return null;
  }
}

// ============================================================================
// RETRY UNREPORTED METER EVENTS
// ============================================================================
async function retryUnreportedMeterEvents() {
  try {
    // Records where EITHER meter event is still unreported. The two sides are
    // tracked independently, so a success on one is never undone by a failure
    // on the other. Client-side skips already mark themselves settled, so this
    // only surfaces genuine send failures on the client dimension.
    const { data: unreported } = await supabase
      .from('usage_records')
      .select('id, agency_id, client_id, duration_seconds, reported_to_stripe, client_reported_to_stripe')
      .or('reported_to_stripe.eq.false,client_reported_to_stripe.eq.false')
      .order('created_at', { ascending: true })
      .limit(100);

    if (!unreported || unreported.length === 0) {
      return { retried: 0 };
    }

    console.log(`🔄 Retrying meter events for ${unreported.length} usage record(s)...`);
    let platformOk = 0, clientOk = 0;

    for (const record of unreported) {
      const minutes = Math.ceil((record.duration_seconds || 0) / 60);
      if (minutes <= 0) continue;

      if (record.reported_to_stripe === false) {
        try { await sendVoiceMinutesMeterEvent(record.agency_id, minutes, record.id); platformOk++; }
        catch (err) { /* retried next run; alertError already fired inside */ }
      }

      if (record.client_reported_to_stripe === false) {
        try { await sendClientMinuteMeterEvent(record.client_id, minutes, record.id); clientOk++; }
        catch (err) { /* retried next run; alertError already fired inside */ }
      }
    }

    console.log(`   ✅ Retried platform=${platformOk}, client=${clientOk} across ${unreported.length} record(s)`);
    return { retried: platformOk + clientOk, total: unreported.length, platform: platformOk, client: clientOk };
  } catch (err) {
    console.error('❌ Retry unreported error:', err.message);
    alertError('retry-meter-events', err);
    return { retried: 0, error: err.message };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  PLAN_RATES,
  getPlanRates,
  insertUsageRecord,
  sendVoiceMinutesMeterEvent,
  sendClientMinuteMeterEvent,
  updateClientBillingQuantity,
  getAgencyUsageSummary,
  retryUnreportedMeterEvents,
};