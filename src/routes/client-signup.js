// ============================================================================
// CLIENT SIGNUP & PROVISIONING - Multi-Tenant
// WITH BYOT (Bring Your Own Twilio) SUPPORT
// WITH INTERNATIONAL CLIENT SUPPORT
// WITH OPTIONAL PASSWORD AT SIGNUP (Phase 2A)
// WITH AGENCY TEMPLATE KB INHERITANCE
// UPDATED: Phase 2 — Phone numbers use serverUrl only (no assistantId)
// UPDATED: Extract and store vapi_query_tool_id for dynamic config builder
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

// ============================================================================
// COUNTRY → PROVISIONING METHOD
// ============================================================================
const PLATFORM_PROVISIONING_COUNTRIES = ['US']; // Only US for now

function canPlatformProvision(countryCode) {
  return PLATFORM_PROVISIONING_COUNTRIES.includes(countryCode?.toUpperCase() || 'US');
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
// ============================================================================
async function handleClientSignup(req, res) {
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
      console.log(`🚫 Client limit reached for agency ${agency.name}: ${limitCheck.reason}`);
      return res.status(403).json({ 
        error: 'Client limit reached',
        message: limitCheck.reason,
        limit: limitCheck.limit,
        current: limitCheck.current
      });
    }
    
    console.log(`✅ Client limit check passed: ${limitCheck.current}/${limitCheck.limit === -1 ? 'unlimited' : limitCheck.limit}`);
    console.log(`🏢 Agency: ${agency.name} (${agency.country || 'US'}) → Client country: ${clientCountry}`);

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
    
    console.log(`✅ Assistant created: ${assistant.id}`);

    // Extract query tool ID for dynamic config builder
    const queryToolId = await extractQueryToolId(assistant.id);
    if (queryToolId) console.log(`🔧 Query tool ID extracted: ${queryToolId}`);

    const templateKB = assistant._templateKnowledgeBase || null;
    if (templateKB) {
      console.log(`📚 Agency template KB will be inherited by new client`);
    }

    // ============================================
    // STEP 3: PROVISION PHONE NUMBER (unified)
    // ============================================
    const phoneResult = await provisionPhoneForClient(agency, {
      businessCity,
      businessState,
      businessName,
      phone
    }, assistant.id);
    
    console.log(`✅ Phone provisioned (${phoneResult.provisioningMethod}): ${phoneResult.number}`);

    // ============================================
    // STEP 4: CREATE CLIENT RECORD
    // ============================================
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const callLimit = agency.limit_starter || 50;
    
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
        plan_type: 'starter',
        monthly_call_limit: callLimit,
        calls_this_month: 0,
        business_website: websiteUrl || null,
        provisioning_method: phoneResult.provisioningMethod || 'platform'
      })
      .select()
      .single();

    if (clientError) {
      console.error('❌ Database error:', clientError);
      throw clientError;
    }

    console.log(`🎉 Client created: ${newClient.business_name} (${clientCountry}, ${phoneResult.provisioningMethod})`);

    // ============================================
    // STEP 5: CREATE USER RECORD
    // ============================================
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
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
    // STEP 8: SEND WELCOME SMS
    // ============================================
    console.log('📱 Sending welcome SMS...');
    await sendWelcomeSMS(formattedOwnerPhone, businessName, phoneResult.number, agency);

    // ============================================
    // STEP 9: NOTIFY PLATFORM OWNER
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
        agency: agency.name
      }
    });

  } catch (error) {
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
      console.log(`🚫 Client limit reached for agency ${agency.name}: ${limitCheck.reason}`);
      return res.status(403).json({
        error: 'Client limit reached',
        message: limitCheck.reason,
        limit: limitCheck.limit,
        current: limitCheck.current
      });
    }

    console.log(`✅ Limit check passed: ${limitCheck.current}/${limitCheck.limit === -1 ? 'unlimited' : limitCheck.limit}`);
    console.log(`🏢 Agency: ${agency.name} (${agency.country || 'US'}) → Adding: ${businessName} (${clientCountry})`);

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
    console.log(`✅ Assistant created: ${assistant.id}`);

    // Extract query tool ID for dynamic config builder
    const queryToolId = await extractQueryToolId(assistant.id);
    if (queryToolId) console.log(`🔧 Query tool ID extracted: ${queryToolId}`);

    const templateKB = assistant._templateKnowledgeBase || null;
    if (templateKB) {
      console.log(`📚 Agency template KB will be inherited by new client`);
    }

    // === STEP 3: Provision Phone (unified) ===
    const phoneResult = await provisionPhoneForClient(agency, {
      businessCity,
      businessState,
      businessName,
      phone
    }, assistant.id);

    console.log(`✅ Phone provisioned (${phoneResult.provisioningMethod}): ${phoneResult.number}`);

    // === STEP 4: Create Client Record ===
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const callLimitKey = `limit_${planType}`;
    const callLimit = agency[callLimitKey] || agency.limit_starter || 50;

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
        provisioning_method: phoneResult.provisioningMethod || 'platform'
      })
      .select()
      .single();

    if (clientError) {
      console.error('❌ Database error:', clientError);
      throw clientError;
    }
    console.log(`🎉 Client created: ${newClient.business_name} (${clientCountry}, ${phoneResult.provisioningMethod})`);

    // === STEP 5: Create User Record WITH password ===
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
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

    // === STEP 6: Welcome SMS ===
    console.log('📱 Sending welcome SMS...');
    await sendWelcomeSMS(formattedOwnerPhone, businessName, phoneResult.number, agency);

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
  try {
    console.log('🚀 Provisioning client:', clientId);
    
    const { data: client, error } = await supabase
      .from('clients')
      .select('*, agencies(*)')
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

    // Extract query tool ID for dynamic config builder
    const queryToolId = await extractQueryToolId(assistant.id);
    if (queryToolId) console.log(`🔧 Query tool ID extracted: ${queryToolId}`);

    const templateKB = assistant._templateKnowledgeBase || null;
    
    const phoneResult = await provisionPhoneForClient(agency, {
      businessCity: client.business_city,
      businessState: client.business_state,
      businessName: client.business_name,
      phone: client.owner_phone
    }, assistant.id);
    
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
        provisioning_method: phoneResult.provisioningMethod || 'platform'
      })
      .eq('id', clientId)
      .select()
      .single();
    
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('client_id', clientId)
      .single();
    
    if (!existingUser) {
      const { data: newUser } = await supabase
        .from('users')
        .insert({
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
      await sendWelcomeSMS(client.owner_phone, client.business_name, phoneResult.number, agency);
    }
    
    console.log(`✅ Client provisioned (${phoneResult.provisioningMethod}): ${client.business_name}`);
    return updatedClient;
    
  } catch (error) {
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
  handleAgencyAddClient
};