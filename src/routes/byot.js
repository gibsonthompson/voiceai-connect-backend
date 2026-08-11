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
// UPDATED: 2026-08-07 - Lane 2 (two-way SMS) provisioning. provisionBYOTNumber
//          now accepts an smsCapable option; when true on a non-US number it
//          provisions a MOBILE number (the only non-US type that can send AND
//          receive SMS) instead of a Local number, passes the MOBILE regulatory
//          bundle (twilio_mobile_bundle_sid, distinct from the Local bundle),
//          and after the VAPI import points the number's inbound SmsUrl at
//          /webhook/twilio-sms so two-way texts reach the client's Messages
//          tab. Default smsCapable=false keeps the existing Local behavior, so
//          every current caller is unchanged. The regulatory endpoint + status
//          now also store/return twilio_mobile_bundle_sid for the settings UI.
// UPDATED: 2026-08-11 - Fixed VAPI import failing on the "name" field. VAPI
//          caps the phone-number label at 40 characters and 400s the whole
//          import when it is longer. The demo path builds businessName as
//          "<agency name> Demo" and then this import appended " - Business
//          Line", which for a normal-length agency name pushed past 40 (e.g.
//          "Wexl Voice Receptionist Demo - Business Line" is 44) and failed
//          EVERY non-US import AFTER the number had already been bought, then
//          rolled it back. The credential form (twilioApiKey/twilioApiSecret)
//          was already correct; length was the only thing VAPI rejected. The
//          label is now capped: full "<name> - Business Line" when it fits,
//          otherwise the business name trimmed to 40. This also silently
//          repaired real non-US CLIENT signups, where any business name of 25+
//          characters hit the same 400 (the 16-char suffix leaves only 24).
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
    // Mobile-type regulatory bundle, used for smsCapable (two-way SMS) mobile
    // purchases. Distinct from the Local bundle above. Null when not configured.
    twilio_mobile_bundle_sid: agency.twilio_mobile_bundle_sid || null,
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
// Save (or clear) the Twilio Regulatory Compliance Bundle SID(s) and Address
// SID used for international number purchases. Kept separate from /credentials
// so an agency can add these later (once their bundle is approved) WITHOUT
// having to re-enter their write-only API secret.
//
// Three keys, each independently settable:
//   - twilio_bundle_sid         Local-number bundle (voice / one-way SMS lines)
//   - twilio_address_sid        validated Address, shared by both number types
//   - twilio_mobile_bundle_sid  Mobile-number bundle (two-way SMS lines). A
//                               mobile number is a different regulation set from
//                               a Local number, so it needs its OWN bundle; the
//                               Local bundle will not authorize a mobile buy.
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
  const mobileBundleSid = norm(req.body.twilio_mobile_bundle_sid);

  if (typeof bundleSid === 'string' && (!bundleSid.startsWith('BU') || bundleSid.length !== 34)) {
    return res.status(400).json({ error: 'Invalid Bundle SID. It should start with BU and be 34 characters.' });
  }
  if (typeof addressSid === 'string' && (!addressSid.startsWith('AD') || addressSid.length !== 34)) {
    return res.status(400).json({ error: 'Invalid Address SID. It should start with AD and be 34 characters.' });
  }
  if (typeof mobileBundleSid === 'string' && (!mobileBundleSid.startsWith('BU') || mobileBundleSid.length !== 34)) {
    return res.status(400).json({ error: 'Invalid Mobile Bundle SID. It should start with BU and be 34 characters.' });
  }

  if (bundleSid === undefined && addressSid === undefined && mobileBundleSid === undefined) {
    return res.status(400).json({ error: 'Nothing to update. Provide a Bundle SID, Address SID, and/or Mobile Bundle SID.' });
  }

  try {
    const update = { updated_at: new Date().toISOString() };
    if (bundleSid !== undefined) update.twilio_bundle_sid = bundleSid;
    if (addressSid !== undefined) update.twilio_address_sid = addressSid;
    if (mobileBundleSid !== undefined) update.twilio_mobile_bundle_sid = mobileBundleSid;

    const { error } = await supabase.from('agencies').update(update).eq('id', agencyId);
    if (error) throw error;

    console.log(`✅ BYOT regulatory SIDs saved for agency ${agencyId}`);

    res.json({
      success: true,
      message: 'Regulatory SIDs saved.',
      twilio_bundle_sid: bundleSid !== undefined ? bundleSid : (req.agency.twilio_bundle_sid || null),
      twilio_address_sid: addressSid !== undefined ? addressSid : (req.agency.twilio_address_sid || null),
      twilio_mobile_bundle_sid: mobileBundleSid !== undefined ? mobileBundleSid : (req.agency.twilio_mobile_bundle_sid || null),
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
//
// NOTE (2026-08-11): VAPI also caps the "name" (label) at 40 characters and
// 400s the entire import if it is longer. This is enforced regardless of which
// credential shape is used, so a too-long name fails BOTH attempts and looks
// like a credential problem when it is not. We cap the name below before
// building the body.
// ============================================================================
async function importTwilioNumberToVapi({ number, accountSid, apiKey, apiSecret, assistantId, businessName }) {
  // VAPI caps the phone-number "name" at 40 chars (inclusive). Keep the full
  // "<business name> - Business Line" label when it fits; otherwise fall back to
  // the business name trimmed to 40 so the label stays meaningful and the
  // import never 400s on length. Trailing whitespace is trimmed so a cut never
  // leaves a dangling space.
  const fullName = `${businessName} - Business Line`;
  const name = fullName.length <= 40 ? fullName : businessName.slice(0, 40).trimEnd();

  const base = {
    provider: 'twilio',
    number,
    twilioAccountSid: accountSid,
    name,
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
// ----------------------------------------------------------------------------
// options:
//   countryCode   ISO-2 country of the number to buy (agency country)
//   areaCode      optional; applies to Local numbers only
//   assistantId   VAPI assistant to attach on import
//   businessName  used for FriendlyName / VAPI name
//   smsCapable    optional (default false). When true on a NON-US number, buys
//                 a MOBILE number (send + receive SMS) instead of Local and
//                 wires its inbound SmsUrl to /webhook/twilio-sms. false keeps
//                 the existing Local behavior, so all current callers unchanged.
// ============================================================================
async function provisionBYOTNumber(agency, options) {
  const { countryCode, areaCode, assistantId, businessName, smsCapable = false } = options;

  if (!agency.twilio_account_sid || !agency.twilio_api_key_encrypted) {
    throw new Error('Agency does not have Twilio credentials configured');
  }

  const apiKey = decrypt(agency.twilio_api_key_encrypted);
  const apiSecret = decrypt(agency.twilio_api_secret_encrypted);
  const authHeader = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const accountSid = agency.twilio_account_sid;

  // Number type. smsCapable on a NON-US number provisions a MOBILE number: it
  // is the only non-US type that can both send and receive SMS, so it is what
  // enables two-way texting. The same number still serves voice (callers are
  // forwarded to it, so the type is invisible to them). US always stays Local.
  // Default smsCapable=false keeps the existing Local behavior for every current
  // caller, so this is non-breaking.
  const cc = (countryCode || 'US').toUpperCase();
  const useMobile = smsCapable === true && cc !== 'US';
  const numberType = useMobile ? 'Mobile' : 'Local';

  console.log(`📞 BYOT: Provisioning ${cc} ${numberType} number for ${businessName} via agency's Twilio${useMobile ? ' (SMS-capable)' : ''}`);

  let searchUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/${cc}/${numberType}.json?Limit=5`;
  if (useMobile) {
    // Only surface mobile numbers that can actually do SMS.
    searchUrl += '&SmsEnabled=true';
  } else if (areaCode) {
    // Area code applies to Local numbers; mobile ranges are not area-coded.
    searchUrl += `&AreaCode=${areaCode}`;
  }

  const searchResponse = await fetch(searchUrl, {
    headers: { 'Authorization': `Basic ${authHeader}` }
  });

  if (!searchResponse.ok) {
    const errorData = await searchResponse.json().catch(() => ({}));
    if (errorData.code === 21649) {
      throw new Error(`Regulatory bundle required for ${cc} ${numberType}. Complete verification at https://console.twilio.com/us1/develop/phone-numbers/regulatory-compliance/bundles`);
    }
    throw new Error(`No ${numberType} numbers available in ${cc}${!useMobile && areaCode ? ` (area code ${areaCode})` : ''}: ${errorData.message || 'Unknown error'}`);
  }

  const searchData = await searchResponse.json();
  const availableNumbers = searchData.available_phone_numbers || [];

  if (availableNumbers.length === 0) {
    throw new Error(`No ${numberType} phone numbers available in ${cc}${!useMobile && areaCode ? ` (area code ${areaCode})` : ''}`);
  }

  const selectedNumber = availableNumbers[0].phone_number;
  console.log(`   Found ${availableNumbers.length} ${numberType} number(s), selected: ${selectedNumber}`);

  // Build the purchase body. Regulated countries (e.g. GB) reject a buy that
  // does not reference an approved Regulatory Compliance Bundle and/or a
  // validated Address. Twilio accepts these as BundleSid / AddressSid. A MOBILE
  // number is a different regulation set from a Local number and needs the
  // MOBILE bundle (twilio_mobile_bundle_sid); passing the Local bundle for a
  // mobile buy is rejected by Twilio, so we never fall back to it. Local buys
  // keep using twilio_bundle_sid. The Address SID is shared. When the relevant
  // bundle is not set (US, Canada, and other non-regulated buys) nothing extra
  // is sent and behavior is unchanged.
  const buyParams = {
    PhoneNumber: selectedNumber,
    FriendlyName: `${businessName} - AI Receptionist`
  };
  if (useMobile) {
    if (agency.twilio_mobile_bundle_sid) buyParams.BundleSid = agency.twilio_mobile_bundle_sid;
  } else {
    if (agency.twilio_bundle_sid) buyParams.BundleSid = agency.twilio_bundle_sid;
  }
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

  // For an SMS-capable (mobile) number, point its inbound SmsUrl at our Twilio
  // SMS webhook so two-way texts land in the client's Messages tab. Best-effort:
  // voice already works via the VAPI import above (VAPI owns the VoiceUrl), so a
  // failed SmsUrl update must NOT fail provisioning; it can be re-applied later.
  // Twilio updates an IncomingPhoneNumber via POST to its instance resource.
  if (useMobile) {
    try {
      const smsUrlRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${purchasedNumber.sid}.json`,
        {
          method: 'POST',
          headers: { 'Authorization': `Basic ${authHeader}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ SmsUrl: `${BACKEND_URL}/webhook/twilio-sms`, SmsMethod: 'POST' }).toString()
        }
      );
      if (smsUrlRes.ok) {
        console.log(`   ✅ SmsUrl set on ${purchasedNumber.phone_number} -> ${BACKEND_URL}/webhook/twilio-sms`);
      } else {
        const t = await smsUrlRes.text().catch(() => '');
        console.error(`   ⚠️ Failed to set SmsUrl on ${purchasedNumber.phone_number} (HTTP ${smsUrlRes.status}); voice works, inbound SMS can be re-applied: ${t.slice(0, 160)}`);
      }
    } catch (smsUrlErr) {
      console.error(`   ⚠️ SmsUrl set threw for ${purchasedNumber.phone_number} (voice works; inbound SMS can be re-applied):`, smsUrlErr.message);
    }
  }

  console.log(`🎉 BYOT provisioning complete: ${purchasedNumber.phone_number}`);

  return {
    number: purchasedNumber.phone_number,
    vapiPhoneId: vapiPhone.id,
    twilioSid: purchasedNumber.sid,
    provisioningMethod: 'byot',
    smsCapable: useMobile,
    numberType: numberType.toLowerCase()
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