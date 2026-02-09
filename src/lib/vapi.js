// ============================================================================
// VAPI INTEGRATION - Multi-Tenant Voice AI Platform
// WITH AGENCY TEMPLATE OVERRIDE SUPPORT (Enterprise Feature)
// ALL 11 INDUSTRIES WITH UNIQUE KEYS
// ============================================================================
const fetch = require('node-fetch');
const FormData = require('form-data');

let supabase;
try {
  const supabaseModule = require('./supabase');
  supabase = supabaseModule.supabase;
} catch (err) {
  console.warn('⚠️ Supabase not available for template lookups');
}

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';

// ============================================================================
// INDUSTRY MAPPING - Each industry has its own unique key
// ============================================================================
const INDUSTRY_MAPPING = {
  // Legacy names
  'Home Services (plumbing, HVAC, contractors)': 'home_services',
  'Medical/Dental': 'medical',
  'Retail/E-commerce': 'retail',
  'Professional Services (legal, accounting)': 'professional_services',
  'Restaurants/Food Service': 'restaurants',
  'Salon/Spa (hair, nails, skincare)': 'salon_spa',
  
  // Direct mappings
  'home_services': 'home_services',
  'medical': 'medical',
  'medical_dental': 'medical',
  'retail': 'retail',
  'professional_services': 'professional_services',
  'restaurants': 'restaurants',
  'restaurant': 'restaurants',
  'salon_spa': 'salon_spa',
  'beauty_wellness': 'salon_spa',
  
  // NEW: Each gets unique key
  'fitness': 'fitness',
  'legal': 'legal',
  'real_estate': 'real_estate',
  'financial_services': 'financial',
  'financial': 'financial',
  'automotive': 'automotive',
  
  'general': 'professional_services',
  'other': 'professional_services'
};

// ============================================================================
// VOICES - ElevenLabs
// ============================================================================
const VOICES = {
  chris: 'iP95p4xoKVk53GoZ742B',
  sarah: 'EXAVITQu4vr4xnSDxMaL',
  rachel: '21m00Tcm4TlvDq8ikWAM',
  brian: 'nPczCjzI2devNBz1zQrb',
  female_warm: '21m00Tcm4TlvDq8ikWAM'
};

