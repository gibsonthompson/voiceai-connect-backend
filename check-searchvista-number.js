#!/usr/bin/env node
/**
 * READ-ONLY diagnostic: is Searchvista's number still on Wexl's Twilio?
 * Run from the backend root:  node check-searchvista-number.js
 *
 * Uses the agency's stored (encrypted) Twilio creds the same way byot.js does.
 * Makes NO changes, NO purchases, NO releases. It only reports state so we know
 * the recovery path. Adjust the requires paths if your layout differs.
 */
const { supabase } = require('./src/lib/supabase');
const { decrypt } = require('./src/lib/encryption');

const NUMBER = '+441156470941';
const AGENCY_ID = '0c7ea945-18b5-44f5-b81f-dc1714e80965'; // Wexl Voice Receptionist
const CLIENT_ID = '21f0ba3a-c386-456a-88d5-83c6bee73212'; // Searchvista Ltd

(async () => {
  const { data: agency, error: aErr } = await supabase
    .from('agencies')
    .select('id, name, twilio_account_sid, twilio_api_key_encrypted, twilio_api_secret_encrypted, twilio_bundle_sid, twilio_address_sid, twilio_mobile_bundle_sid')
    .eq('id', AGENCY_ID)
    .single();
  if (aErr || !agency) { console.error('Agency load failed:', aErr?.message); process.exit(1); }
  if (!agency.twilio_account_sid || !agency.twilio_api_key_encrypted) {
    console.error('Agency has no Twilio creds on file — nothing to check.'); process.exit(1);
  }

  let apiKey, apiSecret;
  try {
    apiKey = decrypt(agency.twilio_api_key_encrypted);
    apiSecret = decrypt(agency.twilio_api_secret_encrypted);
  } catch (e) { console.error('Decrypt failed:', e.message); process.exit(1); }

  const accountSid = agency.twilio_account_sid;
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const H = { Authorization: `Basic ${auth}` };

  console.log(`\n=== Checking ${NUMBER} on ${agency.name}'s Twilio (${accountSid}) ===\n`);

  // 1) Is the number CURRENTLY held on the account? (same lookup as releaseBYOTNumber)
  const lookup = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(NUMBER)}`,
    { headers: H }
  );
  if (!lookup.ok) {
    console.error(`Twilio lookup HTTP ${lookup.status}: ${(await lookup.text()).slice(0,200)}`); process.exit(1);
  }
  const held = ((await lookup.json()).incoming_phone_numbers || [])[0];

  if (held && held.sid) {
    console.log('✅ STILL ON THE ACCOUNT — the number was NOT released, only unlinked from VAPI.');
    console.log(`   Twilio SID: ${held.sid}`);
    console.log(`   VoiceUrl:   ${held.voice_url || '(none)'}`);
    console.log(`   SmsUrl:     ${held.sms_url || '(none)'}`);
    console.log('\n   RECOVERY: re-import this number into VAPI and relink Searchvista. No re-purchase needed.');
    process.exit(0);
  }

  console.log('❌ NOT on the account — it was released off Twilio.\n');

  // 2) Is that EXACT number re-buyable right now? (GB available-numbers search)
  const avail = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/GB/Local.json?PhoneNumber=${encodeURIComponent(NUMBER)}`,
    { headers: H }
  );
  if (avail.ok) {
    const list = (await avail.json()).available_phone_numbers || [];
    if (list.length) {
      console.log('🟡 The exact number is AVAILABLE to re-purchase RIGHT NOW.');
      console.log(`   ${list[0].phone_number} (${list[0].friendly_name || ''})`);
      console.log(`   Regulatory on file: bundle=${agency.twilio_bundle_sid || 'MISSING'} address=${agency.twilio_address_sid || 'MISSING'}`);
      console.log('\n   RECOVERY: re-buy this exact number, then import to VAPI + relink. MOVE FAST — anyone can take it.');
    } else {
      console.log('🔴 The exact number is NOT currently available to re-purchase.');
      console.log('   It may reappear in Twilio\'s pool after a cooldown, or be gone. Keep polling this exact number.');
    }
  } else {
    console.log(`(available-number search returned HTTP ${avail.status}: ${(await avail.text()).slice(0,160)})`);
  }
  process.exit(0);
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });