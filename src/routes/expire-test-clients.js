// ============================================================================
// EXPIRE TEST CLIENTS - Cron Handler
// ----------------------------------------------------------------------------
// Test clients are created status='active' / subscription_status='active', so
// they are invisible to expireTrials (which only targets trial/trialing) AND to
// reconcile-telnyx (which leaves numbers that a live client legitimately
// references). Left alone, every test client holds a Telnyx number that bills
// every month, forever. This job is the missing auto-cleanup: it releases the
// number for test clients that have aged past a cutoff and were NOT used this
// billing period, then removes them, so demo lines stop billing on their own
// the way real trials do.
//
// This is about TEST CLIENTS ONLY (clients.is_test_client = true). It never
// touches an agency's demo number (agencies.demo_phone_number / demo_vapi_phone_id).
//
// POST /api/cron/expire-test-clients            → dry run (lists what it would do)
// POST /api/cron/expire-test-clients?apply=true → actually release + delete
// Auth: same x-cron-secret header as the other cron routes.
// Tune with TEST_CLIENT_EXPIRE_DAYS (default 30). A test client with
// calls_this_month > 0 is spared (it's actively being used).
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { fullyReleaseNumber } = require('../lib/vapi');

const EXPIRE_DAYS = parseInt(process.env.TEST_CLIENT_EXPIRE_DAYS || '30', 10);

router.post('/expire-test-clients', async (req, res) => {
  // Same gate as the other cron routes.
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.apply !== 'true';
  const cutoff = new Date(Date.now() - EXPIRE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data: aged, error } = await supabase
      .from('clients')
      .select('id, business_name, agency_id, vapi_phone_id, vapi_phone_number, vapi_assistant_id, calls_this_month, created_at')
      .eq('is_test_client', true)
      .lt('created_at', cutoff);

    if (error) {
      console.error('❌ expire-test-clients query failed:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // Spare any test client that's actually been used this billing period.
    const candidates = (aged || []).filter((c) => !c.calls_this_month || c.calls_this_month === 0);
    const sparedInUse = (aged || []).length - candidates.length;

    const results = [];
    for (const c of candidates) {
      if (dryRun) {
        results.push({
          id: c.id,
          business_name: c.business_name,
          number: c.vapi_phone_number || null,
          created_at: c.created_at,
          action: 'would_release',
        });
        continue;
      }

      // 1) Release the number (VAPI object + Telnyx rental → stops billing).
      let release = { vapiDeleted: false, telnyxReleased: false };
      if (c.vapi_phone_id || c.vapi_phone_number) {
        try {
          release = await fullyReleaseNumber(c.vapi_phone_id, c.vapi_phone_number);
          if (!release.telnyxReleased && c.vapi_phone_number) {
            console.error(`⚠️ Telnyx NOT released for aged test client ${c.business_name} (${c.vapi_phone_number}); reconcile-telnyx is the backstop`);
          }
        } catch (relErr) {
          console.error(`❌ expire-test-clients release failed for ${c.business_name}:`, relErr.message);
        }
      }

      // 2) Delete the VAPI assistant.
      if (c.vapi_assistant_id && process.env.VAPI_API_KEY) {
        try {
          await fetch(`https://api.vapi.ai/assistant/${c.vapi_assistant_id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` },
          });
        } catch (asstErr) {
          console.error(`❌ expire-test-clients assistant delete failed for ${c.business_name}:`, asstErr.message);
        }
      }

      // 3) Clear the agency pointer if it points at this client, then delete the row.
      await supabase.from('agencies').update({ test_client_id: null }).eq('test_client_id', c.id);
      const { error: delErr } = await supabase
        .from('clients').delete()
        .eq('id', c.id)
        .eq('is_test_client', true);
      if (delErr) {
        console.error(`❌ expire-test-clients row delete failed for ${c.business_name}:`, delErr.message);
      }

      console.log(`🧹 Expired test client ${c.business_name} (${c.vapi_phone_number || 'no number'}) — Telnyx released: ${release.telnyxReleased}`);
      results.push({
        id: c.id,
        business_name: c.business_name,
        number: c.vapi_phone_number || null,
        telnyxReleased: release.telnyxReleased,
        action: 'released',
      });
    }

    return res.json({
      success: true,
      dryRun,
      expireDays: EXPIRE_DAYS,
      agedFound: (aged || []).length,
      sparedInUse,
      processed: results.length,
      results,
    });
  } catch (e) {
    console.error('❌ expire-test-clients error:', e);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;