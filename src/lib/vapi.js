// ============================================================================
// VAPI INTEGRATION - Multi-Tenant Voice AI Platform
// WITH AGENCY TEMPLATE OVERRIDE SUPPORT (Enterprise Feature)
// WITH DEMO ASSISTANT PROVISIONING (Agency-level)
// WITH INDUSTRY KNOWLEDGE BASES (Pre-loaded for every AI receptionist)
// ALL 11 INDUSTRIES WITH UNIQUE KEYS
// UPDATED: Retired Rachel voice, replaced with Matilda (2026-03-14)
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

const { INDUSTRY_KNOWLEDGE_BASES } = require('./industry-knowledge-bases');

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
// UPDATED: rachel retired by ElevenLabs, replaced with matilda
// ============================================================================
const VOICES = {
  chris: 'iP95p4xoKVk53GoZ742B',
  sarah: 'EXAVITQu4vr4xnSDxMaL',
  matilda: 'XrExE9yKIg1WjnnlVkGX',
  brian: 'nPczCjzI2devNBz1zQrb',
  female_warm: 'XrExE9yKIg1WjnnlVkGX'
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
When asked about services, pricing, hours, or service areas, use the 'search_knowledge_base' tool to find accurate information before answering.

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
When asked about office hours, location, insurance accepted, or services offered, use the 'search_knowledge_base' tool to find accurate information before answering.

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
When asked about services, team members, company background, or general pricing, use the 'search_knowledge_base' tool to find accurate information before answering.

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
    voiceId: VOICES.matilda,
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
When asked about menu items, hours, or dietary options, use the 'search_knowledge_base' tool to find accurate information before answering.

## BOUNDARIES
- Don't guarantee availability
- Don't process payments

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hi, thanks for calling ${businessName}! This call may be recorded. Are you calling about a reservation, takeout, or do you have a question?`
  },

  salon_spa: {
    voiceId: VOICES.matilda,
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
When asked about services, pricing, or products, use the 'search_knowledge_base' tool to find accurate information before answering.

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
- Use the 'search_knowledge_base' tool for info
- "Would you like me to have someone hold it for you?"

### ORDERS/RETURNS:
- Get name, order number, details
- "Someone will call you back with an update."

## KNOWLEDGE BASE
When asked about products, hours, return policy, or shipping, use the 'search_knowledge_base' tool to find accurate information before answering.

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hi, thanks for calling ${businessName}! This call may be recorded. How can I help you today?`
  },

  fitness: {
    voiceId: VOICES.matilda,
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
- Class schedules: Use the 'search_knowledge_base' tool
- Account questions: "Let me have a team member call you."
- Personal training: "I can have a trainer reach out."

## TONE
- Encouraging: "That's a great goal!"
- Inclusive: "We have options for all fitness levels"
- Motivating: "You'll love it here"

## KNOWLEDGE BASE
When asked about classes, schedules, membership options, or facilities, use the 'search_knowledge_base' tool to find accurate information before answering.

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
When asked about hours, location, practice areas, or attorney bios, use the 'search_knowledge_base' tool to find accurate information before answering. ONLY use for factual business information — never for legal advice.

## CRITICAL RULE
You do NOT have the ability to end calls.`,
    firstMessage: (businessName) => `Hello, you've reached ${businessName}. This call may be recorded and is confidential. Are you a current client or is this regarding a new matter?`
  },

  real_estate: {
    voiceId: VOICES.matilda,
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
When asked about listings, agents, or service areas, use the 'search_knowledge_base' tool to find accurate information before answering.

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
When asked about services, team members, or hours, use the 'search_knowledge_base' tool to find accurate information before answering.

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
When asked about services, hours, location, or payment methods, use the 'search_knowledge_base' tool to find accurate information before answering.

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
// CREATE INDUSTRY KNOWLEDGE BASE
// Generates an industry-specific KB doc, optionally merges with website
// content, uploads to VAPI as a file.
// The query tool (created separately) references this file via fileIds.
// No standalone KB object needed — the query tool handles KB internally.
// ============================================================================
async function createIndustryKnowledgeBase(businessName, industryKey, websiteKnowledgeBase = null) {
  try {
    // Get the industry-specific knowledge base document
    const kbGenerator = INDUSTRY_KNOWLEDGE_BASES[industryKey] || INDUSTRY_KNOWLEDGE_BASES['professional_services'];
    const industryDoc = kbGenerator(businessName);

    // Combine: industry doc + website content (if available)
    let fullContent = industryDoc;

    if (websiteKnowledgeBase?.websiteContent) {
      fullContent += `\n\n# ${businessName} — Website Information\n\n${websiteKnowledgeBase.websiteContent}`;
    }

    console.log(`📚 Uploading knowledge base for ${businessName} (${industryKey}): ${fullContent.length} chars`);

    // Upload as a file to VAPI
    const form = new FormData();
    form.append('file', Buffer.from(fullContent, 'utf-8'), {
      filename: `${businessName.replace(/\s+/g, '_')}_knowledge.txt`,
      contentType: 'text/plain',
    });

    const uploadResponse = await fetch('https://api.vapi.ai/file', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, ...form.getHeaders() },
      body: form,
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      console.error('❌ KB file upload failed:', errText);
      return null;
    }

    const uploadData = await uploadResponse.json();
    console.log(`✅ KB file uploaded: ${uploadData.id}`);

    return {
      fileId: uploadData.id,
      content: fullContent,
      websiteContent: websiteKnowledgeBase?.websiteContent || null,
    };
  } catch (error) {
    console.error('❌ Industry knowledge base creation failed:', error.message);
    return null;
  }
}

