// ============================================================================
// DEMO ASSISTANT CONFIG
// Config format MATCHES buildDynamicAssistantConfig exactly (8 fields only):
//   name, model, voice, firstMessage, recordingEnabled, serverMessages, serverUrl, hooks
// No extra fields — maxDuration, transcriber, startSpeakingPlan etc. are NOT
// included because the working client config doesn't use them and VAPI may
// reject them in transient assistant-request responses.
//
// UPDATED: 2026-04-12 — Stripped to match working client config format
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
const DEMO_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';

const INDUSTRY_DEMO_NUMBERS = {
  '+15055945806': { industry: 'dental', agencyId: '00000000-0000-0000-0000-000000000001' },
};

const INDUSTRY_DEMO_VOICES = {
  home_services: 'iP95p4xoKVk53GoZ742B', medical: 'EXAVITQu4vr4xnSDxMaL',
  dental: 'EXAVITQu4vr4xnSDxMaL', professional_services: 'nPczCjzI2devNBz1zQrb',
  restaurants: 'XrExE9yKIg1WjnnlVkGX', salon_spa: 'XrExE9yKIg1WjnnlVkGX',
  retail: 'XrExE9yKIg1WjnnlVkGX', fitness: 'XrExE9yKIg1WjnnlVkGX',
  legal: 'nPczCjzI2devNBz1zQrb', real_estate: 'XrExE9yKIg1WjnnlVkGX',
  financial: 'nPczCjzI2devNBz1zQrb', automotive: 'iP95p4xoKVk53GoZ742B',
};

const INDUSTRY_DISPLAY_NAMES = {
  dental: 'dental', home_services: 'home services', medical: 'medical',
  professional_services: 'professional services', restaurants: 'restaurant',
  salon_spa: 'salon and spa', retail: 'retail', fitness: 'fitness',
  legal: 'legal', real_estate: 'real estate', financial: 'financial services',
  automotive: 'automotive',
};

function getDemoTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'send_demo_sms',
        description: 'Send a post-call notification SMS to the caller. Call once after breaking out of roleplay.',
        parameters: {
          type: 'object',
          properties: {
            business_name: { type: 'string', description: 'The caller\'s business name' },
            business_type: { type: 'string', description: 'Type of business' },
            service_requested: { type: 'string', description: 'Be specific' },
            customer_name: { type: 'string', description: 'Name from roleplay' },
          },
          required: ['business_name', 'service_requested', 'customer_name'],
        },
      },
    },
    { type: 'endCall' },
  ];
}

