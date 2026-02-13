// ============================================================================
// BYOT (Bring Your Own Twilio) ROUTES
// Enterprise/Scale plan feature — agencies use their own Twilio account
// for international number provisioning
// Destination: src/routes/byot.js
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase, getAgencyById } = require('../lib/supabase');
const { encrypt, decrypt } = require('../lib/encryption');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';

// ============================================================================
// MIDDLEWARE: Require Enterprise/Scale plan (with trial access)
// ============================================================================
async function requireScalePlan(req, res, next) {
  const { agencyId } = req.params;

  try {
    const agency = await getAgencyById(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    const isTrialing = ['trialing', 'trial'].includes(agency.subscription_status);
    const effectivePlan = isTrialing ? 'enterprise' : agency.plan_type;

    if (effectivePlan !== 'enterprise') {
      return res.status(403).json({
        error: 'Scale plan required',
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
// Check BYOT configuration status
// ============================================================================
router.get('/:agencyId/byot/status', requireScalePlan, async (req, res) => {
  const { agency } = req;

  res.json({
    byot_enabled: agency.byot_enabled || false,
    has_credentials: !!(agency.twilio_account_sid && agency.twilio_api_key_encrypted),
    twilio_account_sid: agency.twilio_account_sid || null,
    verified_at: agency.byot_verified_at || null,
  });
});

// ============================================================================
// POST /api/agency/:agencyId/byot/credentials
// Save and validate Twilio credentials
// ============================================================================
router.post('/:agencyId/byot/credentials', requireScalePlan, async (req, res) => {
  const { agencyId } = req.params;
  const { twilio_account_sid, twilio_api_key, twilio_api_secret } = req.body;

  if (!twilio_account_sid || !twilio_api_key || !twilio_api_secret) {
    return res.status(400).json({
      error: 'All Twilio credentials required',
      required: ['twilio_account_sid', 'twilio_api_key', 'twilio_api_secret']
    });
  }

  // Basic format validation
  if (!twilio_account_sid.startsWith('AC') || twilio_account_sid.length !== 34) {
    return res.status(400).json({ error: 'Invalid Twilio Account SID format. Should start with AC and be 34 characters.' });
  }
  if (!twilio_api_key.startsWith('SK') || twilio_api_key.length !== 34) {
    return res.status(400).json({ error: 'Invalid Twilio API Key format. Should start with SK and be 34 characters.' });
  }

  try {
    // ============================================
    // STEP 1: Validate credentials against Twilio API
    // ============================================
    console.log(`🔑 Validating Twilio credentials for agency ${agencyId}...`);

    const twilioAuthHeader = Buffer.from(`${twilio_api_key}:${twilio_api_secret}`).toString('base64');
    // Use IncomingPhoneNumbers endpoint for validation — Standard API keys
    // cannot access /Accounts/{SID}.json (requires Main key), but can access
    // sub-resource endpoints like IncomingPhoneNumbers
    const twilioResponse = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilio_account_sid}/IncomingPhoneNumbers.json?PageSize=1`,
      {
        headers: { 'Authorization': `Basic ${twilioAuthHeader}` }
      }
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

    // ============================================
    // STEP 2: Encrypt and store credentials
    // ============================================
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
// POST /api/agency/:agencyId/byot/test
// Test that credentials can search for available phone numbers
// ============================================================================
router.post('/:agencyId/byot/test', requireScalePlan, async (req, res) => {
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

    res.json({
      success: true,
      country_code,
      available_numbers: numbers,
      message: `Found ${numbers.length} available numbers in ${country_code}. Your Twilio account is ready for provisioning.`
    });

  } catch (error) {
    console.error('❌ BYOT test error:', error);
    res.status(500).json({ error: 'Failed to test Twilio connection' });
  }
});

// ============================================================================
// DELETE /api/agency/:agencyId/byot/credentials
// Remove BYOT credentials and disable BYOT
// ============================================================================
router.delete('/:agencyId/byot/credentials', requireScalePlan, async (req, res) => {
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
// BYOT PROVISIONING LOGIC (exported for use in client-signup.js)
// ============================================================================

/**
 * Provision a phone number using agency's Twilio credentials,
 * then import it into VAPI attached to the given assistant.
 */
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

  // STEP 1: Search for available numbers
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

  // STEP 2: Buy the number on agency's Twilio
  const buyResponse = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        PhoneNumber: selectedNumber,
        FriendlyName: `${businessName} - AI Receptionist`
      }).toString()
    }
  );

  if (!buyResponse.ok) {
    const errorData = await buyResponse.json().catch(() => ({}));
    throw new Error(`Failed to purchase ${selectedNumber}: ${errorData.message || 'Unknown error'}`);
  }

  const purchasedNumber = await buyResponse.json();
  console.log(`   ✅ Purchased: ${purchasedNumber.phone_number} (SID: ${purchasedNumber.sid})`);

  // STEP 3: Import into VAPI using agency's Twilio credentials
  const vapiResponse = await fetch('https://api.vapi.ai/phone-number', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      provider: 'twilio',
      number: purchasedNumber.phone_number,
      twilioAccountSid: accountSid,
      twilioApiKey: apiKey,
      twilioApiSecret: apiSecret,
      name: `${businessName} - Business Line`,
      assistantId: assistantId,
      serverUrl: `${BACKEND_URL}/webhook/vapi`
    })
  });

  if (!vapiResponse.ok) {
    const vapiError = await vapiResponse.text();
    console.error(`❌ VAPI import failed: ${vapiError}`);
    console.error(`⚠️ CLEANUP NEEDED: Number ${purchasedNumber.phone_number} (SID: ${purchasedNumber.sid}) purchased on Twilio but not imported to VAPI`);
    throw new Error(`VAPI import failed for ${purchasedNumber.phone_number}: ${vapiError}`);
  }

  const vapiPhone = await vapiResponse.json();
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
// EXPORTS
// ============================================================================
module.exports = router;
module.exports.provisionBYOTNumber = provisionBYOTNumber;