// ============================================================================
// CREATE INDUSTRY ASSISTANT (Client-level)
// UPDATED: Always creates a knowledge base (industry doc + optional website)
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

    let systemPrompt, firstMessage, voiceId, temperature, modelId;
    
    if (customTemplate) {
      console.log(`   📝 Using CUSTOM template`);
      systemPrompt = replacePlaceholders(customTemplate.system_prompt, businessName);
      firstMessage = replacePlaceholders(customTemplate.first_message, businessName);
      voiceId = customTemplate.voice_id || config.voiceId;
      temperature = customTemplate.temperature || config.temperature;
      modelId = customTemplate.model || 'gpt-4o-mini';

      // Append agency's KB data to system prompt if template has it
      if (customTemplate.knowledge_base_data) {
        const kb = customTemplate.knowledge_base_data;
        let kbSection = '\n\n## BUSINESS INFORMATION';
        if (kb.businessHours && kb.businessHours.trim()) kbSection += `\n\n### Business Hours\n${kb.businessHours}`;
        if (kb.services && kb.services.trim()) kbSection += `\n\n### Services & Pricing\n${kb.services}`;
        if (kb.faqs && kb.faqs.trim()) kbSection += `\n\n### Frequently Asked Questions\n${kb.faqs}`;
        if (kb.additionalInfo && kb.additionalInfo.trim()) kbSection += `\n\n### Additional Information\n${kb.additionalInfo}`;
        if (kbSection !== '\n\n## BUSINESS INFORMATION') {
          systemPrompt += kbSection;
          console.log(`   📚 Appended agency KB data to system prompt (${kbSection.length} chars)`);
        }
      }
    } else {
      console.log(`   📝 Using DEFAULT template`);
      systemPrompt = config.systemPrompt(businessName);
      firstMessage = config.firstMessage(businessName);
      voiceId = config.voiceId;
      temperature = config.temperature;
      modelId = 'gpt-4o-mini';
    }

    // ══════════════════════════════════════════════════════════════════════
    // KNOWLEDGE BASE — Always create one (industry doc + optional website)
    // Previously: KB only created if knowledgeBaseData was provided (website)
    // Now: KB always created with industry doc, website content merged if available
    // ══════════════════════════════════════════════════════════════════════
    let finalKnowledgeBase = knowledgeBaseData;

    if (!finalKnowledgeBase) {
      // No website was scraped — create KB from industry doc alone
      console.log(`📚 Creating industry-only knowledge base (no website provided)`);
      finalKnowledgeBase = await createIndustryKnowledgeBase(businessName, industryKey);
    } else if (finalKnowledgeBase.fileId) {
      // Website was scraped and uploaded — create combined KB (industry doc + website)
      console.log(`📚 Creating combined knowledge base (industry doc + website)`);
      finalKnowledgeBase = await createIndustryKnowledgeBase(businessName, industryKey, knowledgeBaseData);
    }

    let queryToolId = null;
    if (finalKnowledgeBase?.fileId) {
      queryToolId = await createQueryTool(finalKnowledgeBase.fileId, businessName);
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
        model: modelId,
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

    // Attach template KB data so caller can save to client record
    if (customTemplate?.knowledge_base_data) {
      assistant._templateKnowledgeBase = customTemplate.knowledge_base_data;
    }

    return assistant;
  } catch (error) {
    console.error('❌ Error creating assistant:', error);
    throw error;
  }
}

