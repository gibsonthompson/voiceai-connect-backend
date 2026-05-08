// ============================================================================
// USAGE CRON JOBS — Trial Expiration, Monthly Reset, Meter Event Retry
// Location: src/cron/usage-reporter.js
// Updated: 2026-05-07 — Removed legacy Stripe usage reporting (replaced by
//   real-time meter events in usage-tracker.js)
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

// ============================================================================
// EXPIRE AGENCY TRIALS
// Fixes bug where expired trials stay in 'trialing' forever if no calls come in.
// Free plan → active (free tier has no trial concept)
// Pro/Scale with no Stripe subscription → expired/suspended
// Pro/Scale with Stripe subscription → leave alone (Stripe webhooks handle it)
// ============================================================================
async function expireAgencyTrials() {
  console.log('⏰ Checking for expired agency trials...');

  try {
    const now = new Date().toISOString();

    // Free plan agencies stuck in trialing → make active
    const { data: freeExpired } = await supabase
      .from('agencies')
      .update({ subscription_status: 'active', status: 'active', trial_ends_at: null })
      .in('subscription_status', ['trial', 'trialing'])
      .eq('plan_type', 'free')
      .or(`trial_ends_at.is.null,trial_ends_at.lt.${now}`)
      .select('id, name');

    if (freeExpired?.length > 0) {
      console.log(`   ✅ ${freeExpired.length} free agencies fixed: ${freeExpired.map(a => a.name).join(', ')}`);
    }

    // Pro/Scale with expired trials and NO Stripe subscription → expired
    const { data: paidExpired } = await supabase
      .from('agencies')
      .update({ subscription_status: 'expired', status: 'suspended' })
      .in('subscription_status', ['trial', 'trialing'])
      .in('plan_type', ['pro', 'scale', 'professional', 'enterprise'])
      .is('stripe_subscription_id', null)
      .or(`trial_ends_at.is.null,trial_ends_at.lt.${now}`)
      .select('id, name');

    if (paidExpired?.length > 0) {
      console.log(`   ⏳ ${paidExpired.length} paid trials expired: ${paidExpired.map(a => a.name).join(', ')}`);
    }

    const totalFixed = (freeExpired?.length || 0) + (paidExpired?.length || 0);
    if (totalFixed === 0) {
      console.log('   ✅ No expired agency trials found');
    }

    return {
      success: true,
      free_fixed: freeExpired?.length || 0,
      paid_expired: paidExpired?.length || 0,
    };
  } catch (err) {
    console.error('❌ Agency trial expiration error:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================================
// RESET MONTHLY COUNTERS (run on 1st of each month)
// ============================================================================
async function resetMonthlyCounters() {
  console.log('🔄 Resetting monthly usage counters...');

  try {
    const { data, error } = await supabase
      .from('agencies')
      .update({ minutes_this_month: 0 })
      .neq('minutes_this_month', 0)
      .select('id, name');

    if (error) {
      console.error('❌ Monthly counter reset failed:', error.message);
      return { success: false, error: error.message };
    }

    console.log(`✅ Reset ${(data || []).length} agency counters`);
    return { success: true, reset_count: (data || []).length };
  } catch (err) {
    console.error('❌ Monthly reset error:', err.message);
    return { success: false, error: err.message };
  }
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