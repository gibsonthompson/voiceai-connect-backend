// ============================================================================
// CLIENT SIGNUP & PROVISIONING - Multi-Tenant
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
  if (!body.phone || body.phone.replace(/\D/g, '').length < 10) {
    errors.push('Valid phone number is required');
  }
  if (!body.businessName || body.businessName.trim().length < 2) {
    errors.push('Business name is required');
  }
  if (!body.businessCity || body.businessCity.trim().length < 2) {
    errors.push('City is required');
  }
  if (!body.businessState || body.businessState.trim().length < 2) {
    errors.push('State is required');
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
        assistantId: assistantId,
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
// MAIN CLIENT SIGNUP HANDLER
// ============================================================================
async function handleClientSignup(req, res) {
  try {
    console.log('📝 Client Signup Request Received');

    // Validate request
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
      websiteUrl: rawWebsiteUrl,
      agencyId
    } = req.body;

    // Get agency
    const agency = await getAgencyById(agencyId);
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (agency.status !== 'active' && agency.status !== 'trial') {
      return res.status(403).json({ error: 'Agency is not active' });
    }

    // ============================================
    // CHECK CLIENT LIMIT BEFORE CREATING
    // ============================================
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

    console.log(`🏢 Agency: ${agency.name}`);

    // Normalize website URL
    let websiteUrl = rawWebsiteUrl;
    if (websiteUrl && !websiteUrl.startsWith('http')) {
      websiteUrl = `https://${websiteUrl}`;
    }

    const ownerName = lastName ? `${firstName} ${lastName}`.trim() : firstName;
    const formattedOwnerPhone = formatPhoneE164(phone);

    console.log(`📋 Creating client: ${businessName} for agency: ${agency.name}`);

    // Check for duplicate within this agency
    const existingClient = await getClientByEmail(email.toLowerCase(), agencyId);
    if (existingClient) {
      return res.status(409).json({ 
        error: 'Account already exists',
        message: 'An account with this email already exists for this agency.'
      });
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
      formattedOwnerPhone
    );
    
    console.log(`✅ Assistant created: ${assistant.id}`);

    // ============================================
    // STEP 3: PROVISION PHONE NUMBER
    // ============================================
    const phoneData = await provisionLocalPhone(
      businessCity,
      businessState,
      assistant.id,
      businessName
    );
    
    console.log(`✅ Phone provisioned: ${phoneData.number}`);

    // Configure webhook
    await configurePhoneWebhook(phoneData.id, assistant.id);

    // ============================================
    // STEP 4: CREATE CLIENT RECORD
    // ============================================
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    
    // Get call limit from agency settings
    const callLimit = agency.limit_starter || 50;
    
    const { data: newClient, error: clientError } = await supabase
      .from('clients')
      .insert({
        agency_id: agencyId,  // MULTI-TENANT: Link to agency
        business_name: businessName,
        business_city: businessCity,
        business_state: businessState,
        phone_number: phoneData.number,
        phone_area_code: phoneData.number.substring(2, 5),
        owner_name: ownerName,
        owner_phone: formattedOwnerPhone,
        email: email.toLowerCase(),
        industry: industry,
        vapi_assistant_id: assistant.id,
        vapi_phone_number: phoneData.number,
        knowledge_base_id: knowledgeBaseData?.knowledgeBaseId || null,
        subscription_status: 'trial',
        trial_ends_at: trialEndsAt,
        status: 'active',
        plan_type: 'starter',
        monthly_call_limit: callLimit,
        calls_this_month: 0,
        business_website: websiteUrl || null
      })
      .select()
      .single();

    if (clientError) {
      console.error('❌ Database error:', clientError);
      throw clientError;
    }

    console.log(`🎉 Client created: ${newClient.business_name}`);

    // ============================================
    // STEP 5: CREATE USER RECORD (no password - will be set later)
    // ============================================
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        client_id: newClient.id,
        email: email.toLowerCase(),
        first_name: firstName,
        last_name: lastName || null,
        role: 'client',
        password_hash: null  // No password at signup
      })
      .select()
      .single();

    if (userError) {
      console.error('❌ User creation error:', userError);
      throw userError;
    }

    console.log(`✅ User created: ${newUser.id}`);

    // ============================================
    // STEP 6: GENERATE PASSWORD TOKEN
    // ============================================
    const passwordToken = await createPasswordToken(newUser.id, email.toLowerCase());

    // ============================================
    // STEP 7: SEND WELCOME EMAIL (branded with agency)
    // ============================================
    console.log('📧 Sending welcome email...');
    await sendClientWelcomeEmail(newClient, agency, null, passwordToken);

    // ============================================
    // STEP 8: SEND WELCOME SMS (simple confirmation, no link)
    // ============================================
    console.log('📱 Sending welcome SMS...');
    await sendWelcomeSMS(formattedOwnerPhone, businessName, phoneData.number, agency);

    // ============================================
    // STEP 9: NOTIFY PLATFORM OWNER OF NEW CLIENT
    // ============================================
    console.log('📱 Notifying platform owner...');
    await sendClientSignupNotificationSMS(newClient, agency);

    // ============================================
    // RETURN SUCCESS WITH TOKEN
    // ============================================
    console.log('🎉 Client onboarding complete:', businessName);

    res.status(200).json({
      success: true,
      message: 'Account created successfully!',
      token: passwordToken,  // Return token for immediate redirect to set-password
      client: {
        id: newClient.id,
        business_name: newClient.business_name,
        phone_number: phoneData.number,
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
      message: 'Something went wrong. Please try again or contact support.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// ============================================================================
// AGENCY ADD CLIENT HANDLER
// Called when agency owner adds a client from the agency dashboard
// Same provisioning flow as self-signup, but initiated by the agency
// ============================================================================
async function handleAgencyAddClient(req, res) {
  try {
    const { agencyId } = req.params;

    console.log('📝 Agency Add Client Request');

    // --- Validate ---
    const {
      firstName,
      lastName = '',
      email,
      phone,
      businessName,
      industry,
      businessCity,
      businessState,
      websiteUrl: rawWebsiteUrl,
      planType = 'starter'
    } = req.body;

    const errors = [];
    if (!firstName || firstName.trim().length < 1) errors.push('First name is required');
    if (!email || !email.includes('@')) errors.push('Valid email is required');
    if (!phone || phone.replace(/\D/g, '').length < 10) errors.push('Valid phone number is required');
    if (!businessName || businessName.trim().length < 2) errors.push('Business name is required');
    if (!businessCity || businessCity.trim().length < 2) errors.push('City is required');
    if (!businessState || businessState.trim().length < 2) errors.push('State is required');
    if (!industry) errors.push('Industry is required');

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', errors });
    }

    // --- Get & verify agency ---
    const agency = await getAgencyById(agencyId);
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }
    if (agency.status !== 'active' && agency.status !== 'trial') {
      return res.status(403).json({ error: 'Agency is not active' });
    }

    // --- Check client limit ---
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
    console.log(`🏢 Agency: ${agency.name} → Adding: ${businessName}`);

    // --- Normalize inputs ---
    let websiteUrl = rawWebsiteUrl;
    if (websiteUrl && !websiteUrl.startsWith('http')) {
      websiteUrl = `https://${websiteUrl}`;
    }
    const ownerName = lastName ? `${firstName} ${lastName}`.trim() : firstName;
    const formattedOwnerPhone = formatPhoneE164(phone);

    // --- Check duplicate ---
    const existingClient = await getClientByEmail(email.toLowerCase(), agencyId);
    if (existingClient) {
      return res.status(409).json({
        error: 'Duplicate client',
        message: 'A client with this email already exists.'
      });
    }

    // === STEP 1: Knowledge Base (if website provided) ===
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
      formattedOwnerPhone
    );
    console.log(`✅ Assistant created: ${assistant.id}`);

    // === STEP 3: Provision Phone Number ===
    const phoneData = await provisionLocalPhone(
      businessCity,
      businessState,
      assistant.id,
      businessName
    );
    console.log(`✅ Phone provisioned: ${phoneData.number}`);

    await configurePhoneWebhook(phoneData.id, assistant.id);

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
        phone_number: phoneData.number,
        phone_area_code: phoneData.number.substring(2, 5),
        owner_name: ownerName,
        owner_phone: formattedOwnerPhone,
        email: email.toLowerCase(),
        industry: industry,
        vapi_assistant_id: assistant.id,
        vapi_phone_number: phoneData.number,
        knowledge_base_id: knowledgeBaseData?.knowledgeBaseId || null,
        subscription_status: 'trial',
        trial_ends_at: trialEndsAt,
        status: 'active',
        plan_type: planType,
        monthly_call_limit: callLimit,
        calls_this_month: 0,
        business_website: websiteUrl || null
      })
      .select()
      .single();

    if (clientError) {
      console.error('❌ Database error:', clientError);
      throw clientError;
    }
    console.log(`🎉 Client created: ${newClient.business_name}`);

    // === STEP 5: Create User Record ===
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        client_id: newClient.id,
        email: email.toLowerCase(),
        first_name: firstName,
        last_name: lastName || null,
        role: 'client',
        password_hash: null
      })
      .select()
      .single();

    if (userError) {
      console.error('❌ User creation error:', userError);
      throw userError;
    }

    // === STEP 6: Password Token ===
    const passwordToken = await createPasswordToken(newUser.id, email.toLowerCase());

    // === STEP 7: Welcome Email ===
    console.log('📧 Sending welcome email...');
    await sendClientWelcomeEmail(newClient, agency, null, passwordToken);

    // === STEP 8: Welcome SMS ===
    console.log('📱 Sending welcome SMS...');
    await sendWelcomeSMS(formattedOwnerPhone, businessName, phoneData.number, agency);

    // === STEP 9: Notify Agency Owner ===
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
        phone_number: phoneData.number,
        email: newClient.email,
        owner_name: ownerName,
        industry: newClient.industry,
        location: `${businessCity}, ${businessState}`,
        trial_ends_at: newClient.trial_ends_at,
        subscription_status: 'trial',
        plan_type: newClient.plan_type
      }
    });

  } catch (error) {
    console.error('❌ Agency add client error:', error);
    res.status(500).json({
      error: 'Failed to add client',
      message: 'Something went wrong during client provisioning. Please try again.',
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
    
    // If already provisioned, skip
    if (client.vapi_assistant_id && client.vapi_phone_number) {
      console.log('✅ Client already provisioned');
      return client;
    }
    
    const agency = client.agencies;
    
    // Create knowledge base if website exists
    let knowledgeBaseData = null;
    if (client.business_website) {
      knowledgeBaseData = await createKnowledgeBaseFromWebsite(
        client.business_website, 
        client.business_name
      );
    }
    
    // Create VAPI assistant
    const assistant = await createIndustryAssistant(
      client.business_name,
      client.industry,
      knowledgeBaseData,
      client.owner_phone
    );
    
    // Provision phone
    const phoneData = await provisionLocalPhone(
      client.business_city,
      client.business_state,
      assistant.id,
      client.business_name
    );
    
    // Configure webhook
    await configurePhoneWebhook(phoneData.id, assistant.id);
    
    // Update client
    const { data: updatedClient } = await supabase
      .from('clients')
      .update({
        vapi_assistant_id: assistant.id,
        vapi_phone_number: phoneData.number,
        knowledge_base_id: knowledgeBaseData?.knowledgeBaseId || null,
        status: 'active'
      })
      .eq('id', clientId)
      .select()
      .single();
    
    // Create user if not exists
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
      
      // Send welcome notifications with password token
      const token = await createPasswordToken(newUser.id, client.email);
      await sendClientWelcomeEmail(updatedClient, agency, null, token);
      await sendWelcomeSMS(client.owner_phone, client.business_name, phoneData.number, agency);
    }
    
    console.log('✅ Client provisioned:', client.business_name);
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