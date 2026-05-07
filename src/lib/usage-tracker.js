// ============================================================================
// USAGE TRACKER — Per-Call Voice Minute Tracking for Metered Billing
// Location: src/lib/usage-tracker.js
// Created: 2026-05-06 — Pricing Restructure Phase 1
// ============================================================================
const { supabase } = require('./supabase');

// ============================================================================
// NEW PLAN RATES (replaces fixed pricing)
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
// INSERT USAGE RECORD (called from vapi-webhook on every end-of-call-report)
// ============================================================================
async function insertUsageRecord({ agencyId, clientId, callId, durationSeconds }) {
  if (!agencyId || !clientId) {
    console.warn('⚠️ Usage record skipped — missing agencyId or clientId');
    return null;
  }

  // Default to 0 if no duration (shouldn't happen but be safe)
  const seconds = Math.max(0, Math.round(durationSeconds || 0));
  
  // Round UP to nearest minute for billing (industry standard)
  // e.g., 61 seconds = 2 minutes billed
  const billedMinutes = seconds > 0 ? Math.ceil(seconds / 60) : 0;

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
        billing_month: billingMonth.toISOString().split('T')[0],
        reported_to_stripe: false,
      })
      .select('id')
      .single();

    if (error) {
      console.error('❌ Usage record insert failed:', error.message);
      return null;
    }

    // Update agency running total
    await supabase.rpc('increment_agency_minutes', {
      p_agency_id: agencyId,
      p_minutes: billedMinutes,
    }).catch(() => {
      // Fallback if RPC doesn't exist yet — raw update
      supabase
        .from('agencies')
        .update({ minutes_this_month: supabase.raw(`minutes_this_month + ${billedMinutes}`) })
        .eq('id', agencyId)
        .then(() => {})
        .catch((e) => console.warn('⚠️ Could not increment minutes_this_month:', e.message));
    });

    console.log(`📊 Usage recorded: ${seconds}s (${billedMinutes} billed min) | agency=${agencyId.slice(0,8)} client=${clientId.slice(0,8)}`);
    return data;
  } catch (err) {
    console.error('❌ Usage record error:', err.message);
    return null;
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
    // Get agency plan info
    const { data: agency } = await supabase
      .from('agencies')
      .select('plan_type, test_client_id, usage_billing_enabled')
      .eq('id', agencyId)
      .single();

    if (!agency) return null;

    const rates = getPlanRates(agency.plan_type);

    // Count billable clients (active, excluding test client)
    let clientQuery = supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId)
      .eq('status', 'active')
      .eq('is_test_client', false);

    const { count: billableClients } = await clientQuery;

    // Sum minutes this billing period
    const { data: usageData } = await supabase
      .from('usage_records')
      .select('duration_seconds')
      .eq('agency_id', agencyId)
      .eq('billing_month', billingMonthStr);

    const totalSeconds = (usageData || []).reduce((sum, r) => sum + (r.duration_seconds || 0), 0);
    const totalMinutes = Math.ceil(totalSeconds / 60);
    const totalCalls = (usageData || []).length;

    // Calculate estimated charges
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
// GET UNREPORTED USAGE (for Stripe usage reporter cron)
// Returns aggregated minutes per agency that haven't been reported yet
// ============================================================================
async function getUnreportedUsageByAgency() {
  try {
    const { data, error } = await supabase
      .from('usage_records')
      .select('id, agency_id, client_id, duration_seconds, billing_month')
      .eq('reported_to_stripe', false)
      .order('agency_id');

    if (error) {
      console.error('❌ Unreported usage query failed:', error.message);
      return [];
    }

    // Aggregate by agency
    const agencyMap = {};
    for (const record of data || []) {
      if (!agencyMap[record.agency_id]) {
        agencyMap[record.agency_id] = {
          agency_id: record.agency_id,
          total_seconds: 0,
          total_billed_minutes: 0,
          record_ids: [],
          unique_clients: new Set(),
        };
      }
      const entry = agencyMap[record.agency_id];
      entry.total_seconds += record.duration_seconds || 0;
      entry.record_ids.push(record.id);
      entry.unique_clients.add(record.client_id);
    }

    // Convert sets to counts and compute billed minutes
    return Object.values(agencyMap).map((entry) => ({
      agency_id: entry.agency_id,
      total_seconds: entry.total_seconds,
      total_billed_minutes: Math.ceil(entry.total_seconds / 60),
      record_count: entry.record_ids.length,
      record_ids: entry.record_ids,
      unique_client_count: entry.unique_clients.size,
    }));
  } catch (err) {
    console.error('❌ Unreported usage error:', err.message);
    return [];
  }
}

// ============================================================================
// MARK RECORDS AS REPORTED (after Stripe usage record created)
// ============================================================================
async function markRecordsAsReported(recordIds, stripeUsageRecordId = null) {
  if (!recordIds || recordIds.length === 0) return;

  try {
    const { error } = await supabase
      .from('usage_records')
      .update({
        reported_to_stripe: true,
        stripe_usage_record_id: stripeUsageRecordId,
      })
      .in('id', recordIds);

    if (error) {
      console.error('❌ Failed to mark records as reported:', error.message);
    }
  } catch (err) {
    console.error('❌ markRecordsAsReported error:', err.message);
  }
}

// ============================================================================
// UPDATE BILLABLE CLIENT COUNT (call when clients are added/removed)
// ============================================================================
async function updateBillableClientCount(agencyId) {
  try {
    const { count } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId)
      .eq('status', 'active')
      .eq('is_test_client', false);

    await supabase
      .from('agencies')
      .update({ billable_clients_count: count || 0 })
      .eq('id', agencyId);

    return count || 0;
  } catch (err) {
    console.error('❌ updateBillableClientCount error:', err.message);
    return 0;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  PLAN_RATES,
  getPlanRates,
  insertUsageRecord,
  getAgencyUsageSummary,
  getUnreportedUsageByAgency,
  markRecordsAsReported,
  updateBillableClientCount,
};