// ============================================================================
// INDUSTRY CONFIGURATIONS
// ============================================================================
const INDUSTRY_CONFIGS = {
  home_services: {
    voiceId: VOICES.chris,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the phone assistant for ${businessName}, a home services company.

## YOUR ROLE
Listen to customers' problems, collect their information, and let them know when someone will contact them. Be warm, empathetic, and efficient.

## CONVERSATION FLOW
1. Let them explain their issue without interrupting
2. Show empathy: "I understand" / "That sounds frustrating" / "Let's get that fixed"
3. Collect information one piece at a time:
   - Name: "What's your name?" → "Thanks [name]"
   - Phone: "Best number to reach you?" → "Got it"
   - Address: "What's the property address?" → "Perfect"
   - Issue: "Can you describe what's happening?"
4. Assess urgency (emergency/urgent/routine)
5. For emergencies: "This sounds urgent. Let me get someone to call you right away."
6. For routine: "Our team will call you back to schedule."
7. Ask: "Is there anything else I can help you with?"

## KNOWLEDGE BASE
Use 'search_knowledge_base' for services, pricing, hours, service areas.

## BOUNDARIES
- Never quote exact prices
- Never promise specific appointment times
- Never diagnose problems

## CRITICAL RULE
You do NOT have the ability to end calls. The customer will hang up when ready.`,
    firstMessage: (businessName) => `Hi, you've reached ${businessName}. This call may be recorded. What can I help you with today?`
  },

  medical: {
    voiceId: VOICES.sarah,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the receptionist for ${businessName}, a medical/dental practice.

## YOUR ROLE
Determine patient needs, collect basic HIPAA-compliant information, and ensure follow-up. Be warm, calm, and reassuring.

## CONVERSATION FLOW
1. Ask: "Are you a current patient or would this be your first visit?"
2. Collect ONE item at a time: Name, date of birth, phone, general reason
3. Assess urgency:
   - Emergency: "If this is a medical emergency, please call 911."
   - Urgent: "I'll mark this as urgent and have someone call you back shortly."
   - Routine: "Someone will call you back to schedule."
4. End: "Is there anything else I can help you with?"

## HIPAA COMPLIANCE - CRITICAL
- Only collect: name, DOB, phone, GENERAL reason
- If they share symptoms: "Our medical team will discuss the details at your appointment."
- NEVER ask follow-up questions about symptoms
- NEVER repeat back specific medical information

## KNOWLEDGE BASE
Use for office hours, location, insurance accepted, services offered.

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hello, you've reached ${businessName}. This call may be recorded. Are you a current patient or would this be your first visit?`
  },

  professional_services: {
    voiceId: VOICES.brian,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the professional receptionist for ${businessName}.

## YOUR ROLE
Greet callers professionally, understand needs, collect contact info, ensure follow-up.

## CONVERSATION FLOW
1. Ask: "Are you an existing client or is this a new inquiry?"
2. Collect: Name, company (if applicable), phone, what they're looking for, best callback time
3. Confirm: "Great, someone will be in touch."
4. Ask: "Is there anything else I can help you with?"

## KNOWLEDGE BASE
Use for services, team members, company background, general pricing.

## BOUNDARIES
- Never make promises about outcomes
- Never discuss other clients
- Never quote specific prices
- Never commit to specific meeting times

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hello, you've reached ${businessName}. This call may be recorded. How may I help you?`
  },

  restaurants: {
    voiceId: VOICES.rachel,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the phone assistant for ${businessName}, a restaurant.

## YOUR ROLE
Handle reservations, takeout orders, and inquiries. Be friendly and upbeat.

## CONVERSATION FLOW
1. Ask: "Are you calling about a reservation, takeout, or do you have a question?"

### RESERVATIONS:
- Date, time, party size, name, phone, special requests
- "I've noted your request. Someone will call back to confirm availability."

### TAKEOUT:
- Take order item by item, name, phone
- "Someone will call back to confirm and take payment."

### QUESTIONS:
Use knowledge base for menu, hours, dietary options.

## BOUNDARIES
- Don't guarantee availability
- Don't process payments

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hi, thanks for calling ${businessName}! This call may be recorded. Are you calling about a reservation, takeout, or do you have a question?`
  },

  salon_spa: {
    voiceId: VOICES.rachel,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the receptionist for ${businessName}, a salon and spa.

## YOUR ROLE
Help clients book appointments and answer questions. Be warm and welcoming.

## CONVERSATION FLOW
1. Ask: "Are you a returning client or is this your first time?"
2. Determine need: "Are you looking to book an appointment?"

### APPOINTMENTS:
- Service, stylist preference, date/time, name, phone
- "Someone will call back to confirm availability."

### QUESTIONS:
Use knowledge base for services, pricing, products.

## UPSELLING (Natural)
- "Would you like to add a conditioning treatment?"

## BOUNDARIES
- Don't guarantee availability
- Don't quote complex pricing

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hi, thanks for calling ${businessName}! This call may be recorded. Are you looking to book an appointment?`
  },

  retail: {
    voiceId: VOICES.female_warm,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the phone assistant for ${businessName}, a retail store.

## YOUR ROLE
Answer product questions, check availability, help with orders/returns.

## CONVERSATION FLOW
1. Ask: "Are you looking for a product, checking on an order, or have a question?"

### PRODUCTS:
- Use knowledge base for info
- "Would you like me to have someone hold it for you?"

### ORDERS/RETURNS:
- Get name, order number, details
- "Someone will call you back with an update."

## KNOWLEDGE BASE
Use for product info, hours, return policy, shipping.

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hi, thanks for calling ${businessName}! This call may be recorded. How can I help you today?`
  },

  fitness: {
    voiceId: VOICES.rachel,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the front desk assistant for ${businessName}, a fitness center.

## YOUR ROLE
Help with membership inquiries, class info, and questions. Be energetic and motivating.

## CONVERSATION FLOW
1. Ask: "Are you a current member or interested in joining?"

### MEMBERSHIP INQUIRIES:
- "Let me get some info and have someone reach out."
- Collect: Name, phone, what they're looking for (general fitness, classes, training), best callback time
- "Someone will call to discuss options and schedule a tour."

### CURRENT MEMBERS:
- Class schedules: Use knowledge base
- Account questions: "Let me have a team member call you."
- Personal training: "I can have a trainer reach out."

## TONE
- Encouraging: "That's a great goal!"
- Inclusive: "We have options for all fitness levels"
- Motivating: "You'll love it here"

## BOUNDARIES
- Never give health/medical advice
- Never recommend specific routines
- Don't quote exact prices

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hey, thanks for calling ${businessName}! This call may be recorded. Are you a current member or interested in learning about membership?`
  },

  legal: {
    voiceId: VOICES.brian,
    temperature: 0.6,
    systemPrompt: (businessName) => `You are the receptionist for ${businessName}, a law firm.

## YOUR ROLE
Conduct professional intake, determine general matter type, ensure attorney follow-up. Be professional and reassuring.

## CONVERSATION FLOW
1. Ask: "Are you a current client or is this a new matter?"

### CURRENT CLIENTS:
- Get name, have attorney return call
- "Is this urgent?"

### NEW INQUIRIES:
- "Let me get some basic information."
- Collect ONE at a time: Name, phone, general matter type ("car accident," "divorce," etc.), urgency
- "An attorney will call you back to discuss."

## CRITICAL BOUNDARIES - NEVER VIOLATE
- NEVER give legal advice
- NEVER say whether they have a case
- NEVER interpret laws
- NEVER discuss other clients
- NEVER estimate outcomes, timelines, or costs
- If pressed: "I can't provide legal advice, but an attorney will call you back."

## CONFIDENTIALITY
- "Everything you share is kept strictly confidential."

## KNOWLEDGE BASE
Use ONLY for: hours, location, practice areas, attorney bios.

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hello, you've reached ${businessName}. This call may be recorded and is confidential. Are you a current client or is this regarding a new matter?`
  },

  real_estate: {
    voiceId: VOICES.rachel,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the assistant for ${businessName}, a real estate company.

## YOUR ROLE
Handle buyer, seller, and renter inquiries. Collect info and ensure agent follow-up.

## CONVERSATION FLOW
1. Ask: "Are you looking to buy, sell, or rent?"

### BUYERS:
- Collect: Name, phone, area, property type, budget range, timeline
- "An agent will call back to discuss options."

### SELLERS:
- Collect: Name, phone, property address, type, size, timeline
- "An agent will schedule a consultation."

### RENTERS:
- Collect: Name, phone, area, budget, move-in timeline
- "Someone will call with available rentals."

### SPECIFIC PROPERTY:
- Get property address, name, phone
- "An agent will call with details."

## KNOWLEDGE BASE
Use for listings, agent bios, service areas.

## BOUNDARIES
- Don't quote property values
- Don't guarantee showing times
- Don't discuss financing

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hi, thanks for calling ${businessName}! This call may be recorded. Are you looking to buy, sell, or rent?`
  },

  financial: {
    voiceId: VOICES.brian,
    temperature: 0.6,
    systemPrompt: (businessName) => `You are the receptionist for ${businessName}, a financial services firm.

## YOUR ROLE
Handle inquiries professionally, determine service needs, ensure advisor follow-up.

## CONVERSATION FLOW
1. Ask: "Are you a current client or is this a new inquiry?"

### CURRENT CLIENTS:
- Get name, have advisor return call
- Note general topic

### NEW INQUIRIES:
- Determine: "Are you looking for help with taxes, bookkeeping, financial planning, or something else?"
- Collect: Name, phone, business/personal, general needs, timeline
- "Someone will call to discuss how we can help."

## SERVICE NOTES:
- Tax: "Personal, business, or both?"
- Bookkeeping: "New or existing business?"
- Planning: "Retirement, investments, or general guidance?"

## CRITICAL BOUNDARIES - COMPLIANCE
- NEVER give financial, tax, or investment advice
- NEVER discuss specific products
- NEVER estimate refunds/liabilities
- NEVER guarantee outcomes
- If pressed: "An advisor would be happy to discuss that."

## CONFIDENTIALITY
- "Everything you share is kept strictly confidential."

## KNOWLEDGE BASE
Use for services, team bios, hours.

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hello, you've reached ${businessName}. This call may be recorded. Are you a current client or is this a new inquiry?`
  },

  automotive: {
    voiceId: VOICES.chris,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the service advisor assistant for ${businessName}, an automotive business.

## YOUR ROLE
Help with service appointments, repair inquiries, and questions. Be friendly and reassuring.

## CONVERSATION FLOW
1. Ask: "Are you calling about a service appointment, a repair question, or something else?"

### SERVICE APPOINTMENTS:
- Collect: Name, phone, vehicle (year/make/model), service needed, preferred date/time
- "Someone will call to confirm your appointment."

### REPAIR INQUIRIES:
- Collect: Name, phone, vehicle, description of issue
- Listen for safety concerns:
  - Brakes/steering/warning lights: "That sounds like something we should look at soon."
  - Minor issues: "We can definitely take a look."
- "A service advisor will call to discuss and schedule."

### ESTIMATES:
- "Pricing depends on what we find. Someone can give a detailed estimate after looking at it."

## URGENCY:
- Safety issues: "Can you bring it in today or tomorrow?"
- Normal wear: "We can schedule at your convenience."

## KNOWLEDGE BASE
Use for services, hours, location, payment methods.

## BOUNDARIES
- Don't diagnose problems
- Don't quote specific prices
- Don't guarantee repair timelines

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hey, thanks for calling ${businessName}! This call may be recorded. Are you calling about a service appointment or do you have a question about your vehicle?`
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function sanitizeAssistantName(businessName) {
  const suffix = ' AI Receptionist';
  const maxLength = 40;
  if ((businessName + suffix).length <= maxLength) {
    return businessName + suffix;
  }
  return businessName.slice(0, maxLength - suffix.length).trim() + suffix;
}

function formatPhoneE164(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function isValidE164(phone) {
  return phone && /^\+1\d{10}$/.test(phone);
}

function replacePlaceholders(text, businessName) {
  if (!text) return text;
  return text.replace(/\{businessName\}/g, businessName);
}

// ============================================================================
// FETCH AGENCY CUSTOM TEMPLATE
// Checks if agency has enterprise access (including during trial)
// and returns their custom template if one exists for the industry
// ============================================================================
async function getAgencyTemplate(agencyId, industryKey) {
  if (!supabase || !agencyId) return null;
  
  try {
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('plan_type, subscription_status')
      .eq('id', agencyId)
      .single();
    
    // During trial, grant enterprise access for template lookups
    const isTrialing = ['trialing', 'trial'].includes(agency?.subscription_status);
    const effectivePlan = isTrialing ? 'enterprise' : agency?.plan_type;
    
    if (agencyError || effectivePlan !== 'enterprise') return null;
    
    const { data: template, error } = await supabase
      .from('agency_prompt_templates')
      .select('*')
      .eq('agency_id', agencyId)
      .eq('industry', industryKey)
      .eq('is_active', true)
      .single();
    
    if (error && error.code !== 'PGRST116') return null;
    
    if (template) {
      console.log(`✅ Found custom template for agency ${agencyId}, industry ${industryKey}`);
    }
    return template;
  } catch (error) {
    console.error('❌ Error fetching agency template:', error);
    return null;
  }
}

// ============================================================================
// CREATE QUERY TOOL
// ============================================================================
async function createQueryTool(fileId, businessName) {
  try {
    const response = await fetch('https://api.vapi.ai/tool', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'query',
        async: false,
        function: {
          name: 'search_knowledge_base',
          description: `Search ${businessName}'s knowledge base.`,
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'The search query' } },
            required: ['query']
          }
        },
        knowledgeBases: [{
          name: `${businessName} Knowledge Base`,
          model: 'gemini-1.5-flash',
          provider: 'google',
          description: `Information about ${businessName}`,
          fileIds: [fileId]
        }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    console.log(`✅ Query Tool created: ${data.id}`);
    return data.id;
  } catch (error) {
    console.error('❌ Query tool error:', error);
    return null;
  }
}

