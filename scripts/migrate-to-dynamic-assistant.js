#!/usr/bin/env node
// ============================================================================
// MIGRATION: Switch Phone Numbers to Dynamic Assistant-Request
//
// WHAT THIS DOES:
//   1. Fetches all phone numbers from your VAPI account
//   2. Matches each to a client by phone number string
//   3. Fetches each client's assistant to extract the KB query tool ID
//   4. Stores vapi_phone_id + vapi_query_tool_id on the client record
//   5. PATCHes the phone number to REMOVE assistantId (enabling assistant-request)
//
// AFTER THIS RUNS:
//   - VAPI will send assistant-request to your serverUrl for every call
//   - Your handler builds the config dynamically (with caller recognition)
//   - The static assistant remains on VAPI as a safety net (not deleted)
//
// PREREQUISITES:
//   - Phase 2 backend code must be DEPLOYED before running this
//   - SQL migration (vapi_query_tool_id column) must be run first
//
// USAGE:
//   node scripts/migrate-to-dynamic-assistant.js --dry-run     (preview)
//   node scripts/migrate-to-dynamic-assistant.js --single CLIENT_ID  (one client)
//   node scripts/migrate-to-dynamic-assistant.js               (all clients)
//
// ROLLBACK:
//   node scripts/migrate-to-dynamic-assistant.js --rollback    (restore static assistants)
// ============================================================================
require('dotenv').config();

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

const DRY_RUN = process.argv.includes('--dry-run');
const ROLLBACK = process.argv.includes('--rollback');
const SINGLE_IDX = process.argv.indexOf('--single');
const SINGLE_CLIENT_ID = SINGLE_IDX !== -1 ? process.argv[SINGLE_IDX + 1] : null;

// ============================================================================
// FETCH ALL VAPI PHONE NUMBERS
// ============================================================================
async function fetchAllVapiPhoneNumbers() {
  console.log('📞 Fetching all phone numbers from VAPI...');
  
  const response = await fetch('https://api.vapi.ai/phone-number', {
    headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch phone numbers: ${response.status}`);
  }

  const numbers = await response.json();
  console.log(`   Found ${numbers.length} phone numbers on VAPI account`);
  return numbers;
}

// ============================================================================
// FETCH ASSISTANT TO EXTRACT QUERY TOOL ID
// ============================================================================
async function getQueryToolId(assistantId) {
  if (!assistantId) return null;

  try {
    const response = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });

    if (!response.ok) return null;

    const assistant = await response.json();
    const toolIds = assistant.model?.toolIds || [];
    
    // Return the first toolId (should be the KB query tool)
    return toolIds.length > 0 ? toolIds[0] : null;
  } catch {
    return null;
  }
}

// ============================================================================
// PATCH PHONE NUMBER — Remove assistantId to enable assistant-request
// ============================================================================
async function switchToServerUrl(vapiPhoneId) {
  const response = await fetch(`https://api.vapi.ai/phone-number/${vapiPhoneId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      assistantId: null,
      serverUrl: `${BACKEND_URL}/webhook/vapi`
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`PATCH failed: ${errText}`);
  }

  return response.json();
}

