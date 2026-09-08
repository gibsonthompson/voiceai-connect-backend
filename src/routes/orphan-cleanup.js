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
const { releaseAgencyClientNumbers, releaseAgencyDemoNumber } = require('./stripe-platform');

router.post('/cleanup-orphan-clients', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;

    // 1. Agencies that are suspended or canceled (also grab their demo number).
    const { data: deadAgencies, error: aErr } = await supabase
      .from('agencies')
      .select('id, name, status, subscription_status, demo_phone_number, demo_vapi_phone_id')
      .or('status.eq.suspended,status.eq.canceled,subscription_status.eq.canceled,subscription_status.eq.cancelled');
    if (aErr) return res.status(500).json({ error: aErr.message });

    const deadById = Object.fromEntries((deadAgencies || []).map((a) => [a.id, a.name]));
    const deadIds = Object.keys(deadById);
    if (deadIds.length === 0) return res.json({ orphanClients: 0, demoLeaks: 0, message: 'No suspended/canceled agencies found' });

    // Agencies still holding a demo number (leaking).
    const demoLeaks = (deadAgencies || []).filter((a) => a.demo_phone_number || a.demo_vapi_phone_id);

    // 2. Clients still ACTIVE and still holding a number under those agencies.
    const { data: orphans, error: cErr } = await supabase
      .from('clients')
      .select('id, business_name, agency_id, status, vapi_phone_number')
      .in('agency_id', deadIds)
      .eq('status', 'active')
      .not('vapi_phone_number', 'is', null);
    if (cErr) return res.status(500).json({ error: cErr.message });

    const clientDetails = (orphans || []).map((o) => ({
      client: o.business_name, number: o.vapi_phone_number, agency: deadById[o.agency_id] || o.agency_id, agency_id: o.agency_id,
    }));
    const affectedAgencies = [...new Set((orphans || []).map((o) => o.agency_id))];

    if (dryRun) {
      return res.json({
        orphanClients: clientDetails.length,
        demoLeaks: demoLeaks.length,
        affectedAgencies: affectedAgencies.length,
        dryRun: true,
        clientDetails,
        demoDetails: demoLeaks.map((a) => ({ agency: a.name, demo_number: a.demo_phone_number })),
      });
    }

    // 3. Tear down orphaned client numbers, one agency at a time.
    let cleanedClients = 0;
    for (const agencyId of affectedAgencies) {
      try { await releaseAgencyClientNumbers(agencyId); cleanedClients++; }
      catch (e) { console.error(`cleanup: client release for ${agencyId} failed:`, e.message); }
      await new Promise((rz) => setTimeout(rz, 200));
    }

    // 4. Release leaking demo numbers for every dead agency.
    let cleanedDemos = 0;
    for (const a of demoLeaks) {
      try { await releaseAgencyDemoNumber(a.id); cleanedDemos++; }
      catch (e) { console.error(`cleanup: demo release for ${a.id} failed:`, e.message); }
      await new Promise((rz) => setTimeout(rz, 200));
    }

    console.log(`🧹 cleanup: ${clientDetails.length} orphan client(s), ${cleanedDemos} demo number(s) released`);
    res.json({ orphanClients: clientDetails.length, cleanedClientAgencies: cleanedClients, demoLeaks: demoLeaks.length, cleanedDemos, dryRun: false, clientDetails });
  } catch (e) {
    console.error('cleanup-orphan-clients error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;