// ============================================================================
// CLIENT SIGNUP & PROVISIONING - Multi-Tenant
// WITH BYOT (Bring Your Own Twilio) SUPPORT
// WITH INTERNATIONAL CLIENT SUPPORT
// WITH OPTIONAL PASSWORD AT SIGNUP (Phase 2A)
// WITH AGENCY TEMPLATE KB INHERITANCE
// UPDATED: Phase 2 — Phone numbers use serverUrl only (no assistantId)
// UPDATED: Extract and store vapi_query_tool_id for dynamic config builder
// UPDATED: New clients inherit nav_bg/nav_text from agency defaults (2026-04-17)
// UPDATED: 2026-05-07 — Per-client billing triggers on client add (pricing restructure)
// UPDATED: 2026-05-19 — Two-way SMS: auto-assign messaging profile + 10DLC campaign
// UPDATED: 2026-05-20 — Rollback: clean up orphaned VAPI resources (assistant, KB,
//          query tool) when phone provisioning fails. Guard SMS sends against
//          undefined phone numbers. Better error messages for Telnyx 402.
// UPDATED: 2026-05-29 — Fix: agency_id now set on user record in all signup paths
// UPDATED: 2026-06-08 — Phase 1 double-billing fix: handleClientSignup now
//          HONORS req.body.planType (starter|pro|growth) instead of hardcoding
//          'starter'. Matches the pattern already in handleAgencyAddClient.
//          /signup/plan was posting the user's selected plan; backend was
//          silently dropping it and dumping every signup into a Starter trial.
//          Users then re-selected their intended plan on /upgrade-required,
//          which is where the double-billing happened (now guarded backend-side
//          in stripe-connect.js createClientCheckout).
// UPDATED: 2026-06-08 — Phase 5 hardening: exported signupRateLimiter middleware
//          to throttle /api/client/signup at 5 requests per IP per hour.
//          In-memory token bucket (single-instance safe). Public embed widget
//          makes this endpoint internet-exposed without auth, so a basic
//          rate limit is the bare minimum before CAPTCHA / fraud detection.
// Adapted from CallBird's native-signup.js
// ============================================================================
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase, getAgencyById, getClientByEmail } = require('../lib/supabase');
const { 
  createIndustryAssistant, 
  provisionLocalPhone,
  createKnowledgeBaseFromWebsite 
} = require('../lib/vapi');
const { 
  formatPhoneE164,
  sendClientWelcomeEmail,
  sendWelcomeSMS,
  sendClientSignupNotificationSMS
} = require('../lib/notifications');

// Import client limit checker from stripe-platform
const { canAgencyAddClient } = require('./stripe-platform');

// Import BYOT provisioning
const { provisionBYOTNumber } = require('./byot');

// Import per-client billing update
const { updateClientBillingQuantity } = require('../lib/usage-tracker');

// ============================================================================
// VALID CLIENT PLANS — single source of truth for plan-tier validation
// across handleClientSignup, handleAgencyAddClient, and provisionClient.
// ============================================================================
const VALID_CLIENT_PLANS = ['starter', 'pro', 'growth'];

// ============================================================================
// RATE LIMITER (Phase 5) — in-memory token bucket for /api/client/signup
// ----------------------------------------------------------------------------
// The public embed widget makes this endpoint reachable by anyone with the
// snippet. Without throttling, a single script could spin up arbitrary
// numbers of VAPI assistants + Telnyx numbers, each of which costs real
// money the moment they're provisioned. This caps the damage at 5 attempts
// per source IP per hour.
//
// Implementation notes:
//  - In-memory Map. Resets on server restart. That's acceptable for a single
//    DigitalOcean instance; if we scale horizontally, swap for Redis.
//  - Window-based, not sliding: 1-hour fixed window per IP. Simpler and good
//    enough. A determined attacker rotating IPs is a separate problem
//    (CAPTCHA, captcha-grade fraud detection) for Phase 5+.
//  - IP detection prefers x-forwarded-for[0] because we sit behind DO's
//    load balancer. req.ip would be the LB peer otherwise.
//  - Periodic prune every 10 min keeps the Map bounded.
//  - dev/test bypass: NODE_ENV !== 'production' skips the limiter so local
//    runs and integration tests don't trip on themselves.
// ============================================================================
const SIGNUP_RATE_LIMIT_MAX = 5;            // requests per window per IP
const SIGNUP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;  // 1 hour
const signupAttempts = new Map(); // ip -> { count, resetAt }

// Periodic cleanup of expired buckets so the Map can't grow unbounded.
// 10-minute interval is plenty given a 1-hour window.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of signupAttempts.entries()) {
    if (bucket.resetAt <= now) signupAttempts.delete(ip);
  }
}, 10 * 60 * 1000).unref(); // unref so the timer doesn't keep the process alive in tests

