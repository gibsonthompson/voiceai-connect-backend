// ============================================================================
// SMS NUMBER ASSIGNMENT (backfill)
// ----------------------------------------------------------------------------
// Assigns client AI-receptionist numbers to the Telnyx messaging profile + the
// 10DLC campaign, so the AI's send_sms tool AND the Messages-tab replies can
// send FROM the client's own number (Telnyx 40305 "Invalid 'from' address" is
// exactly a number that isn't on the profile).
//
// assignNumberForSMS runs at provisioning but is non-fatal, so any hiccup there
// leaves a number unassigned forever. This route re-runs it. It is idempotent:
// re-assigning an already-assigned number is a no-op (campaign returns 409 →
// treated as success).
//
// Numbers that are NOT on the Telnyx account (VAPI-native numbers that were
// never bought through Telnyx) can't be assigned and are reported as
// `onTelnyx: false` — for those, sending from the client number is impossible
// and the platform-number fallback is the only option.
//
// Mount:  app.use('/api/admin', require('./routes/sms-number-assignment'));
//   POST /api/admin/assign-sms-numbers                 -> backfill ALL clients
//   POST /api/admin/assign-sms-numbers { clientId }    -> one client
//   POST /api/admin/assign-sms-numbers?dryRun=true     -> report only, no writes
// Auth: x-cron-secret header (CRON_SECRET) so it can be triggered as a one-off
// or a scheduled sweep without an admin session.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { assignNumberForSMS } = require('../lib/vapi');

router.post('/assign-sms-numbers', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const clientId = req.body?.clientId || req.query?.clientId || null;
    const dryRun = req.query?.dryRun === 'true' || req.body?.dryRun === true;

    let q = supabase
      .from('clients')
      .select('id, business_name, vapi_phone_number')
      .not('vapi_phone_number', 'is', null);
    if (clientId) q = q.eq('id', clientId);

    const { data: clients, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const results = [];
    for (const c of clients || []) {
      if (dryRun) {
        // Read-only diagnosis: look the number up on Telnyx and report whether
        // it's on the account and already on OUR messaging profile. No writes.
        let onTelnyx = false, assignedToOurProfile = false, currentProfile = null;
        try {
          if (process.env.TELNYX_API_KEY && c.vapi_phone_number) {
            const lr = await fetch(
              `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(c.vapi_phone_number)}`,
              { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
            );
            if (lr.ok) {
              const rec = ((await lr.json()).data || [])[0];
              if (rec) {
                onTelnyx = true;
                currentProfile = rec.messaging_profile_id || null;
                assignedToOurProfile = currentProfile === process.env.TELNYX_MESSAGING_PROFILE_ID;
              }
            }
          }
        } catch (e) { /* leave as unknown */ }
        results.push({
          client: c.business_name,
          number: c.vapi_phone_number,
          onTelnyx,
          assignedToOurProfile,
          status: !onTelnyx ? 'NOT_ON_TELNYX' : assignedToOurProfile ? 'OK' : 'NEEDS_ASSIGNMENT',
        });
        await new Promise((rz) => setTimeout(rz, 120));
        continue;
      }
      let r = { profileAssigned: false, campaignAssigned: false };
      try {
        r = await assignNumberForSMS(c.vapi_phone_number);
      } catch (e) {
        r = { profileAssigned: false, campaignAssigned: false, error: e.message };
      }
      results.push({
        client: c.business_name,
        number: c.vapi_phone_number,
        // profileAssigned false + no error => number not found on the Telnyx
        // account (VAPI-native): it can't send from its own number at all.
        onTelnyx: r.profileAssigned || !!r.campaignAssigned,
        profileAssigned: r.profileAssigned,
        campaignAssigned: r.campaignAssigned,
        ...(r.error ? { error: r.error } : {}),
      });
      // Gentle pacing so a large backfill doesn't hammer the Telnyx API.
      await new Promise((rz) => setTimeout(rz, 150));
    }

    let summary;
    if (dryRun) {
      summary = {
        total: results.length,
        ok: results.filter((x) => x.status === 'OK').length,
        needsAssignment: results.filter((x) => x.status === 'NEEDS_ASSIGNMENT').length,
        notOnTelnyx: results.filter((x) => x.status === 'NOT_ON_TELNYX').length,
      };
      console.log(`📇 assign-sms-numbers DRY RUN: ${summary.ok} ok, ${summary.needsAssignment} need assignment, ${summary.notOnTelnyx} not on Telnyx (of ${summary.total})`);
      return res.json({ ...summary, dryRun: true, results });
    }

    const assigned = results.filter((x) => x.profileAssigned).length;
    const notOnTelnyx = results.filter((x) => x.onTelnyx === false).length;
    console.log(`📇 assign-sms-numbers: ${assigned}/${results.length} assigned to profile${notOnTelnyx ? `, ${notOnTelnyx} not on Telnyx (VAPI-native)` : ''}`);
    res.json({ total: results.length, assigned, notOnTelnyx, dryRun: false, results });
  } catch (e) {
    console.error('❌ assign-sms-numbers error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;