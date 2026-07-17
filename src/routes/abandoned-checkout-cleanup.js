// ============================================================================
// ABANDONED CHECKOUT CLEANUP - Cron Handler
// ----------------------------------------------------------------------------
// Closes the card-required signup cost leak. handleClientSignup (client-signup.js
// STEP 2/3) provisions a VAPI assistant and rents a Telnyx number BEFORE the
// Stripe Checkout, then flips the client to subscription_status='pending_payment'
// (STEP 6b). If the user completes checkout, handleClientCheckoutCompleted
// transitions them to 'trial'. If they ABANDON checkout, the row stays
// 'pending_payment' forever while the assistant and the Telnyx number keep
// billing. This cron sweeps those abandoned rows and tears the resources down.
//
// Safety model (biased hard toward never touching a paying client):
//   - Only subscription_status='pending_payment' rows older than
//     ABANDON_AFTER_HOURS. A real checkout completes in minutes and the webhook
//     flips the status within seconds, so a 24h-old pending row is abandoned.
//   - Skip any row that carries a stripe_connected_subscription_id (a webhook
//     may be mid-flight). No-card trials are 'trial', never 'pending_payment',
//     so they are never in scope.
//   - Re-read each row immediately before releasing and re-confirm it is still
//     pending_payment, still old enough, still has no subscription id. This
//     shrinks the race with the checkout webhook to effectively zero.
//   - dryRun mode reports what WOULD be swept and releases nothing.
//
// Teardown order per row: release the number (fullyReleaseNumber handles both
// vapi_direct and telnyx_cc), delete the VAPI assistant + query tool, then mark
// the row dead and null its phone/vapi fields so the released number cannot
// collide with a future signup (see insertClientWithStaleNumberRecovery).
//
// Endpoint: POST /api/cron/cleanup-abandoned-checkouts
//   header x-cron-secret: CRON_SECRET
//   body/query dryRun=true to preview without releasing
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { fullyReleaseNumber } = require('../lib/vapi');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// How long a client may sit in pending_payment before it is considered an
// abandoned checkout. Generous on purpose: legitimate checkouts flip within
// seconds, so 24h leaves no realistic chance of catching a live customer.
const ABANDON_AFTER_HOURS = 24;

// Cap rows per run so a backlog can't turn one invocation into a marathon.
const MAX_PER_RUN = 200;

// ============================================================================
// DELETE VAPI ASSISTANT: mirrors cleanupVapiResources in client-signup.js.
// Treats 404 as success (already gone). Never throws; returns a boolean.
// ============================================================================
async function deleteVapiAssistant(assistantId) {
  if (!assistantId || !VAPI_API_KEY) return false;
  try {
    const res = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (res.ok || res.status === 404) {
      console.log(`🧹 Deleted assistant: ${assistantId}`);
      return true;
    }
    const t = await res.text().catch(() => '');
    console.warn(`⚠️ Assistant delete returned ${res.status} for ${assistantId}: ${t.slice(0, 160)}`);
    return false;
  } catch (err) {
    console.warn(`⚠️ Assistant delete error for ${assistantId}: ${err.message}`);
    return false;
  }
}