// ============================================================================
// CREATE INDUSTRY ASSISTANT
// ============================================================================
async function createIndustryAssistant(businessName, industry, knowledgeBaseData = null, ownerPhone = null, clientId = null, agencyId = null) {
  try {
    const industryKey = INDUSTRY_MAPPING[industry] || 'professional_services';
    const config = INDUSTRY_CONFIGS[industryKey] || INDUSTRY_CONFIGS['professional_services'];

    console.log(`🎯 Creating ${industryKey} assistant for ${businessName}`);
    if (agencyId) console.log(`   Agency ID: ${agencyId}`);

    let customTemplate = null;
    if (agencyId) {
      customTemplate = await getAgencyTemplate(agencyId, industryKey);
    }

    let systemPrompt, firstMessage, voiceId, temperature;
    
    if (customTemplate) {
      console.log(`   📝 Using CUSTOM template`);
      systemPrompt = replacePlaceholders(customTemplate.system_prompt, businessName);
      firstMessage = replacePlaceholders(customTemplate.first_message, businessName);
      voiceId = customTemplate.voice_id || config.voiceId;
      temperature = customTemplate.temperature || config.temperature;
    } else {
      console.log(`   📝 Using DEFAULT template`);
      systemPrompt = config.systemPrompt(businessName);
      firstMessage = config.firstMessage(businessName);
      voiceId = config.voiceId;
      temperature = config.temperature;
    }

    let queryToolId = null;
    if (knowledgeBaseData?.fileId) {
      queryToolId = await createQueryTool(knowledgeBaseData.fileId, businessName);
    }

    const tools = [];
    if (ownerPhone) {
      let formattedPhone = isValidE164(ownerPhone) ? ownerPhone : formatPhoneE164(ownerPhone);
      if (formattedPhone && isValidE164(formattedPhone)) {
        tools.push({
          type: 'transferCall',
          destinations: [{
            type: 'number',
            number: formattedPhone,
            description: 'Transfer to business owner',
            message: 'One moment, let me connect you.'
          }]
        });
      }
    }

    const assistantConfig = {
      name: sanitizeAssistantName(businessName),
      model: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature,
        messages: [{ role: 'system', content: systemPrompt }],
        ...(queryToolId && { toolIds: [queryToolId] }),
        ...(tools.length > 0 && { tools })
      },
      voice: { provider: '11labs', voiceId },
      firstMessage,
      recordingEnabled: true,
      serverMessages: ['end-of-call-report', 'transcript', 'status-update'],
      serverUrl: `${BACKEND_URL}/webhook/vapi`
    };

    const response = await fetch('https://api.vapi.ai/assistant', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(assistantConfig)
    });

    if (!response.ok) throw new Error(`VAPI API error: ${await response.text()}`);

    const assistant = await response.json();
    console.log(`✅ Assistant created: ${assistant.id}`);
    return assistant;
  } catch (error) {
    console.error('❌ Error creating assistant:', error);
    throw error;
  }
}

