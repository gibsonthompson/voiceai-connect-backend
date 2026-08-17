// ============================================================================
// MANUAL CLIENT USAGE RESET - Cron Handler
// ----------------------------------------------------------------------------
// A manual-billing client (billing_mode='manual') has NO Stripe invoice, so the
// per-period reset that connect clients get inside handleClientPaymentSucceeded
// (calls_this_month = 0, minutes_this_period = 0 at each invoice) never fires
// for them. Without this job a manual client's calls_this_month would climb,
// hit its monthly_call_limit, and then stay capped forever, because nothing
// would ever reset it. The VAPI webhook's hard cap would silently reject every
// call from that point on.
//
// This sweep resets a manual client's monthly counters when its usage_resets_at
// anchor has arrived. The anchor is set one month out at signup (see
// client-signup.js manualUsageResetAt) and advanced one calendar month at a
// time here, so a client's reset lands on the same day-of-month every cycle
// (its activation day) with no dependency on Stripe or the agency's billing
// date. If the cron was down and an anchor is several months stale, the client
// is reset ONCE and its next anchor is moved forward past now in a single pass,
// so a backlog can never cause repeated same-run resets.
//
// Only manual clients are touched. Connect clients keep resetting off their
// Stripe invoice exactly as before; this job filters on billing_mode='manual'
// and never reads or writes a connect client.
//
// Safety:
//   - billing_mode='manual' AND status='active' only. A cancelled manual client
//     (status 'cancelled') is skipped, so a dead row is never revived.
//   - dryRun reports what WOULD reset and writes nothing.
//   - Every update is re-guarded on billing_mode='manual' so it can never touch
//     a row that changed mode between the read and the write.
//   - Guarded by CRON_SECRET like every other cron in server.js.
//
// Endpoint: POST /api/cron/reset-manual-usage
//   header x-cron-secret: CRON_SECRET
//   query/body dryRun=true to preview without writing
// Schedule daily (hourly is also fine; it only acts on clients actually due).
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

// Cap rows per run so a large book can't turn one invocation into a marathon.
const MAX_PER_RUN = 500;

// ============================================================================
// Advance a monthly anchor to the first instance strictly in the future.
// ----------------------------------------------------------------------------
// Adds one calendar month at a time (Date.setMonth handles year rollover and
// short months) until the anchor is past nowMs. A normal on-time run adds
// exactly one month; a stale anchor (cron outage) is caught up in one pass so
// the client resets once, not once per missed month. Always advances at least
// one month, so a matched row (anchor <= now) can never come back unchanged.
// A missing or unparseable anchor falls back to one month from now.
// ============================================================================
function advanceAnchorPastNow(fromIso, nowMs) {
  const d = new Date(fromIso);
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date(nowMs);
    fallback.setMonth(fallback.getMonth() + 1);
    return fallback.toISOString();
  }
  do {
    d.setMonth(d.getMonth() + 1);
  } while (d.getTime() <= nowMs);
  return d.toISOString();
}