// ============================================================================
// DEMO ASSISTANT SYSTEM PROMPT
// Extracted so createDemoAssistant and updateDemoAssistantName share it
// ============================================================================
function getDemoSystemPrompt(agencyName) {
  return `You are a demo AI receptionist for ${agencyName}. Your job is to showcase how an AI receptionist works for businesses.

## YOUR ROLE
You're demonstrating what it's like to have an AI answer your business phone. Be professional, warm, and impressive. Show the caller how natural and capable AI phone answering can be.

## CONVERSATION FLOW
1. Greet warmly and explain this is a live demo
2. Ask what type of business they run
3. Based on their answer, roleplay a realistic scenario:
   - If they say plumber/contractor: Act as their receptionist taking a service call
   - If they say restaurant: Act as their host taking a reservation
   - If they say doctor/dentist: Act as their front desk scheduling an appointment
   - If they say lawyer: Act as their intake coordinator
   - For any other business: Act as their professional receptionist
4. Walk through collecting caller info naturally (name, phone, reason for call)
5. Show how you'd summarize the call
6. Mention key features: "After this call, you'd get an instant text summary with all the details"
7. Ask if they have any questions about the service

## TONE
- Professional but friendly
- Confident and capable
- Enthusiastic about the technology without being salesy
- Natural conversation — don't sound robotic

## KEY POINTS TO MENTION (naturally, not as a list)
- 24/7 availability
- Instant text summaries after every call
- Works for any industry
- Setup takes just minutes
- Callers often can't tell it's AI

## BOUNDARIES
- Don't make specific pricing promises
- Don't claim features that don't exist
- If asked about pricing, say "plans start at an affordable monthly rate — you'll see all the options when you sign up for a free trial"
- Be honest if directly asked whether you're AI

## CRITICAL RULE
You do NOT have the ability to end calls. The caller will hang up when ready.`;
}

function getDemoFirstMessage(agencyName) {
  return `Hi there! Thanks for calling ${agencyName}'s AI receptionist demo. I'm an AI assistant, and I'm here to show you exactly how I'd answer the phone for your business. What type of business do you run?`;
}

// ============================================================================
// CREATE DEMO ASSISTANT (Agency-level, industry-agnostic)
// Creates a showcase assistant that demonstrates AI receptionist capabilities
// without being tied to any specific client or industry.
// ============================================================================
async function createDemoAssistant(agencyName) {
  try {
    console.log(`🎤 Creating demo assistant for agency: ${agencyName}`);

    const assistantConfig = {
      name: `${agencyName.slice(0, 25)} Demo Assistant`,
      model: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature: 0.7,
        messages: [{ role: 'system', content: getDemoSystemPrompt(agencyName) }]
      },
      voice: {
        provider: '11labs',
        voiceId: VOICES.sarah // Warm, professional
      },
      firstMessage: getDemoFirstMessage(agencyName),
      recordingEnabled: true,
      serverMessages: ['end-of-call-report'],
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
    console.log(`✅ Demo assistant created: ${assistant.id}`);
    return assistant;
  } catch (error) {
    console.error('❌ Error creating demo assistant:', error);
    throw error;
  }
}

