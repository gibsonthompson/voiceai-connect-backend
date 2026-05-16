// ============================================================================
// ONE-TIME CLEANUP — Run from backend project root: node cleanup-now.js
// Deletes all 28 expired VAPI phone numbers and nulls out DB fields.
// Safe to run multiple times — VAPI returns 404 for already-deleted numbers.
// DELETE THIS FILE AFTER RUNNING.
// ============================================================================
require('dotenv').config();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PHONE_IDS = [
  'df81cd15-82a4-4dcc-ba60-646c249f468e',
  'a99023e2-5f2e-45f1-a28d-7a806deb2771',
  '488754c4-93a2-4667-a3d5-b5010e3f33b0',
  '02291847-356a-4127-aae1-8f5a1de84e0d',
  '47fd9774-dfeb-4c92-b562-6647590c2310',
  '81e969e8-590e-4d71-acd6-efad6bf9e4d7',
  'd214b53b-1380-4550-a213-cda1c71d35c8',
  '345bbbf0-f7db-4594-a295-3a215745d87c',
  '79625dec-62d8-425b-b73d-7cc784a19142',
  '787f2bd2-d083-4eb3-8834-ecdd0e70c42a',
  'ebf165b9-3798-4973-b447-2b26f13fc813',
  '76a2d32f-e965-484f-8599-8c46d6f0201c',
  'ebc22c7f-f99d-49d2-86c0-8743a1912e81',
  '333d8dd8-b7a7-4e2f-93ee-50d3e24e57bd',
  'd7906bdb-3e8b-4baa-a533-6941511d95ef',
  '20d57e31-0b47-4733-93b0-dd790378bc5f',
  '17fd15c4-54e4-489b-8e3a-4644b0eff920',
  '3bdc2e97-8c43-427f-8421-c277b0f29e43',
  '9989dec8-f0e4-4390-ad10-56dd72d566c6',
  '9a693813-c0f7-47d5-a1c0-4eca4e4bf471',
  'c1730e78-2c24-4913-97aa-5b312f58e036',
  '9925f99d-c6cd-4ad0-b55d-e384ac952edf',
  '0e479fdd-4d65-407d-a04d-e14a1a796739',
  '968da53c-8b25-4281-ac61-c92ba55d6aef',
  '61f843a5-71d6-45b2-a2bb-877505cc5c3c',
  '35738aa6-e80d-4452-a2ad-84325b23f9f5',
  'd240146e-97e8-45a1-b618-921a98990c4f',
  '64802a66-3236-4826-8ce7-04b6135b4b2c',
];

async function run() {
  console.log(`\n🧹 Cleaning up ${PHONE_IDS.length} expired VAPI phone numbers...\n`);

  if (!VAPI_API_KEY) { console.error('❌ VAPI_API_KEY not found in .env'); process.exit(1); }

  let deleted = 0, alreadyGone = 0, failed = 0;

  for (const phoneId of PHONE_IDS) {
    try {
      const res = await fetch(`https://api.vapi.ai/phone-number/${phoneId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
      });

      if (res.ok) {
        console.log(`  ✅ Deleted: ${phoneId}`);
        deleted++;
      } else if (res.status === 404) {
        console.log(`  ⏭️  Already gone: ${phoneId}`);
        alreadyGone++;
      } else {
        const body = await res.text().catch(() => '');
        console.log(`  ❌ Failed (${res.status}): ${phoneId} — ${body.slice(0, 100)}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ❌ Error: ${phoneId} — ${err.message}`);
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n📊 VAPI cleanup: ${deleted} deleted, ${alreadyGone} already gone, ${failed} failed\n`);

  // Now null out the DB fields for all these clients
  console.log('🗄️  Updating database...');
  const { data, error } = await supabase
    .from('clients')
    .update({
      vapi_phone_id: null,
      vapi_phone_number: null,
      vapi_assistant_id: null,
    })
    .in('vapi_phone_id', PHONE_IDS)
    .select('id, business_name');

  if (error) {
    console.error('❌ DB update failed:', error.message);
  } else {
    console.log(`✅ Updated ${data.length} client records:`);
    data.forEach(c => console.log(`   — ${c.business_name}`));
  }

  console.log('\n🎉 Done. Delete this file now.\n');
  process.exit(0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
