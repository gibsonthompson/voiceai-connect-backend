// ============================================================================
// BYOT (Bring Your Own Twilio) ROUTES
// Pro + Scale plan feature - agencies use their own Twilio account
// for international number provisioning
// UPDATED: 2026-05-10 - Lowered requirement from Scale-only to Pro+Scale
// UPDATED: 2026-07-27 - Added releaseBYOTNumber so a number bought on the
//          agency's own Twilio (e.g. an international demo line) can be released
//          from that Twilio account on teardown. Deleting the VAPI object and
//          releasing the platform Telnyx number does NOT touch the agency's
//          Twilio, so without this a BYOT number bills forever.
// UPDATED: 2026-08-04 - Fixed the VAPI import in provisionBYOTNumber. It was
//          sending twilioApiKey/twilioApiSecret, which are NOT VAPI field
//          names, so the import failed after the number was already purchased
//          (leaving an orphaned VAPI assistant and a leaked Twilio number, and
//          surfacing to the agency as a generic failure). The import now tries
//          VAPI's documented API-key method (apiKey/apiSecret) first and falls
//          back to the legacy field spelling, using only the SK API Key +
//          Secret we actually store (never an account Auth Token, which is not
//          collected). If every attempt fails, the just-purchased number is
//          released from the agency's Twilio before throwing, so a failed
//          import no longer leaks a billable line.
// UPDATED: 2026-08-06 - International purchase fix. The buy call previously
//          sent only PhoneNumber + FriendlyName, so regulated countries (GB in
//          particular) rejected it: GB requires an approved Regulatory
//          Compliance Bundle AND a validated Address to be referenced on the
//          purchase. A validated address merely existing on the account is not
//          enough; the request must point at it. We now store twilio_bundle_sid
//          (BU...) and twilio_address_sid (AD...) per agency and pass them as
//          BundleSid / AddressSid on the buy when present. Present-gated, so US
//          and Canada buys (which set neither) are unchanged. Added
//          POST /:agencyId/byot/regulatory to save/clear the two SIDs, and the
//          status endpoint now returns them so the settings UI can prefill.
// Destination: src/routes/byot.js
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase, getAgencyById } = require('../lib/supabase');
const { encrypt, decrypt } = require('../lib/encryption');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';