// ============================================================================
// PROVISION DEMO PHONE FOR AGENCY
// Provisions a phone number + demo assistant and stores on agency record.
// Called during agency signup (non-blocking).
// ============================================================================
async function provisionAgencyDemo(agencyId, agencyName, areaCode = '404') {
  try {
    console.log(`📞 Provisioning demo phone for agency: ${agencyName} (area code: ${areaCode})`);

    // 1. Create the demo assistant
    const assistant = await createDemoAssistant(agencyName);

    // 2. Provision a phone number with requested area code
    const phoneData = await provisionPhoneNumber(areaCode, assistant.id, `${agencyName} Demo`);
    console.log(`✅ Demo phone provisioned: ${phoneData.number}`);

    // 3. Configure webhook on the phone
    try {
      const webhookResponse = await fetch(`https://api.vapi.ai/phone-number/${phoneData.id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          assistantId: assistant.id,
          serverUrl: `${BACKEND_URL}/webhook/vapi`
        })
      });
      if (webhookResponse.ok) {
        console.log('✅ Demo phone webhook configured');
      }
    } catch (whErr) {
      console.warn('⚠️ Demo phone webhook config failed (non-blocking):', whErr.message);
    }

    // 4. Store on agency record
    if (!supabase) {
      console.warn('⚠️ Supabase not available — cannot save demo phone to agency');
      return { phoneNumber: phoneData.number, assistantId: assistant.id, phoneId: phoneData.id };
    }

    const { error: updateError } = await supabase
      .from('agencies')
      .update({
        demo_phone_number: phoneData.number,
        demo_assistant_id: assistant.id,
        demo_vapi_phone_id: phoneData.id
      })
      .eq('id', agencyId);

    if (updateError) {
      console.error('❌ Failed to save demo phone to agency:', updateError);
      throw updateError;
    }

    console.log(`🎉 Demo provisioning complete for ${agencyName}: ${phoneData.number}`);
    return {
      phoneNumber: phoneData.number,
      assistantId: assistant.id,
      phoneId: phoneData.id
    };
  } catch (error) {
    console.error(`❌ Demo provisioning failed for ${agencyName}:`, error.message);
    // Non-fatal — agency can still function without demo
    return null;
  }
}

// ============================================================================
// UPDATE DEMO ASSISTANT NAME
// Called when agency name changes (onboarding step 1) to keep assistant
// greeting in sync with the agency name.
// ============================================================================
async function updateDemoAssistantName(assistantId, newAgencyName) {
  if (!assistantId) return false;

  try {
    const response = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `${newAgencyName.slice(0, 25)} Demo Assistant`,
        firstMessage: getDemoFirstMessage(newAgencyName),
        model: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          temperature: 0.7,
          messages: [{ role: 'system', content: getDemoSystemPrompt(newAgencyName) }]
        }
      })
    });

    if (response.ok) {
      console.log(`✅ Demo assistant updated for: ${newAgencyName}`);
      return true;
    }
    console.warn(`⚠️ Demo assistant update failed: ${response.status}`);
    return false;
  } catch (error) {
    console.error('❌ Error updating demo assistant:', error.message);
    return false;
  }
}

// ============================================================================
// PHONE PROVISIONING
// ============================================================================
const STATE_AREA_CODES = {
  'AL': ['205', '251', '256', '334', '938'],
  'AK': ['907'],
  'AZ': ['480', '520', '602', '623', '928'],
  'AR': ['479', '501', '870'],
  'CA': ['213', '310', '323', '408', '415', '510', '530', '559', '619', '626', '650', '661', '707', '714', '760', '805', '818', '831', '858', '909', '916', '925', '949', '951'],
  'CO': ['303', '719', '720', '970'],
  'CT': ['203', '475', '860'],
  'DE': ['302'],
  'DC': ['202'],
  'FL': ['239', '305', '321', '352', '386', '407', '561', '727', '754', '772', '786', '813', '850', '863', '904', '941', '954'],
  'GA': ['229', '404', '470', '478', '678', '706', '770', '912'],
  'HI': ['808'],
  'ID': ['208', '986'],
  'IL': ['217', '224', '309', '312', '331', '618', '630', '708', '773', '815', '847'],
  'IN': ['219', '260', '317', '463', '574', '765', '812'],
  'IA': ['319', '515', '563', '641', '712'],
  'KS': ['316', '620', '785', '913'],
  'KY': ['270', '364', '502', '606', '859'],
  'LA': ['225', '318', '337', '504', '985'],
  'ME': ['207'],
  'MD': ['240', '301', '410', '443', '667'],
  'MA': ['339', '351', '413', '508', '617', '774', '781', '857', '978'],
  'MI': ['231', '248', '269', '313', '517', '586', '616', '734', '810', '906', '947', '989'],
  'MN': ['218', '320', '507', '612', '651', '763', '952'],
  'MS': ['228', '601', '662', '769'],
  'MO': ['314', '417', '573', '636', '660', '816'],
  'MT': ['406'],
  'NE': ['308', '402', '531'],
  'NV': ['702', '725', '775'],
  'NH': ['603'],
  'NJ': ['201', '551', '609', '732', '848', '856', '862', '908', '973'],
  'NM': ['505', '575'],
  'NY': ['212', '315', '347', '516', '518', '585', '607', '631', '646', '716', '718', '845', '914', '917', '929'],
  'NC': ['252', '336', '704', '743', '828', '910', '919', '980', '984'],
  'ND': ['701'],
  'OH': ['216', '234', '330', '380', '419', '440', '513', '567', '614', '740', '937'],
  'OK': ['405', '539', '580', '918'],
  'OR': ['458', '503', '541', '971'],
  'PA': ['215', '267', '272', '412', '484', '570', '610', '717', '724', '814', '878'],
  'RI': ['401'],
  'SC': ['803', '843', '854', '864'],
  'SD': ['605'],
  'TN': ['423', '615', '629', '731', '865', '901', '931'],
  'TX': ['210', '214', '254', '281', '325', '346', '361', '409', '430', '432', '469', '512', '682', '713', '726', '737', '806', '817', '830', '832', '903', '915', '936', '940', '956', '972', '979'],
  'UT': ['385', '435', '801'],
  'VT': ['802'],
  'VA': ['276', '434', '540', '571', '703', '757', '804'],
  'WA': ['206', '253', '360', '425', '509', '564'],
  'WV': ['304', '681'],
  'WI': ['262', '414', '534', '608', '715', '920'],
  'WY': ['307'],
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

async function provisionLocalPhone(city, state, assistantId, businessName, ownerPhone = null) {
  console.log(`📞 Provisioning phone for ${businessName} in ${city}, ${state}`);
  
  const areaCodesToTry = [];
  
  const stateCodes = STATE_AREA_CODES[state.toUpperCase()] || [];
  for (const code of stateCodes) {
    areaCodesToTry.push(code);
  }
  console.log(`   📍 Trying ${stateCodes.length} area codes for ${state}`);
  
  if (ownerPhone) {
    const digits = ownerPhone.replace(/\D/g, '');
    let clientAreaCode = null;
    if (digits.length === 10) clientAreaCode = digits.substring(0, 3);
    else if (digits.length === 11 && digits.startsWith('1')) clientAreaCode = digits.substring(1, 4);
    
    if (clientAreaCode && /^\d{3}$/.test(clientAreaCode) && !areaCodesToTry.includes(clientAreaCode)) {
      areaCodesToTry.push(clientAreaCode);
      console.log(`   📱 Owner area code ${clientAreaCode} added as fallback`);
    }
  }
  
  if (!areaCodesToTry.includes('404')) {
    areaCodesToTry.push('404');
  }
  
  for (const areaCode of areaCodesToTry) {
    try {
      const phoneData = await provisionPhoneNumber(areaCode, assistantId, businessName);
      console.log(`✅ Phone provisioned: ${phoneData.number} (area code: ${areaCode})`);
      return phoneData;
    } catch (error) {
      console.log(`   ❌ ${areaCode} unavailable, trying next...`);
    }
  }
  throw new Error(`Failed to provision phone for ${state} — tried ${areaCodesToTry.length} area codes`);
}

// ============================================================================
// KNOWLEDGE BASE (Website scraping — called before createIndustryAssistant)
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
  createIndustryKnowledgeBase,
  createIndustryAssistant,
  provisionPhoneNumber,
  provisionLocalPhone,
  createKnowledgeBaseFromWebsite,
  getPhoneNumberFromVapi,
  disableAssistant,
  enableAssistant,
  // Demo provisioning
  getDemoSystemPrompt,
  getDemoFirstMessage,
  createDemoAssistant,
  provisionAgencyDemo,
  updateDemoAssistantName
};