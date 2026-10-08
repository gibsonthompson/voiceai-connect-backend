// ============================================================================
// PER-MINUTE OVERAGE FOR SELF-BILLED PROVIDERS (Paystack / Flutterwave)
// ----------------------------------------------------------------------------
// Stripe clients are billed for overage minutes by Stripe's metered billing
// (every minute is reported to a meter whose price zero-rates the plan's
// included allotment). Paystack and Flutterwave have no metered billing, so the
// platform owns the math: at each monthly recurring charge we tally the billed
// minutes for the period that just closed, subtract the plan's included minutes,
// and multiply the overage by the agency's per-minute rate. That amount is added
// to the base plan price in the provider's recurring charge (see chargeClientOnce
// in routes/paystack.js and routes/flutterwave.js).
//
// Economics mirror the Stripe path exactly:
//   - rate = agencies.client_minute_rate_cents (cents per minute).
//   - included = the plan's included_minutes (free allotment), via getPlan.
//   - trial minutes are free unless the agency set bill_minutes_during_trial.
// Any failure returns 0 so a tally problem can never block or inflate the base
// subscription charge.
// ============================================================================
const { supabase } = require('./supabase');
const { getPlan } = require('./plans');

function includedMinutesForPlan(agency, planType) {
  const def = getPlan(agency, planType);
  const mins = def && def.included_minutes;
  return Number.isFinite(Number(mins)) ? Number(mins) : 0;
}

// Whether this agency bills its clients per minute WITHOUT relying on Stripe.
// (minutePassThroughActive in usage-tracker/stripe-connect is Stripe-gated on
// purpose; it governs Stripe meter events only.)
function selfBilledPassThroughActive(agency) {
  return !!(agency
    && agency.minute_pass_through === true
    && Number(agency.client_minute_rate_cents) > 0);
}

// Overage cents to ADD to the recurring charge for a self-billed client.
// dueDateISO is the charge's due date (clients.{provider}_next_charge_at); the
// period that just closed is [dueDate - 1 month, now], clamped so trial minutes
// are excluded when they are free. Returns an integer number of cents, 0 when
// nothing is owed.
async function computeOverageCents(client, agency, dueDateISO) {
  try {
    if (!client || !agency) return 0;
    if (!selfBilledPassThroughActive(agency)) return 0;

    // While the client is still in trial, minutes are free unless opted in.
    const inTrial = client.subscription_status === 'trial' || client.subscription_status === 'trialing';
    if (inTrial && agency.bill_minutes_during_trial !== true) return 0;

    const rate = Number(agency.client_minute_rate_cents);
    if (!(rate > 0)) return 0;

    const now = Date.now();
    const due = dueDateISO ? new Date(dueDateISO).getTime() : now;
    // Period start = one month before the due date (approximately the previous
    // charge). End at now so a late cron run still captures the whole period
    // and the next period picks up cleanly from here.
    const periodStart = new Date(due);
    periodStart.setMonth(periodStart.getMonth() - 1);
    let startMs = periodStart.getTime();

    // Exclude minutes used during the trial when those are free, by never
    // tallying before the trial ended.
    if (agency.bill_minutes_during_trial !== true && client.trial_ends_at) {
      const trialEnd = new Date(client.trial_ends_at).getTime();
      if (Number.isFinite(trialEnd)) startMs = Math.max(startMs, trialEnd);
    }
    if (startMs >= now) return 0;

    const { data, error } = await supabase
      .from('usage_records')
      .select('duration_seconds')
      .eq('client_id', client.id)
      .gte('created_at', new Date(startMs).toISOString())
      .lt('created_at', new Date(now).toISOString());
    if (error) { console.warn('⚠️ overage tally query failed:', error.message); return 0; }

    let totalMinutes = 0;
    for (const r of (data || [])) {
      totalMinutes += Math.ceil((Number(r.duration_seconds) || 0) / 60);
    }

    const included = includedMinutesForPlan(agency, client.plan_type);
    const overage = Math.max(0, totalMinutes - included);
    if (overage <= 0) return 0;

    const cents = Math.round(overage * rate);
    return cents > 0 ? cents : 0;
  } catch (e) {
    console.warn('⚠️ computeOverageCents error (charging base only):', e.message);
    return 0;
  }
}

module.exports = { computeOverageCents, includedMinutesForPlan, selfBilledPassThroughActive };