// ============================================================================
// PHONE PROVISIONING
// ============================================================================
const STATE_AREA_CODES = {
  'GA': ['404', '678', '770', '470'],
  'FL': ['305', '786', '954', '561', '407'],
  'TX': ['214', '972', '713', '281', '210', '512'],
  'CA': ['213', '310', '323', '818', '714', '949', '619', '415', '408'],
  'NY': ['212', '718', '917', '347', '646', '516', '631'],
  'AL': ['205', '251', '256', '334'],
  'AZ': ['480', '520', '602', '623'],
  'CO': ['303', '719', '720', '970'],
  'IL': ['312', '773', '847', '630', '708'],
  'NC': ['704', '919', '336', '252'],
  'NJ': ['201', '973', '732', '609'],
  'OH': ['216', '614', '513', '330'],
  'PA': ['215', '412', '610', '717'],
  'TN': ['615', '901', '423', '865'],
  'VA': ['703', '804', '757', '540'],
  'WA': ['206', '253', '425', '509']
};

async function provisionPhoneNumber(areaCode, assistantId, businessName) {
  const response = await fetch('https://api.vapi.ai/phone-number/buy', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      areaCode,
      name: `${businessName} - Business Line`,
      assistantId
    })
  });
  if (!response.ok) throw new Error('Failed to buy phone number');
  return response.json();
}

