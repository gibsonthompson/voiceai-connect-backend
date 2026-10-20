// ============================================================================
// EXPIRE DEMO PHONES - Cron Handler
// ----------------------------------------------------------------------------
// Free-plan agencies get ONE free demo line (no card) that lives 30 days. Each
// free demo is stamped with agencies.demo_expires_at at provisioning time. Left
// alone, that demo number holds a Telnyx rental that bills every month forever.
// This job is the auto-cleanup: it releases the number (VAPI object + Telnyx
// rental, and the agency's own Twilio for a BYOT demo) and clears the demo
// fields once demo_expires_at has passed, so free demo lines stop billing on
// their own, exactly like trials do.
//
// Scope: ONLY Free-plan agencies with an expiry in the past. If the agency has
// since upgraded to a paid plan, its demo is permanent, so plan_type='free'
// filters it out and we leave it alone (the stale deadline is harmless and gets
// cleared on their next demo delete). demo_free_used is intentionally LEFT set,
// so a Free agency does not get a second free demo after this one expires; a
// new one then needs a card or an upgrade (enforced in demo-phone.js).
//
// POST /api/cron/expire-demo-phones            → dry run (lists what it would do)
// POST /api/cron/expire-demo-phones?apply=true → actually release + clear
// Auth: same x-cron-secret header as the other cron routes.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { fullyReleaseNumber } = require('../lib/vapi');
const { releaseBYOTNumber } = require('./byot');

router.post('/expire-demo-phones', async (req, res) => {
  // Same gate as the other cron routes.
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.apply !== 'true';
  const nowIso = new Date().toISOString();

  try {
    const { data: aged, error } = await supabase
      .from('agencies')
      .select('id, name, plan_type, demo_phone_number, demo_vapi_phone_id, demo_assistant_id, demo_expires_at, byot_enabled, twilio_account_sid, twilio_api_key_encrypted, twilio_api_secret_encrypted, country')
      .eq('plan_type', 'free')
      .not('demo_phone_number', 'is', null)
      .not('demo_expires_at', 'is', null)
      .lte('demo_expires_at', nowIso);

    if (error) {
      console.error('❌ expire-demo-phones query failed:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const results = [];
    for (const a of (aged || [])) {
      if (dryRun) {
        results.push({
          id: a.id,
          name: a.name,
          number: a.demo_phone_number || null,
          demo_expires_at: a.demo_expires_at,
          action: 'would_release',
        });
        continue;
      }

      // 1) Release the number (VAPI object + platform Telnyx rental → stops billing).
      let release = { vapiDeleted: false, telnyxReleased: false };
      if (a.demo_vapi_phone_id || a.demo_phone_number) {
        try {
          release = await fullyReleaseNumber(a.demo_vapi_phone_id, a.demo_phone_number);
          if (!release.telnyxReleased && a.demo_phone_number) {
            console.error(`⚠️ Telnyx NOT released for expired demo ${a.name} (${a.demo_phone_number}); reconcile-telnyx is the backstop`);
          }
        } catch (relErr) {
          console.error(`❌ expire-demo-phones release failed for ${a.name}:`, relErr.message);
        }
      }

      // 1b) International (BYOT) demo: the real carrier number lives on the
      //     agency's own Twilio, which fullyReleaseNumber does not touch.
      if (a.byot_enabled && a.twilio_account_sid && a.twilio_api_key_encrypted) {
        try {
          await releaseBYOTNumber(a, a.demo_phone_number);
        } catch (twErr) {
          console.warn(`⚠️ expire-demo-phones Twilio release failed for ${a.name}:`, twErr.message);
        }
      }

      // 2) Delete the VAPI assistant.
      if (a.demo_assistant_id && process.env.VAPI_API_KEY) {
        try {
          await fetch(`https://api.vapi.ai/assistant/${a.demo_assistant_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` },
          });
        } catch (asstErr) {
          console.error(`❌ expire-demo-phones assistant delete failed for ${a.name}:`, asstErr.message);
        }
      }

      // 3) Clear the demo fields. demo_free_used stays set on purpose, so the
      //    agency does not get another free demo after this one.
      const { error: updErr } = await supabase
        .from('agencies')
        .update({
          demo_phone_number: null,
          demo_vapi_phone_id: null,
          demo_assistant_id: null,
          demo_expires_at: null,
          updated_at: nowIso,
        })
        .eq('id', a.id);
      if (updErr) {
        console.error(`❌ expire-demo-phones clear failed for ${a.name}:`, updErr.message);
      }

      console.log(`🧹 Expired free demo for ${a.name} (${a.demo_phone_number || 'no number'}) — Telnyx released: ${release.telnyxReleased}`);
      results.push({
        id: a.id,
        name: a.name,
        number: a.demo_phone_number || null,
        telnyxReleased: release.telnyxReleased,
        action: 'released',
      });
    }

    return res.json({
      success: true,
      dryRun,
      found: (aged || []).length,
      processed: results.length,
      results,
    });
  } catch (e) {
    console.error('❌ expire-demo-phones error:', e);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;