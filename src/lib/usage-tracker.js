// ============================================================================
// USAGE TRACKER — Per-Call Voice Minute Tracking + Stripe Meter Events
// Location: src/lib/usage-tracker.js
// Created: 2026-05-06 — Pricing Restructure Phase 1
// Updated: 2026-05-07 — Migrated to Stripe Meters API (replaces legacy usage records)
//
// BILLING FLOW:
//   Per-minute: Real-time meter events sent to Stripe on every call completion.
//               Stripe aggregates via the voice_minutes meter and bills at period end.
//   Per-client: Subscription quantity updated when clients are added/removed.
//               Handled in client-signup routes, not here.
//
// The usage_records table remains our internal source of truth for the
// dashboard billing tab, analytics, and debugging.
// ============================================================================
const Stripe = require('stripe');
const { supabase } = require('./supabase');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================================
// PLAN RATES (for dashboard display + internal calculations)
// ============================================================================
const PLAN_RATES = {
  free:  { platformFee: 0,     perClient: 39.99, perMinute: 0.12 },
  pro:   { platformFee: 199,   perClient: 9.99,  perMinute: 0.10 },
  scale: { platformFee: 499,   perClient: 0,     perMinute: 0.05 },
};

function getPlanRates(planType) {
  return PLAN_RATES[planType] || PLAN_RATES.free;
}

// ============================================================================
// INSERT USAGE RECORD + SEND STRIPE METER EVENT
// Called from vapi-webhook on every end-of-call-report
// ============================================================================
async function insertUsageRecord({ agencyId, clientId, callId, durationSeconds }) {
  if (!agencyId || !clientId) {
    console.warn('⚠️ Usage record skipped — missing agencyId or clientId');
    return null;
  }

  const seconds = Math.max(0, Math.round(durationSeconds || 0));
  if (seconds === 0) return null;

  // Round UP to nearest minute for billing (industry standard)
  const billedMinutes = Math.ceil(seconds / 60);

  const billingMonth = new Date();
  billingMonth.setDate(1);
  billingMonth.setHours(0, 0, 0, 0);

  try {
    // ── 1. Save to our usage_records table (internal source of truth) ──
    const { data, error } = await supabase
      .from('usage_records')
      .insert({
        agency_id: agencyId,
        client_id: clientId,
        call_id: callId || null,
        duration_seconds: seconds,
        billing_month: billingMonth.toISOString().split('T')[0],
        reported_to_stripe: false,
      })
      .select('id')
      .single();

    if (error) {
      console.error('❌ Usage record insert failed:', error.message);
      return null;
    }

    console.log(`📊 Usage recorded: ${seconds}s (${billedMinutes} billed min) | agency=${agencyId.slice(0, 8)} client=${clientId.slice(0, 8)}`);

    // ── 2. Send meter event to Stripe (real-time billing) ──────────
    await sendVoiceMinutesMeterEvent(agencyId, billedMinutes, data.id);

    return data;
  } catch (err) {
    console.error('❌ Usage record error:', err.message);
    return null;
  }
}

// ============================================================================
// SEND VOICE MINUTES METER EVENT TO STRIPE
// Uses the Billing Meters API (replaces legacy subscriptionItems.createUsageRecord)
// ============================================================================
async function sendVoiceMinutesMeterEvent(agencyId, minutes, usageRecordId) {
  if (!minutes || minutes <= 0) return;

  try {
    // Get agency's Stripe customer ID
    const { data: agency } = await supabase
      .from('agencies')
      .select('stripe_customer_id, usage_billing_enabled')
      .eq('id', agencyId)
      .single();

    if (!agency?.stripe_customer_id) {
      // No Stripe customer yet (free tier without card) — skip silently
      // Minutes are tracked in usage_records, will be billed once subscription exists
      return;
    }

    if (!agency.usage_billing_enabled) {
      // Billing not enabled yet — skip but log
      console.log(`   ⏭ Meter event skipped — billing not enabled for agency ${agencyId.slice(0, 8)}`);
      return;
    }

    // Send meter event — Stripe aggregates automatically
    await stripe.billing.meterEvents.create({
      event_name: 'voice_minutes',
      payload: {
        stripe_customer_id: agency.stripe_customer_id,
        value: String(minutes),
      },
      identifier: usageRecordId || undefined, // Idempotency key — prevents double-billing on retries
    });

    // Mark as reported
    if (usageRecordId) {
      await supabase
        .from('usage_records')
        .update({ reported_to_stripe: true })
        .eq('id', usageRecordId);
    }

    console.log(`   ⚡ Meter event sent: ${minutes} min → Stripe customer ${agency.stripe_customer_id.slice(0, 12)}...`);
  } catch (err) {
    // Non-fatal — usage_record is our source of truth, meter event can be retried
    console.warn(`   ⚠️ Meter event failed (non-fatal): ${err.message}`);
    // Don't mark as reported — retry logic can pick these up later
  }
}

