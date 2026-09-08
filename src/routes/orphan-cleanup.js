// ============================================================================
// ORPHANED-CLIENT CLEANUP (backfill for the cascade gap)
// ----------------------------------------------------------------------------
// Before the subscription.updated cascade fix, an agency that lapsed via a
// Stripe subscription.UPDATED -> canceled/unpaid event was suspended but its
// clients were left ACTIVE with live, still-billing numbers. This finds those
// orphans (active clients holding a number under a suspended/canceled agency)
// and tears them down with releaseAgencyClientNumbers — the exact same teardown
// the cancel cascade runs (release the number everywhere, disable the assistant,
// set the client suspended / agency_canceled, null telephony). Idempotent.
//
// Mount:  app.use('/api/admin', require('./routes/orphan-cleanup'));
//   POST /api/admin/cleanup-orphan-clients               -> clean them up
//   POST /api/admin/cleanup-orphan-clients?dryRun=true   -> report only, no writes
// Auth: x-cron-secret header (CRON_SECRET).
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { releaseAgencyClientNumbers } = require('./stripe-platform');

router.post('/cleanup-orphan-clients', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;

    // 1. Agencies that are suspended or canceled.
    const { data: deadAgencies, error: aErr } = await supabase
      .from('agencies')
      .select('id, name, status, subscription_status')
      .or('status.eq.suspended,status.eq.canceled,subscription_status.eq.canceled,subscription_status.eq.cancelled');
    if (aErr) return res.status(500).json({ error: aErr.message });

    const deadById = Object.fromEntries((deadAgencies || []).map((a) => [a.id, a.name]));
    const deadIds = Object.keys(deadById);
    if (deadIds.length === 0) return res.json({ orphans: 0, message: 'No suspended/canceled agencies found' });

    // 2. Clients still ACTIVE and still holding a number under those agencies.
    const { data: orphans, error: cErr } = await supabase
      .from('clients')
      .select('id, business_name, agency_id, status, vapi_phone_number')
      .in('agency_id', deadIds)
      .eq('status', 'active')
      .not('vapi_phone_number', 'is', null);
    if (cErr) return res.status(500).json({ error: cErr.message });

    const details = (orphans || []).map((o) => ({
      client: o.business_name,
      number: o.vapi_phone_number,
      agency: deadById[o.agency_id] || o.agency_id,
      agency_id: o.agency_id,
    }));
    const affectedAgencies = [...new Set((orphans || []).map((o) => o.agency_id))];

    if (dryRun) {
      return res.json({ orphans: details.length, affectedAgencies: affectedAgencies.length, dryRun: true, details });
    }

    // 3. Tear down, one agency at a time. releaseAgencyClientNumbers handles
    //    every number-holding client under the agency (idempotent for any
    //    already torn down).
    let cleaned = 0;
    for (const agencyId of affectedAgencies) {
      try {
        await releaseAgencyClientNumbers(agencyId);
        cleaned++;
      } catch (e) {
        console.error(`cleanup-orphan-clients: agency ${agencyId} failed:`, e.message);
      }
      await new Promise((rz) => setTimeout(rz, 200));
    }

    console.log(`🧹 cleanup-orphan-clients: ${details.length} orphan client(s) across ${affectedAgencies.length} agencies torn down`);
    res.json({ orphans: details.length, cleanedAgencies: cleaned, dryRun: false, details });
  } catch (e) {
    console.error('cleanup-orphan-clients error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;