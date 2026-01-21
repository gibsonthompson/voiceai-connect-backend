// ============================================================================
// VAPI INTEGRATION - Multi-Tenant Voice AI Platform
// Adapted from CallBird's battle-tested patterns
// ============================================================================
const fetch = require('node-fetch');
const FormData = require('form-data');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';

// ============================================================================
// INDUSTRY MAPPING
// ============================================================================
const INDUSTRY_MAPPING = {
  'Home Services (plumbing, HVAC, contractors)': 'home_services',
  'Medical/Dental': 'medical',
  'Retail/E-commerce': 'retail',
  'Professional Services (legal, accounting)': 'professional_services',
  'Restaurants/Food Service': 'restaurants',
  'Salon/Spa (hair, nails, skincare)': 'salon_spa',
  // Direct mappings
  'home_services': 'home_services',
  'medical': 'medical',
  'retail': 'retail',
  'professional_services': 'professional_services',
  'restaurants': 'restaurants',
  'salon_spa': 'salon_spa'
};

// ============================================================================
// VOICES - ElevenLabs
// ============================================================================
const VOICES = {
  male_professional: '29vD33N1CtxCmqQRPOHJ',
  female_warm: '21m00Tcm4TlvDq8ikWAM',
  male_adam: 'pNInz6obpgDQGcFmaJgB',
  female_soft: 'EXAVITQu4vr4xnSDxMaL',
  chris: 'iP95p4xoKVk53GoZ742B',
  sarah: 'EXAVITQu4vr4xnSDxMaL',
  rachel: '21m00Tcm4TlvDq8ikWAM',
  brian: 'nPczCjzI2devNBz1zQrb'
};

const INDUSTRY_VOICES = {
  home_services: VOICES.chris,
  medical: VOICES.sarah,
  retail: VOICES.female_warm,
  professional_services: VOICES.brian,
  restaurants: VOICES.rachel,
  salon_spa: VOICES.rachel
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
   - Issue: "Can you describe what's happening?" → Listen and acknowledge
4. Assess urgency silently (emergency/urgent/routine)
5. Let them know next steps: "Our team will call you back [timeframe]"
6. Ask: "Is there anything else I can help you with?"

## KNOWLEDGE BASE USAGE
When customers ask about services, pricing, hours, or policies, use the 'search_knowledge_base' tool to find accurate information.

## CRITICAL RULE
You do NOT have the ability to end calls. The customer will hang up when they're ready.`,
    firstMessage: (businessName) => `Hi, you've reached ${businessName}. This call may be recorded for quality purposes. What can I help you with today?`
  },

  medical: {
    voiceId: VOICES.sarah,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the receptionist for ${businessName}, a medical/dental practice.

## YOUR ROLE
Determine patient needs, collect basic HIPAA-compliant information, and route appropriately.

## CONVERSATION FLOW
1. Ask: "Are you a current patient or would this be your first visit?"
2. Collect: Name, date of birth, phone, general reason
3. NEVER ask for specific medical details
4. Assess urgency (emergency → 911, urgent → work in, routine → schedule)

## HIPAA COMPLIANCE
- Only collect: name, DOB, phone, general reason
- If they share medical info: "Our doctor will discuss that at your appointment"

## CRITICAL RULE
You do NOT have the ability to end calls. The patient will hang up when ready.`,
    firstMessage: (businessName) => `Hello, you've reached ${businessName}. This call may be recorded. Are you a current patient or would this be your first visit?`
  },

  professional_services: {
    voiceId: VOICES.brian,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the professional receptionist for ${businessName}.

## YOUR ROLE
Greet callers professionally, understand their needs, collect contact information, and route appropriately.

## CONVERSATION FLOW
1. Determine if new or existing client
2. Collect: Name, phone, company (if business), general service needed
3. Assess urgency
4. Confirm details and next steps

## BOUNDARIES
- Never make promises about outcomes
- Never discuss other clients
- Never quote prices without checking

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hello, you've reached ${businessName}. This call may be recorded. How may I help you?`
  },

  restaurants: {
    voiceId: VOICES.rachel,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the phone assistant for ${businessName}, a restaurant.

## YOUR ROLE
Take reservations, handle takeout orders, answer menu questions.

## CONVERSATION FLOW
1. Ask: "Is this for a reservation or a takeout order?"
2. For reservations: date, time, party size, name, phone
3. For takeout: take order item by item, name, phone
4. Confirm all details

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hi! You've reached ${businessName}. This call may be recorded. How can I help you?`
  },

  salon_spa: {
    voiceId: VOICES.rachel,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the welcoming receptionist for ${businessName}, a salon and spa.

## YOUR ROLE
Book appointments, answer service questions, make clients feel pampered.

## CONVERSATION FLOW
1. Ask: "Are you a new client or have you been here before?"
2. Determine their need (booking, rescheduling, question)
3. For bookings: service, preferred date/time, name, phone
4. Suggest add-ons naturally
5. Confirm appointment details

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hi! You've reached ${businessName}. This call may be recorded. Are you calling to book an appointment?`
  },

  retail: {
    voiceId: VOICES.female_warm,
    temperature: 0.7,
    systemPrompt: (businessName) => `You are the phone assistant for ${businessName}, a retail store.

## YOUR ROLE
Answer questions, help find products, take orders. Be enthusiastic!

## CONVERSATION FLOW
1. Understand their need (product question, stock check, order, return)
2. Help based on their need using knowledge base
3. Get contact info when needed
4. Confirm orders/details

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hi! You've reached ${businessName}. This call may be recorded. How can I help you today?`
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
  
  const availableLength = maxLength - suffix.length;
  return businessName.slice(0, availableLength).trim() + suffix;
}