// ============================================================================
// MIDDLEWARE: Require Pro or Scale plan (with trial access)
// ============================================================================
async function requireProPlan(req, res, next) {
  const { agencyId } = req.params;

  try {
    const agency = await getAgencyById(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    const isTrialing = ['trialing', 'trial'].includes(agency.subscription_status);
    const effectivePlan = isTrialing ? 'enterprise' : agency.plan_type;

    const allowed = ['pro', 'professional', 'enterprise', 'scale'];
    if (!allowed.includes(effectivePlan)) {
      return res.status(403).json({
        error: 'Pro plan required',
        feature: 'byot',
        current_plan: agency.plan_type,
        upgrade_url: '/agency/settings?tab=billing'
      });
    }

    req.agency = agency;
    next();
  } catch (error) {
    console.error('Plan check error:', error);
    res.status(500).json({ error: 'Failed to verify plan' });
  }
}

// ============================================================================
// GET /api/agency/:agencyId/byot/status
// ============================================================================
router.get('/:agencyId/byot/status', requireProPlan, async (req, res) => {
  const { agency } = req;

  res.json({
    byot_enabled: agency.byot_enabled || false,
    has_credentials: !!(agency.twilio_account_sid && agency.twilio_api_key_encrypted),
    twilio_account_sid: agency.twilio_account_sid || null,
    verified_at: agency.byot_verified_at || null,
    // Regulatory SIDs for international purchase. Null when not configured.
    // The settings UI prefills its Bundle SID / Address SID fields from these.
    twilio_bundle_sid: agency.twilio_bundle_sid || null,
    twilio_address_sid: agency.twilio_address_sid || null,
  });
});

// ============================================================================
// POST /api/agency/:agencyId/byot/credentials
// ============================================================================
router.post('/:agencyId/byot/credentials', requireProPlan, async (req, res) => {
  const { agencyId } = req.params;
  const { twilio_account_sid, twilio_api_key, twilio_api_secret } = req.body;

  if (!twilio_account_sid || !twilio_api_key || !twilio_api_secret) {
    return res.status(400).json({
      error: 'All Twilio credentials required',
      required: ['twilio_account_sid', 'twilio_api_key', 'twilio_api_secret']
    });
  }

  if (!twilio_account_sid.startsWith('AC') || twilio_account_sid.length !== 34) {
    return res.status(400).json({ error: 'Invalid Twilio Account SID format. Should start with AC and be 34 characters.' });
  }
  if (!twilio_api_key.startsWith('SK') || twilio_api_key.length !== 34) {
    return res.status(400).json({ error: 'Invalid Twilio API Key format. Should start with SK and be 34 characters.' });
  }

  try {
    console.log(`🔑 Validating Twilio credentials for agency ${agencyId}...`);

    const twilioAuthHeader = Buffer.from(`${twilio_api_key}:${twilio_api_secret}`).toString('base64');
    const twilioResponse = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilio_account_sid}/IncomingPhoneNumbers.json?PageSize=1`,
      { headers: { 'Authorization': `Basic ${twilioAuthHeader}` } }
    );

    if (!twilioResponse.ok) {
      const errorData = await twilioResponse.json().catch(() => ({}));
      console.log(`❌ Twilio validation failed: ${twilioResponse.status}`);
      return res.status(400).json({
        error: 'Twilio credentials are invalid',
        detail: errorData.message || `Twilio returned status ${twilioResponse.status}. Check your Account SID, API Key, and API Secret.`
      });
    }

    console.log(`✅ Twilio credentials verified for account ${twilio_account_sid}`);

    const encryptedApiKey = encrypt(twilio_api_key);
    const encryptedApiSecret = encrypt(twilio_api_secret);

    const { error: updateError } = await supabase
      .from('agencies')
      .update({
        twilio_account_sid: twilio_account_sid,
        twilio_api_key_encrypted: encryptedApiKey,
        twilio_api_secret_encrypted: encryptedApiSecret,
        byot_enabled: true,
        byot_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', agencyId);

    if (updateError) {
      console.error('❌ Failed to save credentials:', updateError);
      throw updateError;
    }

    console.log(`✅ BYOT credentials saved for agency ${agencyId}`);

    res.json({
      success: true,
      message: 'Twilio credentials verified and saved successfully.',
      twilio_account_sid: twilio_account_sid,
      byot_enabled: true,
      verified_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ BYOT credentials error:', error);
    res.status(500).json({ error: 'Failed to save Twilio credentials' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/byot/regulatory
// ----------------------------------------------------------------------------
// Save (or clear) the Twilio Regulatory Compliance Bundle SID and Address SID
// used for international number purchases. Kept separate from /credentials so
// an agency can add these later (once their bundle is approved) WITHOUT having
// to re-enter their write-only API secret.
//
// Field semantics per key in the body:
//   - omitted            -> left unchanged
//   - "" (empty string)  -> cleared (set null)
//   - a value            -> validated (BU.../AD..., 34 chars) then saved
// These are what provisionBYOTNumber passes as BundleSid / AddressSid on the
// buy. A validated address existing in the Twilio account is not enough on its
// own; the purchase must reference the Address SID, which is what this stores.
// ============================================================================
router.post('/:agencyId/byot/regulatory', requireProPlan, async (req, res) => {
  const { agencyId } = req.params;

  // Normalize: undefined => not provided (leave unchanged); "" => clear (null).
  const norm = (v) => {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === '' ? null : s;
  };

  const bundleSid = norm(req.body.twilio_bundle_sid);
  const addressSid = norm(req.body.twilio_address_sid);

  if (typeof bundleSid === 'string' && (!bundleSid.startsWith('BU') || bundleSid.length !== 34)) {
    return res.status(400).json({ error: 'Invalid Bundle SID. It should start with BU and be 34 characters.' });
  }
  if (typeof addressSid === 'string' && (!addressSid.startsWith('AD') || addressSid.length !== 34)) {
    return res.status(400).json({ error: 'Invalid Address SID. It should start with AD and be 34 characters.' });
  }

  if (bundleSid === undefined && addressSid === undefined) {
    return res.status(400).json({ error: 'Nothing to update. Provide a Bundle SID and/or an Address SID.' });
  }

  try {
    const update = { updated_at: new Date().toISOString() };
    if (bundleSid !== undefined) update.twilio_bundle_sid = bundleSid;
    if (addressSid !== undefined) update.twilio_address_sid = addressSid;

    const { error } = await supabase.from('agencies').update(update).eq('id', agencyId);
    if (error) throw error;

    console.log(`✅ BYOT regulatory SIDs saved for agency ${agencyId}`);

    res.json({
      success: true,
      message: 'Regulatory SIDs saved.',
      twilio_bundle_sid: bundleSid !== undefined ? bundleSid : (req.agency.twilio_bundle_sid || null),
      twilio_address_sid: addressSid !== undefined ? addressSid : (req.agency.twilio_address_sid || null),
    });
  } catch (error) {
    console.error('❌ Failed to save BYOT regulatory SIDs:', error);
    res.status(500).json({ error: 'Failed to save regulatory SIDs' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/byot/test
// ============================================================================
router.post('/:agencyId/byot/test', requireProPlan, async (req, res) => {
  const { agency } = req;
  const { country_code = 'CA' } = req.body;

  if (!agency.twilio_account_sid || !agency.twilio_api_key_encrypted) {
    return res.status(400).json({ error: 'No Twilio credentials configured. Save credentials first.' });
  }

  try {
    const apiKey = decrypt(agency.twilio_api_key_encrypted);
    const apiSecret = decrypt(agency.twilio_api_secret_encrypted);
    const authHeader = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

    const searchUrl = `https://api.twilio.com/2010-04-01/Accounts/${agency.twilio_account_sid}/AvailablePhoneNumbers/${country_code}/Local.json?Limit=3`;

    const searchResponse = await fetch(searchUrl, {
      headers: { 'Authorization': `Basic ${authHeader}` }
    });

    if (!searchResponse.ok) {
      const errorData = await searchResponse.json().catch(() => ({}));

      if (errorData.code === 21649) {
        return res.json({
          success: false,
          error: 'regulatory_bundle_required',
          message: `Phone numbers in ${country_code} require a regulatory bundle. Please complete identity verification in your Twilio console first.`,
          twilio_url: 'https://console.twilio.com/us1/develop/phone-numbers/regulatory-compliance/bundles'
        });
      }

      return res.json({
        success: false,
        error: 'search_failed',
        message: errorData.message || `Cannot search numbers in ${country_code}. Status: ${searchResponse.status}`,
      });
    }

    const data = await searchResponse.json();
    const numbers = (data.available_phone_numbers || []).map(n => ({
      number: n.phone_number,
      friendly_name: n.friendly_name,
      locality: n.locality,
      region: n.region
    }));

    console.log(`✅ BYOT test: Found ${numbers.length} available numbers in ${country_code}`);

    // NOTE: search validates NEITHER a regulatory bundle NOR an address, so a
    // successful search does not mean a purchase will succeed in a regulated
    // country. The message is intentionally about search readiness only.
    res.json({
      success: true,
      country_code,
      available_numbers: numbers,
      message: `Found ${numbers.length} available numbers in ${country_code}. Numbers are searchable; regulated countries (e.g. GB) also need an approved bundle and address SID saved before purchase.`
    });

  } catch (error) {
    console.error('❌ BYOT test error:', error);
    res.status(500).json({ error: 'Failed to test Twilio connection' });
  }
});