// One month from now, used to seed an anchor for a manual client that somehow
// has none (defensive; signup always sets one).
function oneMonthFromNow(nowMs) {
  const d = new Date(nowMs);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// ============================================================================
// CRON ENDPOINT
// ============================================================================
router.post('/reset-manual-usage', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  try {
    console.log(`🔁 Manual usage reset starting (now ${nowIso}, dryRun=${dryRun})`);

    // Due manual clients: manual billing, live, anchor at or before now.
    // A null anchor does NOT match .lte (null comparisons are not true in
    // Postgres), so those are handled separately by the backfill below.
    const { data: due, error: dueErr } = await supabase
      .from('clients')
      .select('id, business_name, agency_id, calls_this_month, minutes_this_period, usage_resets_at')
      .eq('billing_mode', 'manual')
      .eq('status', 'active')
      .lte('usage_resets_at', nowIso)
      .order('usage_resets_at', { ascending: true })
      .limit(MAX_PER_RUN);

    if (dueErr) {
      console.error('❌ Manual usage reset query failed:', dueErr.message);
      return res.status(500).json({ error: 'Database query failed', message: dueErr.message });
    }

    const rows = due || [];
    console.log(`📋 ${rows.length} manual client(s) due for a usage reset`);

    let reset = 0;
    let failed = 0;
    const results = [];

    for (const c of rows) {
      const nextReset = advanceAnchorPastNow(c.usage_resets_at, nowMs);

      if (dryRun) {
        results.push({
          client_id: c.id,
          business_name: c.business_name,
          agency_id: c.agency_id,
          calls_this_month: c.calls_this_month,
          minutes_this_period: c.minutes_this_period,
          old_anchor: c.usage_resets_at,
          next_anchor: nextReset,
          action: 'would_reset',
        });
        reset++;
        continue;
      }

      // Re-guard on billing_mode='manual' so a row that flipped mode between the
      // read and the write is never reset.
      const { data: updatedRows, error: updErr } = await supabase
        .from('clients')
        .update({
          calls_this_month: 0,
          minutes_this_period: 0,
          usage_resets_at: nextReset,
          updated_at: new Date().toISOString(),
        })
        .eq('id', c.id)
        .eq('billing_mode', 'manual')
        .select('id');

      if (updErr) {
        console.error(`❌ Reset failed for ${c.business_name} (${c.id}): ${updErr.message}`);
        failed++;
        results.push({ client_id: c.id, business_name: c.business_name, action: 'reset_failed', error: updErr.message });
        continue;
      }

      if (!updatedRows || updatedRows.length === 0) {
        // Row changed mode under us; nothing reset. Not an error.
        results.push({ client_id: c.id, business_name: c.business_name, action: 'skipped_mode_changed' });
        continue;
      }

      reset++;
      results.push({
        client_id: c.id,
        business_name: c.business_name,
        agency_id: c.agency_id,
        next_anchor: nextReset,
        action: 'reset',
      });
      console.log(`✅ Reset manual usage for ${c.business_name} (${c.id}), next reset ${nextReset}`);
    }

    // ── Defensive backfill: manual + active clients with NO anchor ──────────
    // Signup always sets usage_resets_at for a manual client, so this should be
    // empty. If a manual client ever has a null anchor it would never be capped
    // on a cycle (the .lte above skips nulls), so seed an anchor one month out.
    // No counter reset here: a null-anchor client has no established window yet.
    let backfilled = 0;
    const { data: noAnchor, error: naErr } = await supabase
      .from('clients')
      .select('id, business_name')
      .eq('billing_mode', 'manual')
      .eq('status', 'active')
      .is('usage_resets_at', null)
      .limit(MAX_PER_RUN);

    if (naErr) {
      console.warn('⚠️ Null-anchor backfill query failed (non-fatal):', naErr.message);
    } else if (noAnchor && noAnchor.length > 0) {
      const seed = oneMonthFromNow(nowMs);
      for (const c of noAnchor) {
        if (dryRun) {
          backfilled++;
          results.push({ client_id: c.id, business_name: c.business_name, next_anchor: seed, action: 'would_seed_anchor' });
          continue;
        }
        const { error: seedErr } = await supabase
          .from('clients')
          .update({ usage_resets_at: seed, updated_at: new Date().toISOString() })
          .eq('id', c.id)
          .eq('billing_mode', 'manual')
          .is('usage_resets_at', null);
        if (seedErr) {
          console.warn(`⚠️ Anchor seed failed for ${c.business_name} (${c.id}): ${seedErr.message}`);
        } else {
          backfilled++;
          results.push({ client_id: c.id, business_name: c.business_name, next_anchor: seed, action: 'seeded_anchor' });
        }
      }
    }

    console.log(`🔁 Manual usage reset complete: ${reset} reset, ${backfilled} anchor-seeded, ${failed} failed (dryRun=${dryRun})`);
    res.json({ success: true, dryRun, due: rows.length, reset, backfilled, failed, results });
  } catch (error) {
    console.error('❌ Manual usage reset error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

module.exports = router;