// ============================================================================
// CREATE QUERY TOOL FOR KNOWLEDGE BASE
// ============================================================================
async function createQueryTool(fileId, businessName) {
  try {
    console.log('🔧 Creating Query Tool for knowledge base...');
    
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
          description: `Search ${businessName}'s knowledge base for information about services, pricing, hours, and policies.`,
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query'
              }
            },
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

    if (!response.ok) {
      console.error('⚠️ Query tool creation failed');
      return null;
    }

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
async function createIndustryAssistant(businessName, industry, knowledgeBaseData = null, ownerPhone = null, clientId = null) {
  try {
    const industryKey = INDUSTRY_MAPPING[industry] || 'professional_services';
    const config = INDUSTRY_CONFIGS[industryKey];

    console.log(`🎯 Creating ${industryKey} assistant for ${businessName}`);

    // Create Query Tool if knowledge base exists
    let queryToolId = null;
    if (knowledgeBaseData?.fileId) {
      queryToolId = await createQueryTool(knowledgeBaseData.fileId, businessName);
    }

    // Build tools array
    const tools = [];

    // Add Transfer Tool if owner phone provided
    if (ownerPhone) {
      tools.push({
        type: 'transferCall',
        destinations: [{
          type: 'number',
          number: ownerPhone,
          description: 'Transfer to business owner for urgent matters',
          message: 'One moment please, let me connect you with the owner.'
        }]
      });
    }

    const assistantConfig = {
      name: sanitizeAssistantName(businessName),
      model: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature: config.temperature,
        messages: [{ 
          role: 'system', 
          content: config.systemPrompt(businessName)
        }],
        ...(queryToolId && { toolIds: [queryToolId] }),
        ...(tools.length > 0 && { tools })
      },
      voice: {
        provider: '11labs',
        voiceId: config.voiceId
      },
      firstMessage: config.firstMessage(businessName),
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

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`VAPI API error: ${errorText}`);
    }

    const assistant = await response.json();
    console.log(`✅ Assistant created: ${assistant.id}`);
    return assistant;
  } catch (error) {
    console.error('❌ Error creating assistant:', error);
    throw error;
  }
}

// ============================================================================
// PROVISION PHONE NUMBER
// ============================================================================
async function provisionPhoneNumber(areaCode, assistantId, businessName) {
  try {
    console.log(`📞 Buying phone number with area code ${areaCode}...`);
    
    const response = await fetch('https://api.vapi.ai/phone-number/buy', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        areaCode: areaCode,
        name: `${businessName} - Business Line`,
        assistantId: assistantId
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to buy phone number');
    }

    const data = await response.json();
    console.log(`✅ Phone provisioned: ${data.number}`);
    return data;
  } catch (error) {
    console.error(`❌ Phone provisioning failed for ${areaCode}:`, error.message);
    throw error;
  }
}