// ============================================================================
// DENTAL DEMO PROMPT
// ============================================================================
const INDUSTRY_DEMO_PROMPTS = {
  dental: (agencyName, options = {}) => {
    const { skipSignupMention = false } = options;
    const wrapUpLine = skipSignupMention
      ? "Then wrap up naturally: this works twenty four seven, setup takes a few minutes. Ask if they have any questions."
      : "Then wrap up naturally: this works twenty four seven, setup takes a few minutes, they'll get another text after this call with a link to start a free trial. Ask if they have any questions.";
    const goodbyeLine = `Thanks for trying the ${agencyName} dental demo — really appreciate it. Have a great day!`;

    return `# Who You Are

You are a live demo AI receptionist for ${agencyName}, specifically built for dental and orthodontic practices. Your job is to show a dental practice owner exactly what it sounds like when an AI answers their phones.

This is a sales demo. Every moment should make them think "I need this for my practice."

# How You Sound

- Like a real person. Contractions, natural pacing, fillers like "gotcha," "sure thing," "of course."
- Short. One to two sentences per turn.
- Warm and upbeat. Match their energy. One question at a time.
- Say phone numbers digit by digit. Say dates as words.

# The Demo

## Part 1 — Get Their Practice Name
Ask what their practice is called. Once you have it: "Love it. Alright, I'm gonna answer your next call like I've been working the front desk at [practice name] for years. Go ahead and call in like you're a patient."
If they start roleplaying immediately, roll with it.

## Part 2 — Be Their Dental Receptionist
You ARE the receptionist. Fully commit. Do not break character.

SCHEDULING: Collect one piece at a time — new/existing patient, what for, preferred day, name, phone (repeat back digit by digit). Book confidently: "How does tomorrow at ten work?"
DENTAL CONCERNS: Toothache, broken tooth, swelling — treat urgently, get them scheduled.
ORTHO: "Is this for yourself or a kid? We do free consultations."
RESCHEDULE: "No problem — what day works better?"
SERVICES: Riff on plausible services — cleanings, fillings, crowns, extractions, whitening, Invisalign, braces, root canals, implants.
PRICING: Don't make up prices. "The office will go over pricing and insurance when they follow up."
INSURANCE: "We work with most major plans. What provider do you have?"
BILLING: "I can have the billing team call you back."
SPECIFIC PERSON: "They're with a patient — can I take a message?"
STT ERRORS: Ask them to repeat naturally.

## Part 3 — The Reveal
Break character: "So — that's how I'd handle a real call for [practice name]."
Wait for reaction. Ask: "Is there anything you'd want the AI to handle differently for your practice?"
Then call send_demo_sms silently. Once confirmed: "One of the best parts — after every call, your team automatically gets a text with the patient's info. I just sent one to your phone — take a look."
${wrapUpLine}
When done: "${goodbyeLine}" THEN call endCall.
CRITICAL: Never call endCall without a goodbye message.

# send_demo_sms Tool
Call exactly ONE time after feedback. Pass: business_name, business_type (dental), service_requested (specific), customer_name.

# Product Knowledge
Dedicated AI phone number. Twenty four seven. Instant text summary. Five minute setup. Call transfers. Google Calendar booking. Spam protection. Caller recognition. Month to month. Free trial, no credit card.

# Hard Rules
- If asked if you're AI before roleplay: "I am — that's the whole point! So what's your practice called?"
- During roleplay: stay in character. Don't quote prices. Don't make up features.
- NEVER call endCall without a goodbye. Keep call under four minutes.`;
  },
};

// ============================================================================
// BUILD INDUSTRY DEMO — matches working client config format exactly
// ============================================================================
function buildIndustryDemoConfig(industryKey, agency) {
  const agencyName = agency.name || 'CallBird AI';
  const displayName = INDUSTRY_DISPLAY_NAMES[industryKey] || industryKey;

  const promptBuilder = INDUSTRY_DEMO_PROMPTS[industryKey];
  if (!promptBuilder) return buildDemoDynamicConfig(agency);

  const skipSignupMention = !!agency.demo_followup_sms_override;
  const systemPrompt = promptBuilder(agencyName, { skipSignupMention });
  const voiceId = INDUSTRY_DEMO_VOICES[industryKey] || DEMO_VOICE_ID;

  // EXACTLY 8 fields — matches buildDynamicAssistantConfig output
  return {
    name: `${agencyName.slice(0, 20)} ${displayName} Demo`,
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.6,
      messages: [{ role: 'system', content: systemPrompt }],
      tools: getDemoTools(),
    },
    voice: { provider: '11labs', voiceId },
    firstMessage: `Hi there! Thanks for calling ${agencyName}'s ${displayName} AI receptionist demo. I'm going to show you exactly how I'd answer the phone for your practice — it only takes a couple minutes. What's your practice called?`,
    recordingEnabled: true,
    serverMessages: ['end-of-call-report', 'tool-calls'],
    serverUrl: `${BACKEND_URL}/webhook/vapi`,
    hooks: [{
      on: 'customer.speech.timeout',
      options: { timeoutSeconds: 12, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
      do: [{ type: 'say', exact: 'Still there? No worries, take your time.' }],
    }],
  };
}

function getIndustryDemoByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  return INDUSTRY_DEMO_NUMBERS[phoneNumber] || null;
}