function getClientIp(req) {
  // x-forwarded-for is a chain set by DO's LB; first entry is the original
  // caller. Fall back to req.ip (which is the LB peer if trust proxy isn't
  // set — still useful as a partial identifier locally).
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function signupRateLimiter(req, res, next) {
  // Skip in non-production so dev / integration tests don't self-limit.
  if (process.env.NODE_ENV !== 'production') return next();

  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = signupAttempts.get(ip);

  if (!bucket || bucket.resetAt <= now) {
    // First request from this IP, or previous window has expired — open a
    // fresh window.
    signupAttempts.set(ip, { count: 1, resetAt: now + SIGNUP_RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (bucket.count < SIGNUP_RATE_LIMIT_MAX) {
    bucket.count += 1;
    return next();
  }

  // Over the cap. Tell the client when they can try again.
  const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
  res.set('Retry-After', String(retryAfterSec));
  console.warn(`🚫 Signup rate limit hit for IP ${ip} (resets in ${retryAfterSec}s)`);
  return res.status(429).json({
    error: 'rate_limited',
    message: 'Too many signup attempts from this network. Please try again later.',
    retryAfterSec,
  });
}

// ============================================================================
// CLEANUP: Delete orphaned VAPI resources when signup fails mid-flow
// Called when phone provisioning (step 3) fails after assistant/KB creation
// (steps 1-2) already succeeded. Without this, each failed signup leaks
// an assistant + KB file + query tool in VAPI.
// ============================================================================
async function cleanupVapiResources(assistantId, queryToolId, context) {
  if (!assistantId) return;

  console.log(`🧹 Cleaning up orphaned VAPI resources for failed signup: ${context}`);

  try {
    // Delete the assistant (VAPI will also clean up associated phone assignment)
    const res = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` },
    });

    if (res.ok) {
      console.log(`🧹 Deleted orphaned assistant: ${assistantId}`);
    } else {
      console.warn(`⚠️ Failed to delete assistant ${assistantId}: ${res.status}`);
    }
  } catch (err) {
    console.warn(`⚠️ VAPI cleanup error (assistant): ${err.message}`);
  }

  // Also try to delete the query tool if it exists
  if (queryToolId) {
    try {
      const res = await fetch(`https://api.vapi.ai/tool/${queryToolId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` },
      });

      if (res.ok) {
        console.log(`🧹 Deleted orphaned query tool: ${queryToolId}`);
      }
    } catch (err) {
      console.warn(`⚠️ VAPI cleanup error (tool): ${err.message}`);
    }
  }
}

// ============================================================================
// ENABLE SMS FOR PHONE NUMBER
// Assigns the number to a Telnyx messaging profile and 10DLC campaign
// so it can send/receive SMS for two-way messaging.
// Non-blocking — failure here doesn't stop client provisioning.
// ============================================================================
async function enableSMSForNumber(phoneNumber) {
  const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
  const campaignId = process.env.TELNYX_10DLC_CAMPAIGN_ID;
  const apiKey = process.env.TELNYX_API_KEY;

  if (!messagingProfileId || !campaignId || !apiKey) {
    console.log('⚠️ SMS provisioning skipped — TELNYX_MESSAGING_PROFILE_ID or TELNYX_10DLC_CAMPAIGN_ID not configured');
    return { success: false, reason: 'not_configured' };
  }

  const normalized = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber.replace(/\D/g, '')}`;

  try {
    // Step 1: Assign to messaging profile
    const profileRes = await fetch(`https://api.telnyx.com/v2/messaging_phone_numbers/${encodeURIComponent(normalized)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ messaging_profile_id: messagingProfileId }),
    });

    if (!profileRes.ok) {
      const err = await profileRes.text();
      console.warn(`⚠️ SMS messaging profile assignment failed for ${normalized}:`, err);
      return { success: false, reason: 'profile_failed', error: err };
    }

    console.log(`✅ SMS messaging profile assigned: ${normalized}`);

    // Step 2: Assign to 10DLC campaign
    const campaignRes = await fetch('https://api.telnyx.com/v2/10dlc/phoneNumberCampaign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ phoneNumber: normalized, campaignId }),
    });

    if (!campaignRes.ok) {
      const err = await campaignRes.text();
      console.warn(`⚠️ SMS 10DLC campaign assignment failed for ${normalized}:`, err);
      // Profile was assigned — number can still receive inbound, just might get filtered on outbound
      return { success: true, reason: 'campaign_failed', error: err };
    }

    console.log(`✅ SMS 10DLC campaign assigned: ${normalized}`);
    return { success: true };

  } catch (error) {
    console.warn(`⚠️ SMS provisioning error for ${normalized}:`, error.message);
    return { success: false, reason: 'exception', error: error.message };
  }
}

// ============================================================================
// COUNTRY → PROVISIONING METHOD
// ============================================================================
const PLATFORM_PROVISIONING_COUNTRIES = ['US']; // Only US for now

function canPlatformProvision(countryCode) {
  return PLATFORM_PROVISIONING_COUNTRIES.includes(countryCode?.toUpperCase() || 'US');
}

// ============================================================================
// FRIENDLY ERROR MESSAGES
// Converts internal provisioning errors into user-facing messages
// ============================================================================
function getFriendlyProvisioningError(error) {
  const msg = error?.message || '';

  if (msg.includes('Insufficient Funds') || msg.includes('HTTP 402')) {
    return 'Phone number provisioning is temporarily unavailable. The platform team has been notified. Please try again in a few minutes.';
  }

  if (msg.includes('No numbers found') || msg.includes('HTTP 400')) {
    return 'No phone numbers are currently available in that area. Please try a different city or contact support.';
  }

  return 'Phone provisioning failed. Please try again or contact support.';
}