// ============================================================================
// UPDATE CLIENT COUNT ON SUBSCRIPTION (per-client billing)
// Called when clients are added or removed from an agency
// ============================================================================
async function updateClientBillingQuantity(agencyId) {
  try {
    const { data: agency } = await supabase
      .from('agencies')
      .select('stripe_subscription_id, stripe_client_meter_item_id, plan_type, usage_billing_enabled')
      .eq('id', agencyId)
      .single();

    if (!agency?.stripe_subscription_id || !agency?.stripe_client_meter_item_id) {
      return { updated: false, reason: 'No subscription or client price item' };
    }

    if (!agency.usage_billing_enabled) {
      return { updated: false, reason: 'Billing not enabled' };
    }

    // Scale tier has no per-client fee
    if (agency.plan_type === 'scale' || agency.plan_type === 'enterprise') {
      return { updated: false, reason: 'Scale tier — no per-client fee' };
    }

    // Count billable clients (active, non-test)
    const { count } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId)
      .eq('status', 'active')
      .eq('is_test_client', false);

    const billableCount = count || 0;

    // Update subscription item quantity
    await stripe.subscriptionItems.update(agency.stripe_client_meter_item_id, {
      quantity: billableCount,
    });

    // Update agency record
    await supabase
      .from('agencies')
      .update({ billable_clients_count: billableCount })
      .eq('id', agencyId);

    console.log(`📊 Client billing updated: ${billableCount} billable clients for agency ${agencyId.slice(0, 8)}`);
    return { updated: true, billableCount };
  } catch (err) {
    console.error('❌ Client billing update error:', err.message);
    return { updated: false, reason: err.message };
  }
}

// ============================================================================
// GET AGENCY USAGE SUMMARY (for dashboard display + billing tab)
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

    // Count billable clients
    const { count: billableClients } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId)
      .eq('status', 'active')
      .eq('is_test_client', false);

    // Sum minutes this billing period
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
    return null;
  }
}

// ============================================================================
// RETRY UNREPORTED METER EVENTS (backup for failed real-time events)
// Can be called from a cron if needed
// ============================================================================
async function retryUnreportedMeterEvents() {
  try {
    const { data: unreported } = await supabase
      .from('usage_records')
      .select('id, agency_id, duration_seconds')
      .eq('reported_to_stripe', false)
      .order('created_at', { ascending: true })
      .limit(100);

    if (!unreported || unreported.length === 0) {
      return { retried: 0 };
    }

    console.log(`🔄 Retrying ${unreported.length} unreported meter events...`);
    let success = 0;

    for (const record of unreported) {
      const minutes = Math.ceil(record.duration_seconds / 60);
      try {
        await sendVoiceMinutesMeterEvent(record.agency_id, minutes, record.id);
        success++;
      } catch (err) {
        // Will try again next run
      }
    }

    console.log(`   ✅ ${success}/${unreported.length} meter events retried`);
    return { retried: success, total: unreported.length };
  } catch (err) {
    console.error('❌ Retry unreported error:', err.message);
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
  updateClientBillingQuantity,
  getAgencyUsageSummary,
  retryUnreportedMeterEvents,
};