// ============================================================================
// DELETE /api/agency/:agencyId/byot/credentials
// ============================================================================
router.delete('/:agencyId/byot/credentials', requireProPlan, async (req, res) => {
  const { agencyId } = req.params;

  try {
    const { error } = await supabase
      .from('agencies')
      .update({
        twilio_account_sid: null,
        twilio_api_key_encrypted: null,
        twilio_api_secret_encrypted: null,
        byot_enabled: false,
        byot_verified_at: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', agencyId);

    if (error) throw error;

    console.log(`🗑️ BYOT credentials removed for agency ${agencyId}`);

    res.json({
      success: true,
      message: 'Twilio credentials removed. New clients will be provisioned through the platform.',
      byot_enabled: false
    });
  } catch (error) {
    console.error('❌ Error removing BYOT credentials:', error);
    res.status(500).json({ error: 'Failed to remove credentials' });
  }
});

// ============================================================================
// IMPORT A TWILIO NUMBER INTO VAPI (self-correcting credential shape)
// ----------------------------------------------------------------------------
// VAPI has changed how it accepts Twilio credentials on import, and its docs
// are not consistent about the exact JSON field names. We only ever store an
// API Key (SK...) + API Secret for the agency (never the account Auth Token,
// which the BYOT form does not collect), so those are the only credentials we
// can send. We therefore try the shapes VAPI is known to accept, in order:
//   1. apiKey / apiSecret          (VAPI's newer API-key method, Apr 2025)
//   2. twilioApiKey / twilioApiSecret  (older field spelling, fallback)
// The first attempt that returns a 2xx wins. VAPI validates strictly and
// rejects unknown properties, so each attempt sends a clean body (no mixing).
// Returns the parsed VAPI phone object on success, or throws with the last
// error text (which contains "VAPI import failed" so demo-phone.js can map it
// to a friendly message). The caller is responsible for releasing the number
// on a thrown failure.
// ============================================================================
async function importTwilioNumberToVapi({ number, accountSid, apiKey, apiSecret, assistantId, businessName }) {
  const base = {
    provider: 'twilio',
    number,
    twilioAccountSid: accountSid,
    name: `${businessName} - Business Line`,
    assistantId,
    serverUrl: `${BACKEND_URL}/webhook/vapi`,
  };

  const credentialShapes = [
    { apiKey, apiSecret },
    { twilioApiKey: apiKey, twilioApiSecret: apiSecret },
  ];

  let lastError = '';
  for (const cred of credentialShapes) {
    const res = await fetch('https://api.vapi.ai/phone-number', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, ...cred }),
    });
    if (res.ok) {
      return await res.json();
    }
    lastError = await res.text().catch(() => '');
    console.error(`❌ VAPI import attempt failed (HTTP ${res.status}) using fields [${Object.keys(cred).join(', ')}]: ${lastError.slice(0, 200)}`);
  }

  throw new Error(`VAPI import failed for ${number}: ${lastError.slice(0, 200)}`);
}