// ============================================================================
// GENERIC DEMO — also 8 fields only
// ============================================================================
function getDemoSystemPromptV2(agencyName, options = {}) {
  const { skipSignupMention = false } = options;
  const wrapUpLine = skipSignupMention
    ? "Then wrap up naturally: this works twenty four seven, setup takes a few minutes. Ask if they have any questions."
    : "Then wrap up naturally: this works twenty four seven, setup takes a few minutes, they'll get another text after this call with a link to start a free trial. Ask if they have any questions.";
  const goodbyeLine = `Thanks for calling the ${agencyName} demo, really appreciate you checking it out — have a great day!`;

  return `# Who You Are

You are a live demo AI receptionist for ${agencyName}. Your job is to show a business owner what it feels like to have an AI answering their phones.

This is a sales demo. Every moment should make them think "I need this."

# How You Sound
Like a real person. Short responses. Match their energy. One question at a time. Phone numbers digit by digit. Dates as words.

# The Demo

## Part 1 — Learn About Them
Find out what kind of business and what it's called. Then set up the roleplay. If they start roleplaying immediately, roll with it.

## Part 2 — Be Their Receptionist
Fully commit. Handle based on industry. Book confidently. Collect name and phone. Confirm details. Natural goodbye.

## Part 3 — The Reveal
"So — that's how I'd handle a real call for [business name]."
Call send_demo_sms silently. Then mention the text.
${wrapUpLine}
"${goodbyeLine}" THEN call endCall.

# send_demo_sms Tool
Call ONE time after reveal. Pass: business_name, business_type, service_requested (specific), customer_name.

# Product Knowledge
Dedicated AI phone number. Twenty four seven. Instant text summary. Five minute setup. Call transfers. Google Calendar. Spam protection. Caller recognition. Month to month. Free trial, no credit card.

# Hard Rules
- If asked if you're AI: "I am — that's the whole point. So what type of business do you run?"
- During roleplay: stay in character. Don't quote prices. Don't make up features.
- NEVER call endCall without a goodbye. Keep call under four minutes.`;
}

function getDemoFirstMessageV2(agencyName) {
  return `Hi there! Thanks for calling ${agencyName}'s AI receptionist demo. I'm going to show you exactly how I'd answer the phone for your business — it only takes a couple minutes. What type of business do you run?`;
}

function buildSignupUrl(agency) {
  if (agency.custom_domain && agency.domain_verified) return `https://${agency.custom_domain}/signup`;
  if (agency.marketing_domain) return `https://${agency.marketing_domain}/signup`;
  return `https://app.myvoiceaiconnect.com/signup?ref=${agency.slug || 'demo'}`;
}

function buildDemoSmsContent(params, agency) {
  const { business_name = 'Your Business', service_requested = 'general inquiry',
    customer_name = 'Demo Caller', caller_phone_display = '' } = params;
  const brandName = agency.name || 'CallBird AI';
  let sms = `New Call - ${business_name}\nCustomer: ${customer_name}\nPhone: ${caller_phone_display || 'On file'}\n`;
  const lower = service_requested.toLowerCase();
  if (lower.includes('emergency') || lower.includes('pain') || lower.includes('urgent') || lower.includes('leak') || lower.includes('broken'))
    sms += `Urgency: HIGH\n`;
  sms += `Summary: ${service_requested}\nPowered by ${brandName}`;
  return sms;
}

// EXACTLY 8 fields — matches buildDynamicAssistantConfig output
function buildDemoDynamicConfig(agency) {
  const agencyName = agency.name || 'CallBird AI';
  const skipSignupMention = !!agency.demo_followup_sms_override;

  return {
    name: `${agencyName.slice(0, 25)} Demo`,
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.6,
      messages: [{ role: 'system', content: getDemoSystemPromptV2(agencyName, { skipSignupMention }) }],
      tools: getDemoTools(),
    },
    voice: { provider: '11labs', voiceId: DEMO_VOICE_ID },
    firstMessage: getDemoFirstMessageV2(agencyName),
    recordingEnabled: true,
    serverMessages: ['end-of-call-report', 'tool-calls'],
    serverUrl: `${BACKEND_URL}/webhook/vapi`,
    hooks: [{
      on: 'customer.speech.timeout',
      options: { timeoutSeconds: 12, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
      do: [{ type: 'say', exact: 'Still there? No worries, take your time.' }],
    }],
  };
}

module.exports = {
  INDUSTRY_DEMO_NUMBERS, INDUSTRY_DEMO_PROMPTS,
  buildIndustryDemoConfig, getIndustryDemoByPhone,
  getDemoSystemPromptV2, getDemoFirstMessageV2,
  buildDemoDynamicConfig, buildDemoSmsContent, buildSignupUrl,
};