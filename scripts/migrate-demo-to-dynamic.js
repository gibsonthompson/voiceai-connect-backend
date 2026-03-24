#!/usr/bin/env node
// ============================================================================
// MIGRATE DEMO PHONES TO DYNAMIC ASSISTANT-REQUEST
//
// This script patches existing demo phone numbers in VAPI to remove the
// static assistantId, forcing VAPI to send assistant-request webhooks
// instead. The serverUrl is already set from provisioning.
//
// The static demo assistant is kept in the DB as a fallback — if the
// dynamic config builder crashes, the webhook handler falls back to it.
//
// Usage:
//   node scripts/migrate-demo-to-dynamic.js              # Migrate all
//   node scripts/migrate-demo-to-dynamic.js --dry-run     # Preview only
//   node scripts/migrate-demo-to-dynamic.js --rollback    # Restore static
//
// CREATED: 2026-03-23
// ============================================================================

require('dotenv').config();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ROLLBACK = args.includes('--rollback');

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(ROLLBACK
    ? '🔄 ROLLBACK: Restoring static demo assistants'
    : '🚀 MIGRATING demo phones to dynamic assistant-request');
  if (DRY_RUN) console.log('   ⚠️  DRY RUN — no changes will be made');
  console.log('═══════════════════════════════════════════════\n');

  // Fetch all agencies with demo phones
  const { data: agencies, error } = await supabase
    .from('agencies')
    .select('id, name, demo_phone_number, demo_assistant_id, demo_vapi_phone_id')
    .not('demo_phone_number', 'is', null);

  if (error) {
    console.error('❌ Failed to fetch agencies:', error.message);
    process.exit(1);
  }

  if (!agencies || agencies.length === 0) {
    console.log('ℹ️  No agencies with demo phones found. Nothing to migrate.');
    process.exit(0);
  }

  console.log(`Found ${agencies.length} agency demo phone(s) to ${ROLLBACK ? 'rollback' : 'migrate'}:\n`);

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const agency of agencies) {
    const { name, demo_vapi_phone_id, demo_assistant_id, demo_phone_number } = agency;

    console.log(`── ${name} ──`);
    console.log(`   Phone: ${demo_phone_number}`);
    console.log(`   VAPI Phone ID: ${demo_vapi_phone_id || 'MISSING'}`);
    console.log(`   Static Assistant: ${demo_assistant_id || 'NONE'}`);

    if (!demo_vapi_phone_id) {
      console.log('   ⏭️  Skipped — no VAPI phone ID\n');
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`   🔍 Would ${ROLLBACK ? 'restore assistantId' : 'remove assistantId'}`);
      console.log('');
      success++;
      continue;
    }

    try {
      const patchBody = ROLLBACK
        ? {
            // Restore: set assistantId back + keep serverUrl
            assistantId: demo_assistant_id,
            serverUrl: `${BACKEND_URL}/webhook/vapi`,
          }
        : {
            // Migrate: remove assistantId, keep serverUrl only
            // VAPI will now send assistant-request instead of using static assistant
            assistantId: null,
            serverUrl: `${BACKEND_URL}/webhook/vapi`,
          };

      const response = await fetch(`https://api.vapi.ai/phone-number/${demo_vapi_phone_id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patchBody),
      });

      if (response.ok) {
        const data = await response.json();
        const hasAssistant = !!data.assistantId;
        console.log(`   ✅ ${ROLLBACK ? 'Restored' : 'Migrated'} — assistantId: ${hasAssistant ? data.assistantId : 'REMOVED (dynamic mode)'}`);
        success++;
      } else {
        const errText = await response.text();
        console.log(`   ❌ Failed: ${response.status} — ${errText}`);
        failed++;
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      failed++;
    }

    console.log('');
  }

  console.log('═══════════════════════════════════════════════');
  console.log(`Results: ${success} success, ${failed} failed, ${skipped} skipped`);
  if (DRY_RUN) console.log('⚠️  This was a dry run. Run without --dry-run to apply.');
  if (!ROLLBACK && success > 0 && !DRY_RUN) {
    console.log('\n🧪 Test: Call one of the demo numbers and check DigitalOcean logs for:');
    console.log('   "🎤 Demo call — building dynamic demo config"');
    console.log('\n🔄 If anything breaks, run:');
    console.log('   node scripts/migrate-demo-to-dynamic.js --rollback');
  }
  console.log('═══════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});