// ============================================================================
// DELETE VAPI QUERY TOOL: the KB search tool created alongside the assistant.
// Non-fatal. 404 is success.
// ============================================================================
async function deleteVapiQueryTool(toolId) {
  if (!toolId || !VAPI_API_KEY) return false;
  try {
    const res = await fetch(`https://api.vapi.ai/tool/${toolId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (res.ok || res.status === 404) {
      console.log(`🧹 Deleted query tool: ${toolId}`);
      return true;
    }
    console.warn(`⚠️ Query tool delete returned ${res.status} for ${toolId}`);
    return false;
  } catch (err) {
    console.warn(`⚠️ Query tool delete error for ${toolId}: ${err.message}`);
    return false;
  }
}

// ============================================================================
// Is this row still a valid teardown target right now? Re-checked against a
// fresh read immediately before releasing anything, to avoid racing the
// checkout webhook.
// ============================================================================
function isStillAbandoned(row, cutoffIso) {
  if (!row) return false;
  if (row.subscription_status !== 'pending_payment') return false;
  if (row.stripe_connected_subscription_id) return false;
  if (!row.created_at || row.created_at >= cutoffIso) return false;
  return true;
}

// ============================================================================
// CRON ENDPOINT
// ============================================================================
router.post('/cleanup-abandoned-checkouts', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
  const cutoffIso = new Date(Date.now() - ABANDON_AFTER_HOURS * 60 * 60 * 1000).toISOString();

  try {
    console.log(`🧽 Abandoned checkout cleanup starting (cutoff ${cutoffIso}, dryRun=${dryRun})`);

    // Candidate rows: pending_payment, older than the cutoff. select('*') so we
    // read whatever columns exist without coupling to exact column names, and
    // read the subscription id defensively in JS.
    const { data: candidates, error: queryErr } = await supabase
      .from('clients')
      .select('*')
      .eq('subscription_status', 'pending_payment')
      .lt('created_at', cutoffIso)
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);

    if (queryErr) {
      console.error('❌ Abandoned checkout query failed:', queryErr.message);
      return res.status(500).json({ error: 'Database query failed', message: queryErr.message });
    }

    const rows = candidates || [];
    if (rows.length === 0) {
      console.log('✅ No abandoned checkouts to clean up');
      return res.json({ success: true, dryRun, found: 0, cleaned: 0, skipped: 0, results: [] });
    }

    console.log(`📋 Found ${rows.length} pending_payment candidate(s) older than ${ABANDON_AFTER_HOURS}h`);

    let cleaned = 0, skipped = 0;
    const results = [];

    for (const candidate of rows) {
      // Skip if a subscription id is already present (webhook likely mid-flight).
      if (candidate.stripe_connected_subscription_id) {
        skipped++;
        results.push({ client_id: candidate.id, business_name: candidate.business_name, status: 'skipped_has_subscription' });
        continue;
      }

      if (dryRun) {
        results.push({
          client_id: candidate.id,
          business_name: candidate.business_name,
          agency_id: candidate.agency_id,
          phone_number: candidate.phone_number || candidate.vapi_phone_number || null,
          created_at: candidate.created_at,
          status: 'would_clean',
        });
        cleaned++;
        continue;
      }

      // Fresh re-read right before releasing, to catch a checkout that completed
      // between the candidate query and now.
      const { data: fresh, error: freshErr } = await supabase
        .from('clients')
        .select('*')
        .eq('id', candidate.id)
        .single();

      if (freshErr) {
        console.warn(`⚠️ Re-read failed for ${candidate.id}, skipping: ${freshErr.message}`);
        skipped++;
        results.push({ client_id: candidate.id, business_name: candidate.business_name, status: 'skipped_reread_failed' });
        continue;
      }

      if (!isStillAbandoned(fresh, cutoffIso)) {
        console.log(`↩️ ${fresh.business_name} (${fresh.id}) is no longer an abandoned pending_payment, skipping`);
        skipped++;
        results.push({ client_id: fresh.id, business_name: fresh.business_name, status: 'skipped_state_changed' });
        continue;
      }

      const phoneForRelease = fresh.phone_number || fresh.vapi_phone_number || null;
      console.log(`🧽 Cleaning abandoned checkout: ${fresh.business_name} (${fresh.id}), number ${phoneForRelease || 'none'}`);

      // 1. Release the number (VAPI phone object if any + underlying Telnyx
      //    rental). fullyReleaseNumber tolerates a null vapi id (telnyx_cc) and
      //    a null number.
      let releaseResult = { vapiDeleted: false, telnyxReleased: false };
      try {
        releaseResult = await fullyReleaseNumber(fresh.vapi_phone_id || null, phoneForRelease);
      } catch (relErr) {
        console.error(`❌ Number release error for ${fresh.id}: ${relErr.message}`);
      }

      // 2. Delete the VAPI assistant + query tool.
      const assistantDeleted = await deleteVapiAssistant(fresh.vapi_assistant_id);
      await deleteVapiQueryTool(fresh.vapi_query_tool_id);

      // 3. Mark the row dead and null the phone/vapi fields so the released
      //    number can be reused without a unique-constraint collision. Guarded
      //    on subscription_status='pending_payment' so we never overwrite a row
      //    that flipped to a live status in the meantime.
      const { data: updatedRows, error: updateErr } = await supabase
        .from('clients')
        .update({
          subscription_status: 'expired',
          status: 'expired',
          vapi_assistant_id: null,
          vapi_query_tool_id: null,
          vapi_phone_id: null,
          vapi_phone_number: null,
          phone_number: null,
          phone_area_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', fresh.id)
        .eq('subscription_status', 'pending_payment')
        .select('id');

      if (updateErr) {
        console.error(`❌ Failed to mark ${fresh.id} as expired: ${updateErr.message}`);
        results.push({
          client_id: fresh.id,
          business_name: fresh.business_name,
          status: 'released_but_mark_failed',
          telnyxReleased: releaseResult.telnyxReleased,
          vapiDeleted: releaseResult.vapiDeleted,
          assistantDeleted,
          error: updateErr.message,
        });
        continue;
      }

      if (!updatedRows || updatedRows.length === 0) {
        // The guard matched 0 rows: status changed under us. Resources were
        // already released, so log loudly for follow-up rather than silently.
        console.error(`⚠️ ${fresh.id} status changed during cleanup after resources were released. Manual review advised.`);
        results.push({ client_id: fresh.id, business_name: fresh.business_name, status: 'released_but_row_state_changed' });
        cleaned++;
        continue;
      }

      cleaned++;
      results.push({
        client_id: fresh.id,
        business_name: fresh.business_name,
        agency_id: fresh.agency_id,
        phone_number: phoneForRelease,
        status: 'cleaned',
        telnyxReleased: releaseResult.telnyxReleased,
        vapiDeleted: releaseResult.vapiDeleted,
        assistantDeleted,
      });
      console.log(`✅ Cleaned ${fresh.business_name} (${fresh.id})`);
    }

    console.log(`🧽 Abandoned checkout cleanup complete: ${cleaned} cleaned, ${skipped} skipped, ${rows.length} scanned (dryRun=${dryRun})`);
    res.json({ success: true, dryRun, found: rows.length, cleaned, skipped, results });
  } catch (error) {
    console.error('❌ Abandoned checkout cleanup error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

module.exports = router;