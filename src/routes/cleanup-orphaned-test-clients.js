// ============================================================================
// ORPHANED TEST CLIENT CLEANUP - Cron Handler
// Cleans up test clients (phone numbers + VAPI assistants) for agencies
// that started onboarding but never completed it.
//
// Targets: agencies where onboarding_completed = false, created 14+ days ago,
// with a test client that has provisioned resources.
//
// Runs daily. Safe to re-run — skips already-cleaned clients.
//
// POST /api/cron/cleanup-orphaned-test-clients
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const fetch = require('node-fetch');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const ABANDONMENT_DAYS = 14; // days before cleanup

// ============================================================================
// DELETE VAPI ASSISTANT
// ============================================================================
async function deleteVapiAssistant(assistantId) {
  if (!assistantId || !VAPI_API_KEY) return false;
  try {
    const response = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (response.ok || response.status === 404) {
      console.log(`  ✅ VAPI assistant ${assistantId} deleted`);
      return true;
    }
    console.log(`  ⚠️ VAPI assistant delete failed: ${response.status}`);
    return false;
  } catch (err) {
    console.error(`  ❌ VAPI assistant delete error:`, err.message);
    return false;
  }
}

// ============================================================================
// DELETE VAPI PHONE NUMBER
// ============================================================================
async function deleteVapiPhoneNumber(phoneNumberId) {
  if (!phoneNumberId || !VAPI_API_KEY) return false;
  try {
    const response = await fetch(`https://api.vapi.ai/phone-number/${phoneNumberId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (response.ok || response.status === 404) {
      console.log(`  ✅ VAPI phone number ${phoneNumberId} deleted`);
      return true;
    }
    console.log(`  ⚠️ VAPI phone delete failed: ${response.status}`);
    return false;
  } catch (err) {
    console.error(`  ❌ VAPI phone delete error:`, err.message);
    return false;
  }
}

// ============================================================================
// RELEASE TELNYX NUMBER (if provisioned directly through Telnyx)
// ============================================================================
async function releaseTelnyxNumber(telnyxNumberId) {
  if (!telnyxNumberId || !TELNYX_API_KEY) return false;
  try {
    const response = await fetch(`https://api.telnyx.com/v2/phone_numbers/${telnyxNumberId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (response.ok || response.status === 404) {
      console.log(`  ✅ Telnyx number ${telnyxNumberId} released`);
      return true;
    }
    console.log(`  ⚠️ Telnyx release failed: ${response.status}`);
    return false;
  } catch (err) {
    console.error(`  ❌ Telnyx release error:`, err.message);
    return false;
  }
}

// ============================================================================
// CRON ENDPOINT — POST /api/cron/cleanup-orphaned-test-clients
// ============================================================================
router.post('/cleanup-orphaned-test-clients', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('🧹 Running orphaned test client cleanup...');

    const cutoffDate = new Date(Date.now() - ABANDONMENT_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Find abandoned agencies: never completed onboarding, old enough
    const { data: abandonedAgencies, error: agencyError } = await supabase
      .from('agencies')
      .select('id, name, created_at')
      .eq('onboarding_completed', false)
      .lt('created_at', cutoffDate)
      .order('created_at', { ascending: true });

    if (agencyError) {
      console.error('❌ Agency query error:', agencyError);
      return res.status(500).json({ error: 'Database query failed' });
    }

    if (!abandonedAgencies || abandonedAgencies.length === 0) {
      console.log('✅ No orphaned test clients to clean up');
      return res.json({ success: true, processed: 0, cleaned: 0 });
    }

    console.log(`📋 Found ${abandonedAgencies.length} abandoned agencies to check`);

    let cleaned = 0, skipped = 0, failed = 0;
    const results = [];

    for (const agency of abandonedAgencies) {
      // Find test client for this agency
      const { data: testClient, error: clientError } = await supabase
        .from('clients')
        .select('id, business_name, vapi_assistant_id, vapi_phone_id, vapi_phone_number, telnyx_phone_id')
        .eq('agency_id', agency.id)
        .eq('is_test_client', true)
        .single();

      if (clientError || !testClient) {
        skipped++;
        continue;
      }

      // Check if already cleaned (no resources left)
      if (!testClient.vapi_assistant_id && !testClient.vapi_phone_id && !testClient.vapi_phone_number) {
        skipped++;
        continue;
      }

      console.log(`🧹 Cleaning test client for abandoned agency: ${agency.name} (created ${agency.created_at})`);

      let cleanedResources = 0;

      // 1. Delete VAPI assistant
      if (testClient.vapi_assistant_id) {
        const deleted = await deleteVapiAssistant(testClient.vapi_assistant_id);
        if (deleted) cleanedResources++;
      }

      // 2. Delete VAPI phone number
      if (testClient.vapi_phone_id) {
        const deleted = await deleteVapiPhoneNumber(testClient.vapi_phone_id);
        if (deleted) cleanedResources++;
      }

      // 3. Release Telnyx number (if tracked separately)
      if (testClient.telnyx_phone_id) {
        const released = await releaseTelnyxNumber(testClient.telnyx_phone_id);
        if (released) cleanedResources++;
      }

      // 4. Mark client as cleaned — null out resource IDs
      const { error: updateError } = await supabase
        .from('clients')
        .update({
          vapi_assistant_id: null,
          vapi_phone_id: null,
          vapi_phone_number: null,
          telnyx_phone_id: null,
          status: 'cleaned',
          subscription_status: 'canceled',
        })
        .eq('id', testClient.id);

      if (updateError) {
        console.error(`  ❌ Failed to update client record:`, updateError.message);
        failed++;
        results.push({ agency: agency.name, client: testClient.id, status: 'update_failed' });
      } else {
        cleaned++;
        results.push({ agency: agency.name, client: testClient.id, status: 'cleaned', resources: cleanedResources });
        console.log(`  ✅ Cleaned ${cleanedResources} resources for ${agency.name}`);
      }
    }

    console.log(`🧹 Cleanup complete: ${cleaned} cleaned, ${skipped} skipped, ${failed} failed out of ${abandonedAgencies.length}`);
    res.json({ success: true, processed: abandonedAgencies.length, cleaned, skipped, failed, results });
  } catch (error) {
    console.error('❌ Cleanup cron error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

module.exports = router;