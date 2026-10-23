#!/usr/bin/env node
// ============================================================================
// PROVISION FINANCE NUMBER  (destination: scripts/provision-finance-number.js)
// ----------------------------------------------------------------------------
// Buys a Telnyx long-code number, assigns it to your messaging profile (the one
// whose inbound webhook already points at /webhook/telnyx-sms), and prints the
// exact env line to set. That number becomes HQ_FINANCE_SMS_NUMBER, the number
// your bank text alerts go to.
//
// SAFE BY DEFAULT: with no flag it only SEARCHES and shows candidates (no charge,
// no purchase). It buys a number only when you pass --buy.
//
//   node scripts/provision-finance-number.js                 # dry run: search + show
//   node scripts/provision-finance-number.js --buy           # buy first SMS candidate
//   AREA_CODE=470 node scripts/provision-finance-number.js --buy   # prefer an area code
//   NUMBER=+14705551234 node scripts/provision-finance-number.js --buy   # buy a specific #
//
// Env:
//   TELNYX_API_KEY               (required)  your Telnyx API v2 key
//   TELNYX_MESSAGING_PROFILE_ID  (required for --buy) the profile whose webhook
//                                is your /webhook/telnyx-sms. Same one VAC uses.
//   AREA_CODE                    (optional) 3-digit US area code to prefer
//   NUMBER                       (optional) a specific +1E164 number to buy
//
// Nothing is hardcoded and no secret is printed. Node 18+ (uses global fetch).
// ============================================================================

'use strict';

const API = 'https://api.telnyx.com/v2';
const KEY = process.env.TELNYX_API_KEY;
const PROFILE = process.env.TELNYX_MESSAGING_PROFILE_ID;
const AREA_CODE = (process.env.AREA_CODE || '').replace(/\D/g, '');
const WANT_NUMBER = (process.env.NUMBER || '').trim();
const DO_BUY = process.argv.includes('--buy');

function die(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }
if (!KEY) die('Set TELNYX_API_KEY first:  export TELNYX_API_KEY=KEY...  then re-run.');

async function tx(path, method = 'GET', body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const detail = data && data.errors ? data.errors.map((e) => e.detail || e.title).join('; ') : `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${detail}`);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function showProfile() {
  if (!PROFILE) {
    console.log('⚠️  TELNYX_MESSAGING_PROFILE_ID is not set. The number can be bought,');
    console.log('    but it will NOT be attached to a messaging profile, so inbound bank');
    console.log('    texts will not reach your webhook until you attach it. Set it to the');
    console.log('    profile whose webhook is your /webhook/telnyx-sms, then re-run.\n');
    return null;
  }
  const p = await tx(`/messaging_profiles/${PROFILE}`);
  const prof = p.data || {};
  console.log(`Messaging profile:  ${prof.name || PROFILE}`);
  console.log(`Inbound webhook:    ${prof.webhook_url || '(none set)'}`);
  if (!/telnyx-sms/.test(prof.webhook_url || '')) {
    console.log('⚠️  That webhook URL does not look like your /webhook/telnyx-sms endpoint.');
    console.log('    Double-check this is the profile that handles inbound SMS before buying.');
  }
  console.log('');
  return prof;
}

async function findCandidates() {
  const params = [
    'filter[country_code]=US',
    'filter[features][]=sms',
    'filter[limit]=5',
    'filter[phone_number_type]=local',
  ];
  if (AREA_CODE) params.push(`filter[national_destination_code]=${AREA_CODE}`);
  const r = await tx(`/available_phone_numbers?${params.join('&')}`);
  return (r.data || []).filter((n) => (n.features || []).some((f) => (f.name || f) === 'sms'));
}

async function getPhoneId(number) {
  for (let i = 0; i < 10; i++) {
    const r = await tx(`/phone_numbers?filter[phone_number]=${encodeURIComponent(number)}`);
    if (r.data && r.data[0] && r.data[0].id) return r.data[0].id;
    await sleep(3000);
  }
  return null;
}

(async () => {
  console.log('\n=== Telnyx finance-number provisioning ===\n');
  const prof = await showProfile();

  // Pick the target number.
  let target = WANT_NUMBER;
  if (!target) {
    const cands = await findCandidates();
    if (!cands.length) die(`No SMS-capable numbers available${AREA_CODE ? ` in area code ${AREA_CODE}` : ''}. Try a different AREA_CODE.`);
    console.log('SMS-capable candidates:');
    cands.forEach((n, i) => {
      const cost = n.cost_information ? `${n.cost_information.monthly_cost} ${n.cost_information.currency}/mo` : '';
      console.log(`  ${i === 0 ? '→' : ' '} ${n.phone_number}   ${cost}`);
    });
    console.log('');
    target = cands[0].phone_number;
  }

  if (!DO_BUY) {
    console.log(`DRY RUN. Would buy: ${target}`);
    console.log('Re-run with --buy to purchase and attach it:\n');
    console.log('  node scripts/provision-finance-number.js --buy\n');
    return;
  }

  if (!PROFILE) die('Refusing to buy without TELNYX_MESSAGING_PROFILE_ID set (the number would be unreachable). Set it and re-run.');

  // Order the number, assigning the messaging profile at order time.
  console.log(`Ordering ${target} ...`);
  const order = await tx('/number_orders', 'POST', {
    phone_numbers: [{ phone_number: target }],
    messaging_profile_id: PROFILE,
  });
  const orderId = order.data && order.data.id;
  console.log(`Order placed (${orderId}). Waiting for it to complete ...`);

  // Poll the order to success.
  let status = order.data && order.data.status;
  for (let i = 0; i < 20 && status !== 'success'; i++) {
    await sleep(3000);
    const o = await tx(`/number_orders/${orderId}`);
    status = o.data && o.data.status;
    if (status === 'failed') die('Telnyx reported the order failed. Check your Telnyx balance and try again.');
  }
  if (status !== 'success') {
    console.log(`⚠️  Order still ${status} after waiting. It may finish shortly; check the Telnyx portal.`);
  } else {
    console.log('Order complete.');
  }

  // Make sure the messaging profile is attached (explicit, in case order-time assign lagged).
  const id = await getPhoneId(target);
  if (id) {
    try {
      await tx(`/phone_numbers/${id}/messaging`, 'PATCH', { messaging_profile_id: PROFILE });
      console.log('Messaging profile attached.');
    } catch (e) {
      console.log(`⚠️  Could not confirm messaging-profile attach: ${e.message}`);
      console.log('    Attach it by hand in the Telnyx portal (Numbers -> the number -> Messaging profile).');
    }
  } else {
    console.log('⚠️  Could not find the number resource yet to confirm the messaging profile.');
    console.log('    Check it in the portal in a minute; it should be on your profile from the order.');
  }

  console.log('\n=== Done ===');
  console.log(`Bought: ${target}`);
  console.log('\nSet this on the urchin backend env, then redeploy:\n');
  console.log(`  HQ_FINANCE_SMS_NUMBER=${target}`);
  console.log('\nThen point your bank text alerts (purchases AND deposits) at that number,');
  console.log('and send one test text to confirm it lands in HQ -> Money.\n');
})().catch((e) => die(e.message));