// ============================================================================
// VALIDATION
// ============================================================================
function validateSignupRequest(body) {
  const errors = [];
  
  if (!body.firstName || body.firstName.trim().length < 1) {
    errors.push('First name is required');
  }
  if (!body.email || !body.email.includes('@')) {
    errors.push('Valid email is required');
  }
  const phoneDigits = (body.phone || '').replace(/\D/g, '');
  if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    errors.push('Valid phone number is required (7-15 digits)');
  }
  if (!body.businessName || body.businessName.trim().length < 2) {
    errors.push('Business name is required');
  }
  if (!body.businessCity || body.businessCity.trim().length < 2) {
    errors.push('City is required');
  }
  if (!body.businessState || body.businessState.trim().length < 1) {
    errors.push('State / region is required');
  }
  if (!body.industry) {
    errors.push('Industry is required');
  }
  if (!body.agencyId) {
    errors.push('Agency ID is required');
  }
  
  return errors;
}

// ============================================================================
// PASSWORD TOKEN
// ============================================================================
function generatePasswordToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createPasswordToken(userId, email) {
  const token = generatePasswordToken();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);
  
  const { error } = await supabase
    .from('password_reset_tokens')
    .insert({
      user_id: userId,
      email: email,
      token: token,
      expires_at: expiresAt.toISOString(),
      used: false
    });
  
  if (error) {
    console.error('❌ Error creating password token:', error);
    throw new Error('Failed to create password token');
  }
  
  return token;
}

// ============================================================================
// CONFIGURE PHONE WEBHOOK
// UPDATED: Phase 2 — serverUrl ONLY, no assistantId on the phone number.
// The static assistant remains on VAPI (stored in client.vapi_assistant_id)
// but the phone number uses serverUrl so assistant-request fires.
// ============================================================================
async function configurePhoneWebhook(phoneId, assistantId) {
  try {
    const response = await fetch(`https://api.vapi.ai/phone-number/${phoneId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: null,
        serverUrl: process.env.BACKEND_URL + '/webhook/vapi'
      })
    });

    return response.ok;
  } catch (error) {
    console.error('⚠️ Phone webhook config failed:', error);
    return false;
  }
}

// ============================================================================
// EXTRACT QUERY TOOL ID FROM VAPI ASSISTANT
// After creating an assistant, fetch it back to get the toolIds[0]
// (the KB query tool) so the dynamic config builder can reference it.
// ============================================================================
async function extractQueryToolId(assistantId) {
  if (!assistantId) return null;
  try {
    const response = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` }
    });
    if (!response.ok) return null;
    const assistant = await response.json();
    return assistant.model?.toolIds?.[0] || null;
  } catch {
    return null;
  }
}

// ============================================================================
// UNIFIED PHONE PROVISIONING
// ============================================================================
async function provisionPhoneForClient(agency, clientData, assistantId) {
  const agencyCountry = (agency.country || 'US').toUpperCase();

  // PATH 1: Platform provisioning (US agencies)
  if (canPlatformProvision(agencyCountry)) {
    console.log(`📞 Platform provisioning (${agencyCountry}) for ${clientData.businessName}`);

    const phoneData = await provisionLocalPhone(
      clientData.businessCity,
      clientData.businessState,
      assistantId,
      clientData.businessName,
      clientData.phone
    );

    // Configure webhook — serverUrl only, no assistantId
    await configurePhoneWebhook(phoneData.id, assistantId);

    return {
      number: phoneData.number,
      vapiPhoneId: phoneData.id,
      provisioningMethod: 'platform'
    };
  }

  // PATH 2: BYOT provisioning (international agencies)
  if (agency.byot_enabled && agency.twilio_account_sid && agency.twilio_api_key_encrypted) {
    console.log(`📞 BYOT provisioning (${agencyCountry}) for ${clientData.businessName}`);

    const result = await provisionBYOTNumber(agency, {
      countryCode: agencyCountry,
      areaCode: clientData.areaCode || null,
      assistantId: assistantId,
      businessName: clientData.businessName
    });

    return {
      number: result.number,
      vapiPhoneId: result.vapiPhoneId,
      provisioningMethod: 'byot'
    };
  }

  // PATH 3: International agency without BYOT configured
  throw new Error(
    `Phone provisioning not available for ${agencyCountry}. ` +
    `Please configure your Twilio credentials in Settings → Twilio Integration to provision numbers in your country.`
  );
}