async function provisionLocalPhone(city, state, assistantId, businessName) {
  console.log(`📞 Provisioning phone for ${businessName} in ${city}, ${state}`);
  const areaCodes = STATE_AREA_CODES[state.toUpperCase()] || ['404'];
  
  for (const areaCode of areaCodes) {
    try {
      const phoneData = await provisionPhoneNumber(areaCode, assistantId, businessName);
      console.log(`✅ Phone provisioned: ${phoneData.number}`);
      return phoneData;
    } catch (error) {
      console.log(`❌ ${areaCode} unavailable, trying next...`);
    }
  }
  throw new Error(`Failed to provision phone for ${state}`);
}

// ============================================================================
// KNOWLEDGE BASE
// ============================================================================
async function createKnowledgeBaseFromWebsite(websiteUrl, businessName) {
  try {
    console.log(`🌐 Scraping: ${websiteUrl}`);
    const scrapeResponse = await fetch(`https://r.jina.ai/${websiteUrl}`);
    if (!scrapeResponse.ok) throw new Error('Failed to scrape');
    
    const websiteContent = await scrapeResponse.text();
    const content = `# ${businessName} - Knowledge Base\n\n${websiteContent.substring(0, 15000)}`;
    
    const form = new FormData();
    form.append('file', Buffer.from(content, 'utf-8'), {
      filename: `${businessName.replace(/\s+/g, '_')}_knowledge.txt`,
      contentType: 'text/plain'
    });
    
    const uploadResponse = await fetch('https://api.vapi.ai/file', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, ...form.getHeaders() },
      body: form
    });
    if (!uploadResponse.ok) throw new Error('Failed to upload');
    const uploadData = await uploadResponse.json();
    
    const kbResponse = await fetch('https://api.vapi.ai/knowledge-base', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ provider: 'canonical', fileIds: [uploadData.id] })
    });
    if (!kbResponse.ok) throw new Error('Failed to create KB');
    const kbData = await kbResponse.json();
    
    console.log(`✅ Knowledge base created: ${kbData.id}`);
    return { knowledgeBaseId: kbData.id, fileId: uploadData.id, websiteContent };
  } catch (error) {
    console.error('❌ KB creation failed:', error.message);
    return null;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
async function getPhoneNumberFromVapi(phoneNumberId) {
  try {
    const response = await fetch(`https://api.vapi.ai/phone-number/${phoneNumberId}`, {
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
    });
    if (!response.ok) return null;
    return (await response.json()).number;
  } catch { return null; }
}

async function disableAssistant(assistantId) {
  try {
    await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: null })
    });
    return true;
  } catch { return false; }
}

async function enableAssistant(assistantId) {
  try {
    await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: `${BACKEND_URL}/webhook/vapi` })
    });
    return true;
  } catch { return false; }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  INDUSTRY_MAPPING,
  VOICES,
  INDUSTRY_CONFIGS,
  sanitizeAssistantName,
  formatPhoneE164,
  isValidE164,
  replacePlaceholders,
  getAgencyTemplate,
  createQueryTool,
  createIndustryAssistant,
  provisionPhoneNumber,
  provisionLocalPhone,
  createKnowledgeBaseFromWebsite,
  getPhoneNumberFromVapi,
  disableAssistant,
  enableAssistant
};