// ============================================================================
// BYOT PROVISIONING LOGIC (exported for use in client-signup.js)
// ============================================================================
async function provisionBYOTNumber(agency, options) {
  const { countryCode, areaCode, assistantId, businessName } = options;

  if (!agency.twilio_account_sid || !agency.twilio_api_key_encrypted) {
    throw new Error('Agency does not have Twilio credentials configured');
  }

  const apiKey = decrypt(agency.twilio_api_key_encrypted);
  const apiSecret = decrypt(agency.twilio_api_secret_encrypted);
  const authHeader = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const accountSid = agency.twilio_account_sid;

  console.log(`📞 BYOT: Provisioning ${countryCode} number for ${businessName} via agency's Twilio`);

  let searchUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/${countryCode}/Local.json?Limit=5`;
  if (areaCode) {
    searchUrl += `&AreaCode=${areaCode}`;
  }

  const searchResponse = await fetch(searchUrl, {
    headers: { 'Authorization': `Basic ${authHeader}` }
  });

  if (!searchResponse.ok) {
    const errorData = await searchResponse.json().catch(() => ({}));
    if (errorData.code === 21649) {
      throw new Error(`Regulatory bundle required for ${countryCode}. Complete verification at https://console.twilio.com/us1/develop/phone-numbers/regulatory-compliance/bundles`);
    }
    throw new Error(`No numbers available in ${countryCode}${areaCode ? ` (area code ${areaCode})` : ''}: ${errorData.message || 'Unknown error'}`);
  }

  const searchData = await searchResponse.json();
  const availableNumbers = searchData.available_phone_numbers || [];

  if (availableNumbers.length === 0) {
    throw new Error(`No phone numbers available in ${countryCode}${areaCode ? ` (area code ${areaCode})` : ''}`);
  }

  const selectedNumber = availableNumbers[0].phone_number;
  console.log(`   Found ${availableNumbers.length} numbers, selected: ${selectedNumber}`);

  // Build the purchase body. Regulated countries (e.g. GB) reject a buy that
  // does not reference an approved Regulatory Compliance Bundle and/or a
  // validated Address. Twilio accepts these here as BundleSid / AddressSid. We
  // pass whichever the agency has stored; when neither is set (US, Canada, and
  // other non-regulated buys) nothing extra is sent and behavior is unchanged.
  // A validated address merely existing on the Twilio account is not enough on
  // its own: the purchase must point at its Address SID, which is what this
  // sends.
  const buyParams = {
    PhoneNumber: selectedNumber,
    FriendlyName: `${businessName} - AI Receptionist`
  };
  if (agency.twilio_bundle_sid) buyParams.BundleSid = agency.twilio_bundle_sid;
  if (agency.twilio_address_sid) buyParams.AddressSid = agency.twilio_address_sid;

  const buyResponse = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(buyParams).toString()
    }
  );

  if (!buyResponse.ok) {
    const errorData = await buyResponse.json().catch(() => ({}));
    throw new Error(`Failed to purchase ${selectedNumber}: ${errorData.message || 'Unknown error'}`);
  }

  const purchasedNumber = await buyResponse.json();
  console.log(`   ✅ Purchased: ${purchasedNumber.phone_number} (SID: ${purchasedNumber.sid})`);

  // Import into VAPI, trying each credential shape VAPI may accept. On total
  // failure the number is ALREADY bought on the agency's Twilio, so release it
  // before throwing to avoid leaking a billable line (the old code only logged
  // "CLEANUP NEEDED" and left it renting forever).
  let vapiPhone;
  try {
    vapiPhone = await importTwilioNumberToVapi({
      number: purchasedNumber.phone_number,
      accountSid,
      apiKey,
      apiSecret,
      assistantId,
      businessName,
    });
  } catch (importErr) {
    console.error(`❌ ${importErr.message}`);
    console.error(`⚠️ Releasing ${purchasedNumber.phone_number} (SID: ${purchasedNumber.sid}) from the agency's Twilio after failed VAPI import.`);
    try {
      await releaseBYOTNumber(agency, purchasedNumber.phone_number);
    } catch (relErr) {
      console.error(`❌ Release after failed import also failed for ${purchasedNumber.phone_number}:`, relErr.message);
    }
    throw importErr;
  }

  console.log(`   ✅ Imported to VAPI: ${vapiPhone.id}`);
  console.log(`🎉 BYOT provisioning complete: ${purchasedNumber.phone_number}`);

  return {
    number: purchasedNumber.phone_number,
    vapiPhoneId: vapiPhone.id,
    twilioSid: purchasedNumber.sid,
    provisioningMethod: 'byot'
  };
}

