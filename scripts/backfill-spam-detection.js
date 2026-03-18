#!/usr/bin/env node
// ============================================================================
// BACKFILL: Add Spam Detection to Existing VAPI Assistants
//
// What it does:
// - Fetches all active clients with a vapi_assistant_id
// - For each: GETs the assistant from VAPI, checks if spam detection already exists
// - If missing: appends the spam detection block to the system prompt and PATCHes
//
// Safe to run multiple times — skips assistants that already have the block.
//
// Usage:
//   node scripts/backfill-spam-detection.js --dry-run    (preview only)
//   node scripts/backfill-spam-detection.js              (apply changes)
// ============================================================================
require('dotenv').config();

const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const VAPI_API_KEY = process.env.VAPI_API_KEY;

const DRY_RUN = process.argv.includes('--dry-run');

const SPAM_DETECTION_BLOCK = `

# Spam Detection
If the caller appears to be a robocall, telemarketer, or spam:
- They play a pre-recorded message or sales pitch
- They don't respond to your questions naturally
- They're trying to sell a product or service TO the business (SEO, Google ads, insurance leads, credit card processing, etc.)
- They ask for "the business owner" or "the person in charge of your Google listing"
- The line goes silent after connecting
- They use high-pressure tactics or claim there's an urgent issue with the business's online presence

If you detect spam: say "We're not interested, thanks. Have a good day." Then end the call using the endCall tool if available. If you cannot end the call, simply stop responding after your goodbye.`;

async function backfill() {
  console.log(`\n🔧 Backfill: Add Spam Detection to Existing Assistants`);
  console.log(`   Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '🚀 LIVE'}\n`);

  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, business_name, vapi_assistant_id, status, subscription_status')
    .not('vapi_assistant_id', 'is', null)
    .in('status', ['active'])
    .in('subscription_status', ['active', 'trial', 'trialing']);

  if (error) {
    console.error('❌ Failed to fetch clients:', error);
    process.exit(1);
  }

  console.log(`📋 Found ${clients.length} active clients with VAPI assistants\n`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const client of clients) {
    try {
      console.log(`--- ${client.business_name} (${client.vapi_assistant_id})`);

      const getRes = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
      });

      if (!getRes.ok) {
        console.log(`   ⚠️ Could not fetch assistant (${getRes.status}) — skipping`);
        failed++;
        continue;
      }

      const assistant = await getRes.json();
      const currentPrompt = assistant.model?.messages?.[0]?.content || '';

      if (currentPrompt.includes('# Spam Detection')) {
        console.log(`   ✅ Already has spam detection — skipping`);
        skipped++;
        continue;
      }

      const newPrompt = currentPrompt + SPAM_DETECTION_BLOCK;

      if (DRY_RUN) {
        console.log(`   🔍 Would append spam detection (${SPAM_DETECTION_BLOCK.length} chars)`);
        updated++;
        continue;
      }

      const patchRes = await fetch(`https://api.vapi.ai/assistant/${client.vapi_assistant_id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: {
            ...assistant.model,
            messages: [{ role: 'system', content: newPrompt }]
          }
        })
      });

      if (patchRes.ok) {
        console.log(`   ✅ Updated`);
        updated++;
      } else {
        const errText = await patchRes.text();
        console.log(`   ❌ PATCH failed: ${errText}`);
        failed++;
      }

      // Rate limit: don't slam the VAPI API
      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`✅ Updated: ${updated}`);
  console.log(`⏭️  Skipped (already had it): ${skipped}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`═══════════════════════════════════════\n`);

  if (DRY_RUN) {
    console.log(`This was a dry run. Run without --dry-run to apply changes.`);
  }
}

backfill().then(() => process.exit(0)).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