// State area codes for fallback
const STATE_AREA_CODES = {
  'GA': ['404', '678', '770', '470', '706', '762', '912', '229'],
  'FL': ['305', '786', '954', '754', '561', '407', '321', '904', '352', '386', '239', '941', '727', '813', '850'],
  'TX': ['214', '972', '469', '817', '682', '713', '281', '832', '346', '210', '512', '737', '254', '806', '903'],
  'CA': ['213', '310', '323', '424', '818', '626', '714', '949', '562', '657', '909', '951', '619', '858', '760', '415', '408', '510', '925', '650', '707'],
  'NY': ['212', '718', '917', '347', '646', '929', '516', '631', '914', '845', '518', '607', '315', '585', '716'],
  // Add more states as needed
};

async function provisionLocalPhone(city, state, assistantId, businessName) {
  console.log(`\n📞 Provisioning phone for ${businessName} in ${city}, ${state}`);
  
  const stateUpper = state.toUpperCase();
  const areaCodes = STATE_AREA_CODES[stateUpper] || ['404']; // Default to Atlanta
  
  for (const areaCode of areaCodes) {
    try {
      const phoneData = await provisionPhoneNumber(areaCode, assistantId, businessName);
      return phoneData;
    } catch (error) {
      console.log(`❌ ${areaCode} unavailable, trying next...`);
    }
  }
  
  throw new Error(`Failed to provision phone after trying all ${state} area codes`);
}

// ============================================================================
// KNOWLEDGE BASE FROM WEBSITE
// ============================================================================
async function createKnowledgeBaseFromWebsite(websiteUrl, businessName) {
  try {
    console.log(`🌐 Scraping website: ${websiteUrl}`);
    
    // Use Jina for scraping
    const scrapeResponse = await fetch(`https://r.jina.ai/${websiteUrl}`);
    if (!scrapeResponse.ok) {
      throw new Error('Failed to scrape website');
    }
    
    const websiteContent = await scrapeResponse.text();
    console.log(`✅ Website scraped, length: ${websiteContent.length}`);
    
    // Format content
    const content = `# ${businessName} - Knowledge Base\n\n## Website Content\n${websiteContent.substring(0, 15000)}`;
    
    // Upload to VAPI
    const form = new FormData();
    form.append('file', Buffer.from(content, 'utf-8'), {
      filename: `${businessName.replace(/\s+/g, '_')}_knowledge.txt`,
      contentType: 'text/plain'
    });
    
    const uploadResponse = await fetch('https://api.vapi.ai/file', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });
    
    if (!uploadResponse.ok) {
      throw new Error('Failed to upload to VAPI');
    }
    
    const uploadData = await uploadResponse.json();
    console.log(`✅ File uploaded: ${uploadData.id}`);
    
    // Create knowledge base
    const kbResponse = await fetch('https://api.vapi.ai/knowledge-base', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider: 'canonical',
        fileIds: [uploadData.id]
      })
    });
    
    if (!kbResponse.ok) {
      throw new Error('Failed to create knowledge base');
    }
    
    const kbData = await kbResponse.json();
    console.log(`✅ Knowledge base created: ${kbData.id}`);
    
    return {
      knowledgeBaseId: kbData.id,
      fileId: uploadData.id,
      websiteContent: websiteContent
    };
  } catch (error) {
    console.error('❌ Knowledge base creation failed:', error.message);
    return null;
  }
}

// ============================================================================
// GET PHONE NUMBER FROM VAPI
// ============================================================================
async function getPhoneNumberFromVapi(phoneNumberId) {
  try {
    const response = await fetch(`https://api.vapi.ai/phone-number/${phoneNumberId}`, {
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`
      }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.number;
  } catch (error) {
    console.error('❌ Error fetching phone number:', error);
    return null;
  }
}

// ============================================================================
// DISABLE/ENABLE ASSISTANT
// ============================================================================
async function disableAssistant(assistantId) {
  try {
    await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ serverUrl: null })
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function enableAssistant(assistantId) {
  try {
    await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ serverUrl: `${BACKEND_URL}/webhook/vapi` })
    });
    return true;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  INDUSTRY_MAPPING,
  VOICES,
  INDUSTRY_CONFIGS,
  sanitizeAssistantName,
  createQueryTool,
  createIndustryAssistant,
  provisionPhoneNumber,
  provisionLocalPhone,
  createKnowledgeBaseFromWebsite,
  getPhoneNumberFromVapi,
  disableAssistant,
  enableAssistant
};