// ============================================================================
// RELEASE A BYOT (AGENCY TWILIO) NUMBER
// ----------------------------------------------------------------------------
// Deletes a phone number from the AGENCY'S OWN Twilio account so it stops
// billing. This is the Twilio-side counterpart to releaseTelnyxNumber in
// lib/vapi.js. Deleting the VAPI phone object (fullyReleaseNumber) does NOT
// release the underlying carrier number, and for BYOT the carrier is the
// agency's Twilio, not the platform Telnyx account, so it must be deleted here.
// Used when tearing down an international demo line, and now also to release a
// just-purchased number when the VAPI import fails.
//
// No stored SID is required: the number is looked up on the agency's Twilio by
// its E.164 value to find its IncomingPhoneNumber SID, then deleted. Fully
// idempotent and non-throwing:
//   - agency has no Twilio creds                 -> false (nothing we can do)
//   - number not on the account (already gone)   -> true
//   - lookup or decrypt failure                  -> false (logged)
//   - Twilio DELETE returns 204 (or 404)         -> true
// Twilio's delete on an IncomingPhoneNumber returns 204 No Content on success.
// ============================================================================
async function releaseBYOTNumber(agency, e164) {
  if (!agency || !agency.twilio_account_sid || !agency.twilio_api_key_encrypted) {
    console.warn('⚠️ releaseBYOTNumber: agency has no Twilio credentials, nothing to release');
    return false;
  }
  if (!e164) {
    console.warn('⚠️ releaseBYOTNumber: no number provided');
    return false;
  }

  // Normalize to E.164 (Twilio stores +<country><subscriber>).
  let number = String(e164).trim();
  if (!number.startsWith('+')) number = `+${number.replace(/\D/g, '')}`;

  let apiKey, apiSecret;
  try {
    apiKey = decrypt(agency.twilio_api_key_encrypted);
    apiSecret = decrypt(agency.twilio_api_secret_encrypted);
  } catch (err) {
    console.error('❌ releaseBYOTNumber: failed to decrypt Twilio credentials:', err.message);
    return false;
  }

  const accountSid = agency.twilio_account_sid;
  const authHeader = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  try {
    // 1. Find the IncomingPhoneNumber SID for this E.164 on the agency's Twilio.
    const lookupRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
      { headers: { 'Authorization': `Basic ${authHeader}` } }
    );
    if (!lookupRes.ok) {
      const t = await lookupRes.text().catch(() => '');
      console.error(`❌ releaseBYOTNumber lookup failed for ${number}: HTTP ${lookupRes.status} ${t.slice(0, 160)}`);
      return false;
    }
    const record = ((await lookupRes.json()).incoming_phone_numbers || [])[0];
    if (!record || !record.sid) {
      // Not on this account. Already released or never owned here. Treat as done.
      console.log(`ℹ️ releaseBYOTNumber: ${number} not found on agency Twilio (already released?)`);
      return true;
    }

    // 2. Delete it. Twilio returns 204 No Content on success.
    const delRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${record.sid}.json`,
      { method: 'DELETE', headers: { 'Authorization': `Basic ${authHeader}` } }
    );
    if (delRes.ok || delRes.status === 204 || delRes.status === 404) {
      console.log(`✅ BYOT Twilio number RELEASED: ${number} (${record.sid})`);
      return true;
    }
    const t = await delRes.text().catch(() => '');
    console.error(`❌ releaseBYOTNumber delete failed for ${number} (${record.sid}): HTTP ${delRes.status} ${t.slice(0, 160)}`);
    return false;
  } catch (err) {
    console.error(`❌ releaseBYOTNumber error for ${number}:`, err.message);
    return false;
  }
}

module.exports = router;
module.exports.provisionBYOTNumber = provisionBYOTNumber;
module.exports.releaseBYOTNumber = releaseBYOTNumber;