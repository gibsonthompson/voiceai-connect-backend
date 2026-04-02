// ============================================================================
// ONE-TIME CLEANUP: Disable VAPI phone numbers for expired clients
//
// Run this ONCE after deploying the vapi.js patch to clean up existing
// zombie phone numbers that are still answering calls for expired clients.
//
// Usage:
//   node scripts/cleanup-expired-phones.js          # Dry run (shows what would change)
//   node scripts/cleanup-expired-phones.js --apply   # Actually disable the phones
// ============================================================================
require('dotenv').config();

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = !process.argv.includes('--apply');

async function disablePhoneNumber(phoneId) {
  const response = await fetch(`https://api.vapi.ai/phone-number/${phoneId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      serverUrl: null,
      assistantId: null
    })
  });
  return response.ok;
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  CLEANUP: Expired Client Phone Numbers`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (add --apply to execute)' : 'APPLYING CHANGES'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Find all clients with expired/canceled/suspended status that still have a VAPI phone
  const { data: zombieClients, error } = await supabase
    .from('clients')
    .select('id, business_name, email, subscription_status, vapi_phone_number, vapi_phone_id, vapi_assistant_id, trial_ends_at')
    .in('subscription_status', ['expired', 'trial_expired', 'canceled', 'suspended'])
    .not('vapi_phone_id', 'is', null);

  if (error) {
    console.error('Error querying clients:', error);
    process.exit(1);
  }

  if (!zombieClients || zombieClients.length === 0) {
    console.log('No zombie phone numbers found. All clean.');
    process.exit(0);
  }

  console.log(`Found ${zombieClients.length} expired client(s) with VAPI phone numbers:\n`);

  let disabled = 0;
  let failed = 0;

  for (const client of zombieClients) {
    console.log(`  ${client.business_name}`);
    console.log(`    Status: ${client.subscription_status}`);
    console.log(`    Phone:  ${client.vapi_phone_number}`);
    console.log(`    ID:     ${client.vapi_phone_id}`);
    console.log(`    Trial ended: ${client.trial_ends_at || 'N/A'}`);

    if (DRY_RUN) {
      console.log(`    Action: WOULD disable phone number\n`);
      disabled++;
      continue;
    }

    // Disable the phone number
    try {
      const ok = await disablePhoneNumber(client.vapi_phone_id);
      if (ok) {
        console.log(`    Action: Phone number DISABLED\n`);
        disabled++;
      } else {
        console.log(`    Action: FAILED to disable phone\n`);
        failed++;
      }
    } catch (err) {
      console.log(`    Action: ERROR — ${err.message}\n`);
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Results: ${disabled} disabled, ${failed} failed`);
  if (DRY_RUN) {
    console.log(`  This was a DRY RUN. Run with --apply to execute.`);
  }
  console.log(`${'='.repeat(60)}\n`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});