// ============================================================================
// MAIN CLIENT SIGNUP HANDLER (from agency marketing site)
// UPDATED 2026-06-08 — Phase 1: now honors req.body.planType so plan selection
// in /signup/plan is no longer theater. Same validation pattern as
// handleAgencyAddClient below.
// ============================================================================
async function handleClientSignup(req, res) {
  // Track created resources for rollback on failure
  let createdAssistantId = null;
  let createdQueryToolId = null;

  try {
    console.log('📝 Client Signup Request Received');

    const validationErrors = validateSignupRequest(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        error: 'Validation failed',
        errors: validationErrors
      });
    }

    const {
      firstName,
      lastName = '',
      email,
      phone,
      businessName,
      industry,
      businessCity,
      businessState,
      businessCountry,
      websiteUrl: rawWebsiteUrl,
      agencyId,
      password
    } = req.body;

    // ────────────────────────────────────────────────────────────────────
    // Phase 1: Resolve plan from request body. Frontend /signup/plan posts
    // planType when the user picks a tile. Anything not in VALID_CLIENT_PLANS
    // (including missing) falls back to 'starter'. Matches the pattern in
    // handleAgencyAddClient (which already worked correctly).
    // ────────────────────────────────────────────────────────────────────
    const planType = VALID_CLIENT_PLANS.includes(req.body.planType) ? req.body.planType : 'starter';
    if (req.body.planType && !VALID_CLIENT_PLANS.includes(req.body.planType)) {
      console.warn(`⚠️ Invalid planType "${req.body.planType}" from signup request — defaulting to starter`);
    }

    const agency = await getAgencyById(agencyId);
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (agency.status !== 'active' && agency.status !== 'trial') {
      return res.status(403).json({ error: 'Agency is not active' });
    }

    const clientCountry = (businessCountry || agency.country || 'US').toUpperCase();

    const limitCheck = await canAgencyAddClient(agencyId);
    if (!limitCheck.allowed) {
      const isBilling = limitCheck.reason === 'billing_required';
      console.log(`🚫 ${isBilling ? 'Billing required' : 'Client limit reached'} for agency ${agency.name}: ${limitCheck.reason}`);
      return res.status(403).json({ 
        error: isBilling ? 'not_accepting' : 'Client limit reached',
        message: isBilling 
          ? 'This agency is not currently accepting new signups. Please contact them directly.'
          : (limitCheck.message || limitCheck.reason),
        limit: limitCheck.limit,
        current: limitCheck.current
      });
    }
    
    console.log(`✅ Client limit check passed: ${limitCheck.current}/${limitCheck.limit === -1 ? 'unlimited' : limitCheck.limit}`);
    console.log(`🏢 Agency: ${agency.name} (${agency.country || 'US'}) → Client country: ${clientCountry} | Plan: ${planType}`);

    let websiteUrl = rawWebsiteUrl;
    if (websiteUrl && !websiteUrl.startsWith('http')) {
      websiteUrl = `https://${websiteUrl}`;
    }

    const ownerName = lastName ? `${firstName} ${lastName}`.trim() : firstName;
    const formattedOwnerPhone = formatPhoneE164(phone, clientCountry);

    console.log(`📋 Creating client: ${businessName} (${clientCountry}) for agency: ${agency.name}`);

    const existingClient = await getClientByEmail(email.toLowerCase(), agencyId);
    if (existingClient) {
      return res.status(409).json({ 
        error: 'Account already exists',
        message: 'An account with this email already exists for this agency.'
      });
    }

    // PHASE 2A: Hash password if provided
    let passwordHash = null;
    const hasPassword = password && typeof password === 'string' && password.trim().length >= 6;
    if (hasPassword) {
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(password, salt);
      console.log('🔑 Password provided at signup — will store hash directly');
    }

    // ============================================
    // STEP 1: CREATE KNOWLEDGE BASE (if website)
    // ============================================
    let knowledgeBaseData = null;
    if (websiteUrl && websiteUrl.trim().length > 0) {
      console.log('🌐 Creating knowledge base from website...');
      try {
        knowledgeBaseData = await createKnowledgeBaseFromWebsite(websiteUrl, businessName);
        if (knowledgeBaseData) {
          console.log(`✅ Knowledge base ready: ${knowledgeBaseData.knowledgeBaseId}`);
        }
      } catch (kbError) {
        console.error('⚠️ Knowledge base error (non-blocking):', kbError.message);
      }
    }

    // ============================================
    // STEP 2: CREATE VAPI ASSISTANT
    // ============================================
    console.log(`🤖 Creating VAPI assistant for: ${industry}`);
    
    const assistant = await createIndustryAssistant(
      businessName,
      industry,
      knowledgeBaseData,
      formattedOwnerPhone,
      null,     // clientId (not created yet)
      agencyId  // Pass agencyId for template override lookup
    );
    
    createdAssistantId = assistant.id;
    console.log(`✅ Assistant created: ${assistant.id}`);

    // Extract query tool ID for dynamic config builder
    const queryToolId = await extractQueryToolId(assistant.id);
    createdQueryToolId = queryToolId;
    if (queryToolId) console.log(`🔧 Query tool ID extracted: ${queryToolId}`);

    const templateKB = assistant._templateKnowledgeBase || null;
    if (templateKB) {
      console.log(`📚 Agency template KB will be inherited by new client`);
    }

    // ============================================
    // STEP 3: PROVISION PHONE NUMBER (unified)
    // This can fail (Telnyx 402 insufficient funds, no numbers available, etc.)
    // If it fails, we must clean up the VAPI resources created in steps 1-2.
    // ============================================
    let phoneResult;
    try {
      phoneResult = await provisionPhoneForClient(agency, {
        businessCity,
        businessState,
        businessName,
        phone
      }, assistant.id);
    } catch (phoneError) {
      // Phone provisioning failed — clean up VAPI resources
      await cleanupVapiResources(createdAssistantId, createdQueryToolId, businessName);
      createdAssistantId = null;
      createdQueryToolId = null;

      console.error('❌ Phone provisioning failed:', phoneError.message);
      return res.status(503).json({
        error: 'Provisioning failed',
        message: getFriendlyProvisioningError(phoneError),
      });
    }
    
    console.log(`✅ Phone provisioned (${phoneResult.provisioningMethod}): ${phoneResult.number}`);

    // Enable two-way SMS on the provisioned number (non-blocking)
    try { await enableSMSForNumber(phoneResult.number); } catch (e) { console.warn('⚠️ SMS enable failed:', e.message); }

    // ============================================
    // STEP 4: CREATE CLIENT RECORD
    // ────────────────────────────────────────────
    // Phase 1: monthly_call_limit now derived from the chosen plan's column
    // (agency[`limit_${planType}`]) instead of hardcoded agency.limit_starter.
    // ============================================
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const callLimitKey = `limit_${planType}`;
    const callLimit = agency[callLimitKey] ?? agency.limit_starter ?? 50;
    
    const { data: newClient, error: clientError } = await supabase
      .from('clients')
      .insert({
        agency_id: agencyId,
        business_name: businessName,
        business_city: businessCity,
        business_state: businessState,
        country: clientCountry,
        phone_number: phoneResult.number,
        phone_area_code: phoneResult.number.length >= 5 ? phoneResult.number.substring(2, 5) : null,
        owner_name: ownerName,
        owner_phone: formattedOwnerPhone,
        email: email.toLowerCase(),
        industry: industry,
        vapi_assistant_id: assistant.id,
        vapi_phone_number: phoneResult.number,
        vapi_phone_id: phoneResult.vapiPhoneId || null,
        vapi_query_tool_id: queryToolId,
        knowledge_base_id: knowledgeBaseData?.knowledgeBaseId || null,
        knowledge_base_data: templateKB,
        subscription_status: 'trial',
        trial_ends_at: trialEndsAt,
        status: 'active',
        plan_type: planType,
        monthly_call_limit: callLimit,
        calls_this_month: 0,
        business_website: websiteUrl || null,
        provisioning_method: phoneResult.provisioningMethod || 'platform',
        // Inherit nav defaults from agency so new clients match agency's preferred nav style
        nav_bg: agency.default_client_nav_bg || null,
        nav_text: agency.default_client_nav_text || null,
      })
      .select()
      .single();

    if (clientError) {
      console.error('❌ Database error:', clientError);
      throw clientError;
    }

    // Past this point, client record exists — no more rollback needed
    createdAssistantId = null;
    createdQueryToolId = null;

    console.log(`🎉 Client created: ${newClient.business_name} (${clientCountry}, ${phoneResult.provisioningMethod}, ${planType}, limit=${callLimit})`);

    // ── Update per-client billing for the agency (non-blocking) ─────
    try {
      const billingResult = await updateClientBillingQuantity(agencyId);
      if (billingResult.updated) {
        console.log(`💰 Agency billing updated: ${billingResult.billableCount} billable clients`);
      } else {
        console.log(`💰 Agency billing not updated: ${billingResult.reason}`);
      }
    } catch (billingErr) {
      console.warn('⚠️ Per-client billing update failed (non-fatal):', billingErr.message);
    }

    // ============================================
    // STEP 5: CREATE USER RECORD
    // ============================================
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        agency_id: agencyId,
        client_id: newClient.id,
        email: email.toLowerCase(),
        first_name: firstName,
        last_name: lastName || null,
        role: 'client',
        password_hash: passwordHash
      })
      .select()
      .single();

    if (userError) {
      console.error('❌ User creation error:', userError);
      throw userError;
    }

    console.log(`✅ User created: ${newUser.id}${hasPassword ? ' (with password)' : ' (no password — email flow)'}`);

    // ============================================
    // STEP 6: GENERATE PASSWORD TOKEN
    // ============================================
    const passwordToken = await createPasswordToken(newUser.id, email.toLowerCase());

    // ============================================
    // STEP 7: SEND WELCOME EMAIL
    // ============================================
    console.log('📧 Sending welcome email...');
    await sendClientWelcomeEmail(newClient, agency, null, passwordToken);

    // ============================================
    // STEP 8: SEND WELCOME SMS (guarded)
    // ============================================
    if (formattedOwnerPhone && formattedOwnerPhone !== 'undefined') {
      console.log('📱 Sending welcome SMS...');
      await sendWelcomeSMS(formattedOwnerPhone, businessName, phoneResult.number, agency);
    } else {
      console.warn('⚠️ Skipping welcome SMS — no valid owner phone');
    }

    // ============================================
    // STEP 9: NOTIFY PLATFORM OWNER (guarded)
    // ============================================
    console.log('📱 Notifying platform owner...');
    await sendClientSignupNotificationSMS(newClient, agency);

    // ============================================
    // RETURN SUCCESS
    // ============================================
    console.log('🎉 Client onboarding complete:', businessName);

    res.status(200).json({
      success: true,
      message: 'Account created successfully!',
      token: passwordToken,
      hasPassword: !!hasPassword,
      client: {
        id: newClient.id,
        business_name: newClient.business_name,
        phone_number: phoneResult.number,
        email: newClient.email,
        country: clientCountry,
        location: `${businessCity}, ${businessState}`,
        trial_ends_at: newClient.trial_ends_at,
        subscription_status: 'trial',
        plan_type: planType,
        monthly_call_limit: callLimit,
        agency: agency.name
      }
    });

  } catch (error) {
    // If we still have tracked VAPI resources, clean them up
    if (createdAssistantId) {
      await cleanupVapiResources(createdAssistantId, createdQueryToolId, 'signup-catch');
    }

    console.error('❌ Signup error:', error);
    res.status(500).json({ 
      error: 'Signup failed', 
      message: error.message || 'Something went wrong. Please try again or contact support.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// ============================================================================
// AGENCY ADD CLIENT HANDLER
// ============================================================================
async function handleAgencyAddClient(req, res) {
  // Track created resources for rollback on failure
  let createdAssistantId = null;
  let createdQueryToolId = null;

  try {
    const { agencyId } = req.params;

    console.log('📝 Agency Add Client Request');

    const {
      firstName,
      lastName = '',
      email,
      phone,
      businessName,
      industry,
      businessCity,
      businessState,
      businessCountry,
      websiteUrl: rawWebsiteUrl,
      planType = 'starter',
      tempPassword
    } = req.body;

    const errors = [];
    if (!firstName || firstName.trim().length < 1) errors.push('First name is required');
    if (!email || !email.includes('@')) errors.push('Valid email is required');

    const phoneDigits = (phone || '').replace(/\D/g, '');
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      errors.push('Valid phone number is required (7-15 digits)');
    }

    if (!businessName || businessName.trim().length < 2) errors.push('Business name is required');
    if (!businessCity || businessCity.trim().length < 2) errors.push('City is required');
    if (!businessState || businessState.trim().length < 1) errors.push('State / region is required');
    if (!industry) errors.push('Industry is required');
    if (!tempPassword || tempPassword.length < 6) errors.push('Temporary password is required (min 6 characters)');

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', errors });
    }

    // Validate planType the same way handleClientSignup does. Default 'starter'
    // already comes from destructuring; this rejects any out-of-set string.
    const resolvedPlanType = VALID_CLIENT_PLANS.includes(planType) ? planType : 'starter';
    if (planType !== resolvedPlanType) {
      console.warn(`⚠️ Invalid planType "${planType}" from agency add-client — defaulting to starter`);
    }

    const agency = await getAgencyById(agencyId);
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }
    if (agency.status !== 'active' && agency.status !== 'trial') {
      return res.status(403).json({ error: 'Agency is not active' });
    }

    const clientCountry = (businessCountry || agency.country || 'US').toUpperCase();

    const limitCheck = await canAgencyAddClient(agencyId);
    if (!limitCheck.allowed) {
      const isBilling = limitCheck.reason === 'billing_required';
      console.log(`🚫 ${isBilling ? 'Billing required' : 'Client limit reached'} for agency ${agency.name}: ${limitCheck.reason}`);
      return res.status(403).json({
        error: isBilling ? 'billing_required' : 'Client limit reached',
        message: limitCheck.message || limitCheck.reason,
        limit: limitCheck.limit,
        current: limitCheck.current
      });
    }

    console.log(`✅ Limit check passed: ${limitCheck.current}/${limitCheck.limit === -1 ? 'unlimited' : limitCheck.limit}`);
    console.log(`🏢 Agency: ${agency.name} (${agency.country || 'US'}) → Adding: ${businessName} (${clientCountry}, ${resolvedPlanType})`);

    let websiteUrl = rawWebsiteUrl;
    if (websiteUrl && !websiteUrl.startsWith('http')) {
      websiteUrl = `https://${websiteUrl}`;
    }
    const ownerName = lastName ? `${firstName} ${lastName}`.trim() : firstName;
    const formattedOwnerPhone = formatPhoneE164(phone, clientCountry);

    const existingClient = await getClientByEmail(email.toLowerCase(), agencyId);
    if (existingClient) {
      return res.status(409).json({
        error: 'Duplicate client',
        message: 'A client with this email already exists.'
      });
    }

    const salt = await bcrypt.genSalt(10);
    const tempPasswordHash = await bcrypt.hash(tempPassword, salt);

    // === STEP 1: Knowledge Base ===
    let knowledgeBaseData = null;
    if (websiteUrl && websiteUrl.trim().length > 0) {
      console.log('🌐 Creating knowledge base from website...');
      try {
        knowledgeBaseData = await createKnowledgeBaseFromWebsite(websiteUrl, businessName);
        if (knowledgeBaseData) {
          console.log(`✅ Knowledge base ready: ${knowledgeBaseData.knowledgeBaseId}`);
        }
      } catch (kbError) {
        console.error('⚠️ Knowledge base error (non-blocking):', kbError.message);
      }
    }

    // === STEP 2: Create VAPI Assistant ===
    console.log(`🤖 Creating VAPI assistant for: ${industry}`);
    const assistant = await createIndustryAssistant(
      businessName,
      industry,
      knowledgeBaseData,
      formattedOwnerPhone,
      null,
      agencyId
    );
    createdAssistantId = assistant.id;
    console.log(`✅ Assistant created: ${assistant.id}`);

    // Extract query tool ID for dynamic config builder
    const queryToolId = await extractQueryToolId(assistant.id);
    createdQueryToolId = queryToolId;
    if (queryToolId) console.log(`🔧 Query tool ID extracted: ${queryToolId}`);

    const templateKB = assistant._templateKnowledgeBase || null;
    if (templateKB) {
      console.log(`📚 Agency template KB will be inherited by new client`);
    }

    // === STEP 3: Provision Phone (unified) ===
    // This can fail — if it does, roll back VAPI resources from steps 1-2
    let phoneResult;
    try {
      phoneResult = await provisionPhoneForClient(agency, {
        businessCity,
        businessState,
        businessName,
        phone
      }, assistant.id);
    } catch (phoneError) {
      // Phone provisioning failed — clean up orphaned VAPI resources
      await cleanupVapiResources(createdAssistantId, createdQueryToolId, businessName);
      createdAssistantId = null;
      createdQueryToolId = null;

      console.error('❌ Phone provisioning failed:', phoneError.message);
      return res.status(503).json({
        error: 'Provisioning failed',
        message: getFriendlyProvisioningError(phoneError),
      });
    }

    console.log(`✅ Phone provisioned (${phoneResult.provisioningMethod}): ${phoneResult.number}`);

    // Enable two-way SMS on the provisioned number (non-blocking)
    try { await enableSMSForNumber(phoneResult.number); } catch (e) { console.warn('⚠️ SMS enable failed:', e.message); }

    // === STEP 4: Create Client Record ===
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const callLimitKey = `limit_${resolvedPlanType}`;
    const callLimit = agency[callLimitKey] ?? agency.limit_starter ?? 50;

    const { data: newClient, error: clientError } = await supabase
      .from('clients')
      .insert({
        agency_id: agencyId,
        business_name: businessName,
        business_city: businessCity,
        business_state: businessState,
        country: clientCountry,
        phone_number: phoneResult.number,
        phone_area_code: phoneResult.number.length >= 5 ? phoneResult.number.substring(2, 5) : null,
        owner_name: ownerName,
        owner_phone: formattedOwnerPhone,
        email: email.toLowerCase(),
        industry: industry,
        vapi_assistant_id: assistant.id,
        vapi_phone_number: phoneResult.number,
        vapi_phone_id: phoneResult.vapiPhoneId || null,
        vapi_query_tool_id: queryToolId,
        knowledge_base_id: knowledgeBaseData?.knowledgeBaseId || null,
        knowledge_base_data: templateKB,
        subscription_status: 'trial',
        trial_ends_at: trialEndsAt,
        status: 'active',
        plan_type: resolvedPlanType,
        monthly_call_limit: callLimit,
        calls_this_month: 0,
        business_website: websiteUrl || null,
        provisioning_method: phoneResult.provisioningMethod || 'platform',
        // Inherit nav defaults from agency
        nav_bg: agency.default_client_nav_bg || null,
        nav_text: agency.default_client_nav_text || null,
      })
      .select()
      .single();

    if (clientError) {
      console.error('❌ Database error:', clientError);
      throw clientError;
    }

    // Past this point, client record exists — no more rollback needed
    createdAssistantId = null;
    createdQueryToolId = null;

    console.log(`🎉 Client created: ${newClient.business_name} (${clientCountry}, ${phoneResult.provisioningMethod})`);

    // ── Update per-client billing for the agency (non-blocking) ─────
    try {
      const billingResult = await updateClientBillingQuantity(agencyId);
      if (billingResult.updated) {
        console.log(`💰 Agency billing updated: ${billingResult.billableCount} billable clients`);
      } else {
        console.log(`💰 Agency billing not updated: ${billingResult.reason}`);
      }
    } catch (billingErr) {
      console.warn('⚠️ Per-client billing update failed (non-fatal):', billingErr.message);
    }

    // === STEP 5: Create User Record WITH password ===
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        agency_id: agencyId,
        client_id: newClient.id,
        email: email.toLowerCase(),
        first_name: firstName,
        last_name: lastName || null,
        role: 'client',
        password_hash: tempPasswordHash
      })
      .select()
      .single();

    if (userError) {
      console.error('❌ User creation error:', userError);
      throw userError;
    }

    // === STEP 6: Welcome SMS (guarded) ===
    if (formattedOwnerPhone && formattedOwnerPhone !== 'undefined') {
      console.log('📱 Sending welcome SMS...');
      await sendWelcomeSMS(formattedOwnerPhone, businessName, phoneResult.number, agency);
    } else {
      console.warn('⚠️ Skipping welcome SMS — no valid owner phone');
    }

    // === STEP 7: Notify Agency Owner ===
    console.log('📱 Notifying agency owner...');
    await sendClientSignupNotificationSMS(newClient, agency);

    // === Done ===
    console.log('🎉 Agency add client complete:', businessName);

    res.status(200).json({
      success: true,
      message: 'Client added successfully!',
      client: {
        id: newClient.id,
        business_name: newClient.business_name,
        phone_number: phoneResult.number,
        email: newClient.email,
        owner_name: ownerName,
        industry: newClient.industry,
        country: clientCountry,
        location: `${businessCity}, ${businessState}`,
        trial_ends_at: newClient.trial_ends_at,
        subscription_status: 'trial',
        plan_type: newClient.plan_type,
        provisioning_method: phoneResult.provisioningMethod
      }
    });

  } catch (error) {
    // If we still have tracked VAPI resources, clean them up
    if (createdAssistantId) {
      await cleanupVapiResources(createdAssistantId, createdQueryToolId, 'agency-add-catch');
    }

    console.error('❌ Agency add client error:', error);
    res.status(500).json({
      error: 'Failed to add client',
      message: error.message || 'Something went wrong during client provisioning. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// ============================================================================
// PROVISION CLIENT (Called after Stripe checkout)
// ============================================================================
async function provisionClient(clientId) {
  let createdAssistantId = null;
  let createdQueryToolId = null;

  try {
    console.log('🚀 Provisioning client:', clientId);
    
    const { data: client, error } = await supabase
      .from('clients')
      .select('*, agencies!clients_agency_id_fkey(*)')
      .eq('id', clientId)
      .single();
    
    if (error || !client) {
      throw new Error('Client not found');
    }
    
    if (client.vapi_assistant_id && client.vapi_phone_number) {
      console.log('✅ Client already provisioned');
      return client;
    }
    
    const agency = client.agencies;
    
    let knowledgeBaseData = null;
    if (client.business_website) {
      knowledgeBaseData = await createKnowledgeBaseFromWebsite(
        client.business_website, 
        client.business_name
      );
    }
    
    const assistant = await createIndustryAssistant(
      client.business_name,
      client.industry,
      knowledgeBaseData,
      client.owner_phone,
      client.id,
      client.agency_id
    );

    createdAssistantId = assistant.id;

    // Extract query tool ID for dynamic config builder
    const queryToolId = await extractQueryToolId(assistant.id);
    createdQueryToolId = queryToolId;
    if (queryToolId) console.log(`🔧 Query tool ID extracted: ${queryToolId}`);

    const templateKB = assistant._templateKnowledgeBase || null;
    
    let phoneResult;
    try {
      phoneResult = await provisionPhoneForClient(agency, {
        businessCity: client.business_city,
        businessState: client.business_state,
        businessName: client.business_name,
        phone: client.owner_phone
      }, assistant.id);
    } catch (phoneError) {
      await cleanupVapiResources(createdAssistantId, createdQueryToolId, client.business_name);
      throw phoneError;
    }

    console.log(`✅ Phone provisioned (${phoneResult.provisioningMethod}): ${phoneResult.number}`);

    // Enable two-way SMS on the provisioned number (non-blocking)
    try { await enableSMSForNumber(phoneResult.number); } catch (e) { console.warn('⚠️ SMS enable failed:', e.message); }
    
    const { data: updatedClient } = await supabase
      .from('clients')
      .update({
        vapi_assistant_id: assistant.id,
        vapi_phone_number: phoneResult.number,
        vapi_phone_id: phoneResult.vapiPhoneId || null,
        vapi_query_tool_id: queryToolId,
        knowledge_base_id: knowledgeBaseData?.knowledgeBaseId || null,
        knowledge_base_data: templateKB || client.knowledge_base_data || null,
        status: 'active',
        provisioning_method: phoneResult.provisioningMethod || 'platform',
        // Inherit nav defaults if not already set
        nav_bg: client.nav_bg || agency.default_client_nav_bg || null,
        nav_text: client.nav_text || agency.default_client_nav_text || null,
      })
      .eq('id', clientId)
      .select()
      .single();

    // No more rollback needed
    createdAssistantId = null;
    createdQueryToolId = null;

    // ── Update per-client billing (non-blocking) ────────────────────
    try {
      await updateClientBillingQuantity(client.agency_id);
    } catch (billingErr) {
      console.warn('⚠️ Per-client billing update failed (non-fatal):', billingErr.message);
    }
    
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('client_id', clientId)
      .single();
    
    if (!existingUser) {
      const { data: newUser } = await supabase
        .from('users')
        .insert({
          agency_id: client.agency_id,
          client_id: clientId,
          email: client.email,
          first_name: client.owner_name?.split(' ')[0] || 'User',
          last_name: client.owner_name?.split(' ').slice(1).join(' ') || null,
          role: 'client'
        })
        .select()
        .single();
      
      const token = await createPasswordToken(newUser.id, client.email);
      await sendClientWelcomeEmail(updatedClient, agency, null, token);

      // Guard SMS against undefined phone
      if (client.owner_phone && client.owner_phone !== 'undefined') {
        await sendWelcomeSMS(client.owner_phone, client.business_name, phoneResult.number, agency);
      }
    }
    
    console.log(`✅ Client provisioned (${phoneResult.provisioningMethod}): ${client.business_name}`);
    return updatedClient;
    
  } catch (error) {
    if (createdAssistantId) {
      await cleanupVapiResources(createdAssistantId, createdQueryToolId, 'provision-catch');
    }
    console.error('❌ Provisioning error:', error);
    throw error;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  handleClientSignup,
  provisionClient,
  handleAgencyAddClient,
  signupRateLimiter,
};