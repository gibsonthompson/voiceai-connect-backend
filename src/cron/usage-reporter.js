// ============================================================================
// USAGE REPORTER CRON — Reports Voice Minutes to Stripe Metered Billing
// Location: src/cron/usage-reporter.js
// Created: 2026-05-06 — Pricing Restructure Phase 1
//
// Called via cron-job.org or internal cron route.
// Runs daily — aggregates unreported usage_records per agency,
// reports minutes to Stripe via subscription item usage records,
// and reports billable client count for per-client metered pricing.
// ============================================================================
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { supabase } = require('../lib/supabase');
const {
  getUnreportedUsageByAgency,
  markRecordsAsReported,
  updateBillableClientCount,
  getPlanRates,
} = require('../lib/usage-tracker');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================================================
// REPORT USAGE TO STRIPE (main cron handler)
// ============================================================================
async function reportUsageToStripe() {
  console.log('📊 Usage reporter starting...');
  const results = { processed: 0, skipped: 0, errors: 0, details: [] };

  try {
    // 1. Get all unreported usage aggregated by agency
    const unreported = await getUnreportedUsageByAgency();
    console.log(`   Found ${unreported.length} agencies with unreported usage`);

    if (unreported.length === 0) {
      console.log('   Nothing to report — all caught up');
      return results;
    }

    // 2. For each agency, report to Stripe
    for (const entry of unreported) {
      try {
        // Get agency Stripe info
        const { data: agency } = await supabase
          .from('agencies')
          .select('id, name, plan_type, stripe_subscription_id, stripe_minute_meter_item_id, stripe_client_meter_item_id, usage_billing_enabled, test_client_id')
          .eq('id', entry.agency_id)
          .single();

        if (!agency) {
          console.warn(`   ⚠️ Agency not found: ${entry.agency_id}`);
          results.skipped++;
          continue;
        }

        // Skip if no Stripe subscription (free tier without card, or not set up yet)
        if (!agency.stripe_subscription_id) {
          console.log(`   ⏭ ${agency.name}: No Stripe subscription — skipping usage report`);
          // Still mark as reported so they don't pile up
          // These will be billed once the agency adds a payment method
          await markRecordsAsReported(entry.record_ids, 'no_subscription');
          results.skipped++;
          continue;
        }

        // Skip if usage billing not enabled yet (migration in progress)
        if (!agency.usage_billing_enabled) {
          console.log(`   ⏭ ${agency.name}: Usage billing not enabled — skipping`);
          results.skipped++;
          continue;
        }

        const minutesToReport = entry.total_billed_minutes;
        console.log(`   📈 ${agency.name}: ${minutesToReport} minutes, ${entry.record_count} calls`);

        // ── Report MINUTES to Stripe ────────────────────────────────────
        if (agency.stripe_minute_meter_item_id && minutesToReport > 0) {
          try {
            const usageRecord = await stripe.subscriptionItems.createUsageRecord(
              agency.stripe_minute_meter_item_id,
              {
                quantity: minutesToReport,
                timestamp: Math.floor(Date.now() / 1000),
                action: 'increment',
              }
            );
            console.log(`   ✅ Minutes reported to Stripe: ${minutesToReport} (record: ${usageRecord.id})`);
            await markRecordsAsReported(entry.record_ids, usageRecord.id);
          } catch (stripeErr) {
            console.error(`   ❌ Stripe minute report failed for ${agency.name}:`, stripeErr.message);
            results.errors++;
            results.details.push({ agency: agency.name, error: stripeErr.message, type: 'minutes' });
            continue; // Don't mark as reported — retry next run
          }
        } else {
          // No meter item or 0 minutes — just mark as reported
          await markRecordsAsReported(entry.record_ids, 'no_meter_item');
        }

        // ── Report BILLABLE CLIENTS to Stripe ──────────────────────────
        // Client count is reported as a SET (not increment) — Stripe charges
        // based on the latest reported quantity for the billing period.
        if (agency.stripe_client_meter_item_id) {
          try {
            const billableCount = await updateBillableClientCount(entry.agency_id);
            
            if (billableCount > 0) {
              await stripe.subscriptionItems.createUsageRecord(
                agency.stripe_client_meter_item_id,
                {
                  quantity: billableCount,
                  timestamp: Math.floor(Date.now() / 1000),
                  action: 'set', // SET not increment — replaces previous value
                }
              );
              console.log(`   ✅ Client count reported to Stripe: ${billableCount}`);
            }
          } catch (clientErr) {
            console.error(`   ❌ Stripe client count report failed for ${agency.name}:`, clientErr.message);
            // Non-fatal — minutes were already reported
          }
        }

        results.processed++;
        results.details.push({
          agency: agency.name,
          minutes: minutesToReport,
          calls: entry.record_count,
          success: true,
        });

      } catch (agencyErr) {
        console.error(`   ❌ Error processing agency ${entry.agency_id}:`, agencyErr.message);
        results.errors++;
        results.details.push({ agency_id: entry.agency_id, error: agencyErr.message });
      }
    }

    console.log(`📊 Usage reporter complete: ${results.processed} processed, ${results.skipped} skipped, ${results.errors} errors`);
    return results;

  } catch (err) {
    console.error('❌ Usage reporter crashed:', err.message);
    results.errors++;
    return results;
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
// CRON ROUTE — POST /api/cron/report-usage
// ============================================================================
router.post('/report-usage', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const results = await reportUsageToStripe();
    res.json({ success: true, message: 'Usage reporting completed', ...results });
  } catch (error) {
    console.error('❌ Cron report-usage error:', error);
    res.status(500).json({ error: 'Failed to run usage reporter' });
  }
});

// ============================================================================
// CRON ROUTE — POST /api/cron/reset-monthly-counters
// ============================================================================
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

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = router;
module.exports.reportUsageToStripe = reportUsageToStripe;
module.exports.resetMonthlyCounters = resetMonthlyCounters;