// ============================================================================
// ROLLBACK — Restore assistantId on phone number
// ============================================================================
async function restoreStaticAssistant(vapiPhoneId, assistantId) {
  const response = await fetch(`https://api.vapi.ai/phone-number/${vapiPhoneId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      assistantId: assistantId,
      serverUrl: `${BACKEND_URL}/webhook/vapi`
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Rollback PATCH failed: ${errText}`);
  }

  return response.json();
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  Phase 2: Migrate to Dynamic Assistant-Request`);
  console.log(`  Mode: ${ROLLBACK ? '🔄 ROLLBACK' : DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}`);
  if (SINGLE_CLIENT_ID) console.log(`  Target: Single client ${SINGLE_CLIENT_ID}`);
  console.log(`  Backend URL: ${BACKEND_URL}`);
  console.log(`════════════════════════════════════════════════════════════\n`);

  // ── Step 1: Get all VAPI phone numbers ────────────────────────────────
  const vapiNumbers = await fetchAllVapiPhoneNumbers();

  // Build a lookup map: phone number string → VAPI phone object
  const numberMap = {};
  vapiNumbers.forEach(n => {
    if (n.number) numberMap[n.number] = n;
  });

  // ── Step 2: Get clients from Supabase ─────────────────────────────────
  let query = supabase
    .from('clients')
    .select('id, business_name, vapi_phone_number, vapi_assistant_id, vapi_phone_id, vapi_query_tool_id, status, subscription_status')
    .not('vapi_phone_number', 'is', null)
    .not('vapi_assistant_id', 'is', null);

  if (SINGLE_CLIENT_ID) {
    query = query.eq('id', SINGLE_CLIENT_ID);
  } else {
    query = query.in('status', ['active']).in('subscription_status', ['active', 'trial', 'trialing']);
  }

  const { data: clients, error } = await query;

  if (error) {
    console.error('❌ Failed to fetch clients:', error);
    process.exit(1);
  }

  console.log(`📋 Found ${clients.length} clients to process\n`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let backfilled = 0;

  for (const client of clients) {
    console.log(`── ${client.business_name} ──`);
    console.log(`   Phone: ${client.vapi_phone_number}`);
    console.log(`   Assistant: ${client.vapi_assistant_id}`);

    try {
      // ── Match to VAPI phone number object ───────────────────────────
      const vapiPhone = numberMap[client.vapi_phone_number];

      if (!vapiPhone) {
        console.log(`   ⚠️ Phone number not found on VAPI account — skipping`);
        skipped++;
        continue;
      }

      const vapiPhoneId = vapiPhone.id;
      const currentAssistantId = vapiPhone.assistantId || null;

      // ── ROLLBACK mode ───────────────────────────────────────────────
      if (ROLLBACK) {
        if (currentAssistantId) {
          console.log(`   ✅ Already has assistantId (${currentAssistantId}) — no rollback needed`);
          skipped++;
        } else if (DRY_RUN) {
          console.log(`   🔍 Would restore assistantId: ${client.vapi_assistant_id}`);
          migrated++;
        } else {
          await restoreStaticAssistant(vapiPhoneId, client.vapi_assistant_id);
          console.log(`   ✅ Restored static assistant: ${client.vapi_assistant_id}`);
          migrated++;
        }
        await sleep(300);
        continue;
      }

      // ── Backfill vapi_phone_id if missing ───────────────────────────
      if (!client.vapi_phone_id) {
        if (!DRY_RUN) {
          await supabase
            .from('clients')
            .update({ vapi_phone_id: vapiPhoneId })
            .eq('id', client.id);
        }
        console.log(`   📱 Backfilled vapi_phone_id: ${vapiPhoneId}`);
        backfilled++;
      }

      // ── Extract and store query tool ID ─────────────────────────────
      if (!client.vapi_query_tool_id) {
        const queryToolId = await getQueryToolId(client.vapi_assistant_id);
        if (queryToolId) {
          if (!DRY_RUN) {
            await supabase
              .from('clients')
              .update({ vapi_query_tool_id: queryToolId })
              .eq('id', client.id);
          }
          console.log(`   🔧 Stored query tool ID: ${queryToolId}`);
          backfilled++;
        } else {
          console.log(`   ⚠️ No query tool found on assistant (KB may not be configured)`);
        }
        await sleep(200); // Rate limit for assistant fetch
      } else {
        console.log(`   🔧 Query tool already stored: ${client.vapi_query_tool_id}`);
      }

      // ── Check if already migrated ───────────────────────────────────
      if (!currentAssistantId) {
        console.log(`   ✅ Already dynamic (no assistantId on phone) — skipping`);
        skipped++;
        await sleep(200);
        continue;
      }

      // ── Switch to server URL (remove assistantId) ───────────────────
      if (DRY_RUN) {
        console.log(`   🔍 Would remove assistantId from phone ${vapiPhoneId}`);
        console.log(`   🔍 Would set serverUrl: ${BACKEND_URL}/webhook/vapi`);
        migrated++;
      } else {
        await switchToServerUrl(vapiPhoneId);
        console.log(`   ✅ Switched to dynamic: assistantId removed, serverUrl set`);
        migrated++;
      }

      await sleep(300);

    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      failed++;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  ${ROLLBACK ? 'ROLLBACK' : 'MIGRATION'} COMPLETE`);
  console.log(`  ✅ ${ROLLBACK ? 'Restored' : 'Migrated'}: ${migrated}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  console.log(`  ❌ Failed: ${failed}`);
  if (!ROLLBACK) console.log(`  📦 Backfilled IDs: ${backfilled}`);
  console.log(`════════════════════════════════════════════════════════════\n`);

  if (DRY_RUN) {
    console.log(`This was a dry run. Run without --dry-run to apply changes.`);
    if (!ROLLBACK) {
      console.log(`\nRecommended order:`);
      console.log(`  1. Deploy Phase 2 backend code first`);
      console.log(`  2. Run: node scripts/migrate-to-dynamic-assistant.js --single <CLIENT_ID>`);
      console.log(`  3. Test with a phone call to that client`);
      console.log(`  4. If working: node scripts/migrate-to-dynamic-assistant.js`);
      console.log(`  5. If broken: node scripts/migrate-to-dynamic-assistant.js --rollback`);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
