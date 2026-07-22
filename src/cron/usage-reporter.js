// ============================================================================
// USAGE CRON JOBS — Trial Expiration, Monthly Reset, Meter Event Retry
// Location: src/cron/usage-reporter.js
// Updated: 2026-05-07 — Removed legacy Stripe usage reporting (replaced by
//   real-time meter events in usage-tracker.js)
// Updated: 2026-06-03 — expireAgencyTrials now (a) releases the demo number
//   (VAPI object + underlying Telnyx number) on expiry so the rental stops,
//   and (b) catches legacy/null plan_types that previously slipped through
//   both filters and got stuck in 'trialing' forever.
// Updated: 2026-07-22. resetMonthlyCounters now ALSO zeroes
//   clients.calls_this_month, not just agencies.minutes_this_month. That client
//   call counter is what the vapi webhook checks against monthly_call_limit,
//   and it was never being reset here, so it accumulated across months. This is
//   the fix for the "call counter seems low / never resets" report: the monthly
//   cron was only resetting the agency minute rollup on a different table.
//
// CRON ROUTES:
//   POST /api/cron/expire-agency-trials  — Daily, expires stale agency trials
//   POST /api/cron/reset-monthly-counters — 1st of month, resets running totals
//   POST /api/cron/retry-meter-events    — Daily, retries failed meter events
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { retryUnreportedMeterEvents } = require('../lib/usage-tracker');
const { fullyReleaseNumber } = require('../lib/vapi');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// EXPIRE AGENCY TRIALS
// Fixes bug where expired trials stay in 'trialing' forever if no calls come in.
// Free/Starter plan → active (free tier has no trial concept)
// Any other plan with NO Stripe subscription → expired/suspended + demo released
// Any plan WITH a Stripe subscription → leave alone (Stripe webhooks handle it)
//
// On expiry we now RELEASE the agency demo number (VAPI phone object AND the
// underlying Telnyx number) before nulling the demo fields — otherwise the
// Telnyx rental keeps billing every month on a dead agency.
// ============================================================================
async function expireAgencyTrials() {
  console.log('⏰ Checking for expired agency trials...');

  try {
    const now = new Date().toISOString();

    // ── 1. Free / Starter agencies stuck in trialing → make active ──────────
    //    (these tiers have no trial; they just keep their demo, no release)
    const { data: freeExpired } = await supabase
      .from('agencies')
      .update({ subscription_status: 'active', status: 'active', trial_ends_at: null })
      .in('subscription_status', ['trial', 'trialing'])
      .in('plan_type', ['free', 'starter'])
      .or(`trial_ends_at.is.null,trial_ends_at.lt.${now}`)
      .select('id, name');

    if (freeExpired?.length > 0) {
      console.log(`   ✅ ${freeExpired.length} free agencies fixed: ${freeExpired.map(a => a.name).join(', ')}`);
    }

    // ── 2. Any remaining trial/trialing agency with NO Stripe subscription ──
    //    whose trial has expired → expire + release demo number.
    //    Select first so we can release each demo number before nulling it.
    //    No plan_type filter here on purpose: after step 1, free/starter are
    //    already 'active', so whatever is still trial/trialing here is a real
    //    expired trial — including legacy/null plan_types that used to slip
    //    through. (A JS guard below re-activates any free/starter that step 1
    //    somehow failed to update, so they can never be wrongly suspended.)
    const { data: toExpire, error: selErr } = await supabase
      .from('agencies')
      .select('id, name, plan_type, demo_vapi_phone_id, demo_phone_number, demo_assistant_id')
      .in('subscription_status', ['trial', 'trialing'])
      .is('stripe_subscription_id', null)
      .or(`trial_ends_at.is.null,trial_ends_at.lt.${now}`);

    if (selErr) {
      console.error('❌ Failed to select expiring agencies:', selErr.message);
    }

    let paidExpired = 0;
    let demosReleased = 0;

    for (const agency of toExpire || []) {
      const plan = (agency.plan_type || '').toLowerCase();

      // Safety net: free/starter should already be active from step 1.
      // If one slipped through, activate it — never suspend a free agency.
      if (plan === 'free' || plan === 'starter') {
        await supabase
          .from('agencies')
          .update({ subscription_status: 'active', status: 'active', trial_ends_at: null })
          .eq('id', agency.id);
        continue;
      }

      // ── Release the demo number: VAPI object + underlying Telnyx rental ──
      if (agency.demo_vapi_phone_id || agency.demo_phone_number) {
        try {
          const release = await fullyReleaseNumber(agency.demo_vapi_phone_id, agency.demo_phone_number);
          if (release.telnyxReleased) demosReleased++;
          console.log(`   📞 Demo released for ${agency.name}: VAPI=${release.vapiDeleted} Telnyx=${release.telnyxReleased}`);
          if (!release.telnyxReleased) {
            console.error(`   ⚠️ Telnyx demo NOT released for ${agency.name} (${agency.demo_phone_number}) — orphan sweep will catch it`);
          }
        } catch (relErr) {
          console.error(`   ❌ Demo release failed for ${agency.name}:`, relErr.message);
        }
      }

      // ── Best-effort delete of the demo VAPI assistant (free, just tidy) ──
      if (agency.demo_assistant_id && VAPI_API_KEY) {
        try {
          await fetch(`https://api.vapi.ai/assistant/${agency.demo_assistant_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
          });
        } catch (e) { /* non-blocking */ }
      }

      // ── Flip status + null the demo fields ──
      const { error: updErr } = await supabase
        .from('agencies')
        .update({
          subscription_status: 'expired',
          status: 'suspended',
          demo_phone_number: null,
          demo_assistant_id: null,
          demo_vapi_phone_id: null,
        })
        .eq('id', agency.id);

      if (updErr) {
        console.error(`   ❌ Failed to expire ${agency.name}:`, updErr.message);
      } else {
        paidExpired++;
      }
    }

    if (paidExpired > 0) {
      console.log(`   ⏳ ${paidExpired} paid trials expired, ${demosReleased} demo numbers released`);
    }

    const totalFixed = (freeExpired?.length || 0) + paidExpired;
    if (totalFixed === 0) {
      console.log('   ✅ No expired agency trials found');
    }

    return {
      success: true,
      free_fixed: freeExpired?.length || 0,
      paid_expired: paidExpired,
      demos_released: demosReleased,
    };
  } catch (err) {
    console.error('❌ Agency trial expiration error:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================================
// RESET MONTHLY COUNTERS (run on 1st of each month)
// ----------------------------------------------------------------------------
// Two independent monthly counters get zeroed here:
//   1. agencies.minutes_this_month, the agency-level voice-minute rollup shown
//      on billing dashboards. This one was already being reset correctly.
//   2. clients.calls_this_month, the per-client monthly call count the vapi
//      webhook checks against monthly_call_limit before answering. This was
//      NOT being reset anywhere, so it accumulated forever and the plan cap
//      drifted (and the "calls this month" numbers read as lifetime totals).
//      Zeroing it here on the 1st gives every client a fresh monthly allotment.
//
// Both updates are scoped with .neq(col, 0) so only rows that actually hold a
// non-zero value are written, which keeps the write set small. Each stage
// checks its own error; if the client stage fails, the agency result is still
// reported so a partial run is visible rather than silent.
// ============================================================================
async function resetMonthlyCounters() {
  console.log('🔄 Resetting monthly usage counters...');

  let agencyReset = 0;
  let clientReset = 0;

  // ── 1. Agency minute rollups ──────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('agencies')
      .update({ minutes_this_month: 0 })
      .neq('minutes_this_month', 0)
      .select('id, name');

    if (error) {
      console.error('❌ Agency minute reset failed:', error.message);
      return { success: false, stage: 'agencies', error: error.message };
    }

    agencyReset = (data || []).length;
    console.log(`✅ Reset ${agencyReset} agency minute counters`);
  } catch (err) {
    console.error('❌ Agency minute reset error:', err.message);
    return { success: false, stage: 'agencies', error: err.message };
  }

  // ── 2. Client monthly CALL counters (the plan-limit gate reads this) ──
  //    This is the reset that was missing. clients.calls_this_month is what
  //    vapi-webhook.js compares to monthly_call_limit. Only touch non-zero
  //    rows. On the 1st the new month has no calls yet, so zeroing is correct
  //    and hands each client back their full monthly cap.
  try {
    const { data, error } = await supabase
      .from('clients')
      .update({ calls_this_month: 0 })
      .neq('calls_this_month', 0)
      .select('id, business_name');

    if (error) {
      console.error('❌ Client call-counter reset failed:', error.message);
      return { success: false, stage: 'clients', error: error.message, agency_minute_counters_reset: agencyReset };
    }

    clientReset = (data || []).length;
    console.log(`✅ Reset ${clientReset} client call counters`);
  } catch (err) {
    console.error('❌ Client call-counter reset error:', err.message);
    return { success: false, stage: 'clients', error: err.message, agency_minute_counters_reset: agencyReset };
  }

  return {
    success: true,
    agency_minute_counters_reset: agencyReset,
    client_call_counters_reset: clientReset,
  };
}

// ============================================================================
// CRON ROUTES
// ============================================================================

router.post('/expire-agency-trials', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await expireAgencyTrials();
    res.json({ success: true, message: 'Agency trial expiration check completed', ...result });
  } catch (error) {
    console.error('❌ Cron expire-agency-trials error:', error);
    res.status(500).json({ error: 'Failed to run agency trial expiration' });
  }
});

router.post('/reset-monthly-counters', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await resetMonthlyCounters();
    res.json({ success: true, message: 'Monthly counters reset', ...result });
  } catch (error) {
    console.error('❌ Cron reset-monthly error:', error);
    res.status(500).json({ error: 'Failed to reset monthly counters' });
  }
});

router.post('/retry-meter-events', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await retryUnreportedMeterEvents();
    res.json({ success: true, message: 'Meter event retry completed', ...result });
  } catch (error) {
    console.error('❌ Cron retry-meter-events error:', error);
    res.status(500).json({ error: 'Failed to retry meter events' });
  }
});

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = router;
module.exports.expireAgencyTrials = expireAgencyTrials;
module.exports.resetMonthlyCounters = resetMonthlyCounters;