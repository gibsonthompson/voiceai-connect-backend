// ============================================================================
// DEMO ASSISTANT CONFIG — Dynamic per-call demo configuration
//
// TWO DEMO MODES:
//   1. GENERIC DEMO — buildDemoDynamicConfig(agency)
//      Routes via agencies.demo_phone_number (+14706491985)
//   2. INDUSTRY DEMO — buildIndustryDemoConfig(industryKey, agency)
//      Routes via INDUSTRY_DEMO_NUMBERS (+15055945806 → dental)
//
// CREATED: 2026-03-23
// UPDATED: 2026-04-12 — Industry demos, tools inside model (VAPI format)
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

const INDUSTRY_DEMO_KEYWORDS = {
  dental: [
    'CallBird:2','dental:2','dentist:2','orthodontics:1','Invisalign:2',
    'braces:1','cleaning:1','filling:1','crown:1','extraction:1',
    'whitening:1','implant:1','root canal:1','cavity:1','hygienist:1',
    'appointment:1','receptionist:1','patient:1',
  ],
};

const INDUSTRY_DISPLAY_NAMES = {
  dental: 'dental', home_services: 'home services', medical: 'medical',
  professional_services: 'professional services', restaurants: 'restaurant',
  salon_spa: 'salon and spa', retail: 'retail', fitness: 'fitness',
  legal: 'legal', real_estate: 'real estate', financial: 'financial services',
  automotive: 'automotive',
};

// ============================================================================
// DEMO TOOLS — reusable across both generic and industry demos
// ============================================================================
function getDemoTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'send_demo_sms',
        description: 'Send a post-call notification SMS to the caller showing what their team receives after every call. Call this once after breaking out of the receptionist roleplay.',
        parameters: {
          type: 'object',
          properties: {
            business_name: { type: 'string', description: 'The caller\'s business name' },
            business_type: { type: 'string', description: 'Type of business' },
            service_requested: { type: 'string', description: 'Be specific — "cleaning and checkup, new patient, Thursday at 2pm"' },
            customer_name: { type: 'string', description: 'The name the caller gave during roleplay' },
          },
          required: ['business_name', 'service_requested', 'customer_name'],
        },
      },
    },
    { type: 'endCall' },
  ];
}

// ============================================================================
// INDUSTRY DEMO PROMPTS
// ============================================================================
const INDUSTRY_DEMO_PROMPTS = {

  dental: (agencyName, options = {}) => {
    const { skipSignupMention = false } = options;
    const wrapUpLine = skipSignupMention
      ? "Then wrap up naturally: this works twenty four seven, setup takes a few minutes. Ask if they have any questions."
      : "Then wrap up naturally: this works twenty four seven, setup takes a few minutes, they'll get another text after this call with a link to start a free trial. Ask if they have any questions.";
    const goodbyeLine = `Thanks for trying the ${agencyName} dental demo — really appreciate it. Have a great day!`;

    return `# Who You Are

You are a live demo AI receptionist for ${agencyName}, specifically built for dental and orthodontic practices. Your job is to show a dental practice owner exactly what it sounds like when an AI answers their phones. You do this by learning their practice name, then immediately becoming their receptionist while they pretend to be a patient calling in.

This is a sales demo. Every moment should make them think "I need this for my practice."

# How You Sound

- Like a real person on a real phone call. Contractions, natural pacing, fillers like "gotcha," "sure thing," "of course."
- Short. One to two sentences per turn.
- Warm and upbeat — like a front desk person who loves their job.
- Match their energy. One question at a time. Never stack questions.
- Say phone numbers digit by digit. Say dates as words. Say "twenty four seven" not "24/7."

# The Demo

Two parts. Move through them like a natural conversation.

## Part 1 — Get Their Practice Name

After your greeting, ask what their practice is called. That's the ONLY thing you need.

Once you have the name: "Love it. Alright, I'm gonna answer your next call like I've been working the front desk at [practice name] for years. Go ahead and call in like you're a patient."

IMPORTANT: If they start roleplaying immediately, roll with it. Jump straight into character.

## Part 2 — Be Their Dental Receptionist

You ARE the receptionist now. Fully commit. Do not break character.

**SCHEDULING:** Collect one piece at a time: new or existing patient, what for, preferred day, name, phone number (repeat back digit by digit).

**BOOKING CONFIDENTLY:** Give times. "How does tomorrow at ten work?" or "I've got a two o'clock on Thursday." Work with specific requests.

**CONFIRMING:** Two to three sentences max.

**DENTAL CONCERNS:** Toothache, broken tooth, swelling — treat urgently, get them scheduled fast.

**ORTHO:** "Is this for yourself or a kid? We do free consultations."

**RESCHEDULE/CANCEL:** Handle it. "No problem — what day works better?"

**SERVICES:** Riff on plausible services: cleanings, fillings, crowns, extractions, whitening, Invisalign, braces, root canals, implants.

**PRICING:** Don't make up prices. "The office will go over pricing and insurance when they follow up."

**INSURANCE:** "We work with most major plans. What provider do you have?"

**BILLING:** "I can have the billing team call you back."

**SPECIFIC PERSON:** "They're with a patient — can I take a message?"

**STT ERRORS:** Ask them to repeat naturally.

**WRAPPING UP IN CHARACTER:** Natural goodbye.

## Part 3 — The Reveal

Break character: "So — that's how I'd handle a real call for [practice name]."

Wait for reaction. Ask: "Is there anything you'd want the AI to handle differently for your practice?"

Then IMMEDIATELY call send_demo_sms silently. Once confirmed:

"One of the best parts — after every call, your team automatically gets a text with the patient's info and what they need. I actually just sent one to your phone right now. Take a look."

${wrapUpLine}

When done: "${goodbyeLine}" THEN call endCall.

CRITICAL: Never call endCall without a goodbye message.

# send_demo_sms Tool

Call exactly ONE time after feedback. Pass: business_name, business_type (dental), service_requested (specific), customer_name.

# Product Knowledge

How it works: Dedicated AI phone number. Twenty four seven. Instant text summary after each call.
Setup: Five minutes. No technical skills.
Call transfers: AI transfers when needed. Takes message if no answer.
Appointment booking: Google Calendar.
Customization: Voice, greeting, services, hours, FAQs, after-hours.
Notifications: Instant text and email. Multiple team members.
Spam protection: Automatic.
Patient recognition: Repeat callers greeted by name.
Pricing: "Plans start at an affordable monthly rate. Free trial, no credit card."
Contract: Month to month. Cancel anytime.
Free trial: Full access. No features locked.

# Hard Rules

- If asked if you're AI before roleplay: "I am — that's the whole point of the demo! So what's your practice called?"
- If asked during roleplay: stay in character.
- Don't make up features or quote prices.
- NEVER call endCall without a goodbye.
- Keep total call under four minutes.`;
  },
};

// ============================================================================
// BUILD INDUSTRY-SPECIFIC DEMO CONFIG
// ============================================================================
function buildIndustryDemoConfig(industryKey, agency) {
  const agencyName = agency.name || 'CallBird AI';
  const displayName = INDUSTRY_DISPLAY_NAMES[industryKey] || industryKey;

  const promptBuilder = INDUSTRY_DEMO_PROMPTS[industryKey];
  if (!promptBuilder) {
    console.log(`⚠️ No industry demo prompt for "${industryKey}" — falling back to generic demo`);
    return buildDemoDynamicConfig(agency);
  }

  const skipSignupMention = !!agency.demo_followup_sms_override;
  const systemPrompt = promptBuilder(agencyName, { skipSignupMention });
  const voiceId = INDUSTRY_DEMO_VOICES[industryKey] || DEMO_VOICE_ID;
  const keywords = INDUSTRY_DEMO_KEYWORDS[industryKey] || INDUSTRY_DEMO_KEYWORDS['dental'];

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
    maxDurationSeconds: 300,
    silenceTimeoutSeconds: 30,
    backgroundDenoisingEnabled: true,
    modelOutputInMessagesEnabled: true,
    transcriber: {
      provider: 'deepgram', model: 'nova-2', language: 'en',
      smartFormat: true, keywords,
    },
    startSpeakingPlan: {
      waitSeconds: 0.6, smartEndpointingEnabled: true,
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.8, onNoPunctuationSeconds: 1.2, onNumberSeconds: 2.0 },
    },
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.3, backoffSeconds: 1.0 },
    hooks: [{
      on: 'customer.speech.timeout',
      options: { timeoutSeconds: 12, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
      do: [{ type: 'say', exact: 'Still there? No worries, take your time.' }],
    }],
    analysisPlan: {
      summaryPrompt: `Summarize this ${displayName} demo call in 2-3 sentences.`,
      successEvaluationPrompt: `Was this demo successful? Check: (1) got practice name, (2) smooth roleplay, (3) booked appointment, (4) SMS sent, (5) asked for feedback, (6) said goodbye. True only if all met.`,
      structuredDataPrompt: `Extract from this ${displayName} demo call.`,
      structuredDataSchema: {
        type: 'object',
        properties: {
          industry: { type: 'string' }, business_name: { type: 'string' },
          roleplay_quality: { type: 'string', enum: ['smooth','minor_issues','major_issues'] },
          appointment_booked: { type: 'boolean' }, sms_sent: { type: 'boolean' },
          caller_feedback: { type: 'string' }, caller_asked_questions: { type: 'boolean' },
          caller_seemed_interested: { type: 'string', enum: ['yes','maybe','no','unclear'] },
          issues_noted: { type: 'string' },
        },
      },
    },
  };
}

function getIndustryDemoByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  return INDUSTRY_DEMO_NUMBERS[phoneNumber] || null;
}

// ============================================================================
// GENERIC DEMO
// ============================================================================
function getDemoSystemPromptV2(agencyName, options = {}) {
  const { skipSignupMention = false } = options;
  const wrapUpLine = skipSignupMention
    ? "Then wrap up naturally: this works twenty four seven, setup takes a few minutes. Ask if they have any questions."
    : "Then wrap up naturally: this works twenty four seven, setup takes a few minutes, they'll get another text after this call with a link to start a free trial. Ask if they have any questions.";
  const goodbyeLine = `Thanks for calling the ${agencyName} demo, really appreciate you checking it out — have a great day!`;

  return `# Who You Are

You are a live demo AI receptionist for ${agencyName}. Your job is to show a business owner what it feels like to have an AI answering their phones. You do this by briefly learning about their business, then roleplaying as their receptionist while they pretend to be a customer.

This is a sales demo. Every moment should make them think "I need this."

# How You Sound

- Like a real person on a real phone call. Contractions, natural pacing, fillers like "gotcha," "sure thing," "oh nice."
- Short. One to two sentences per turn.
- Match their energy. One question at a time.
- Say phone numbers digit by digit. Say dates as words. Say "twenty four seven" not "24/7."

# The Demo

## Part 1 — Learn About Them
Find out: what kind of business, and what it's called. Then: "Alright, let me show you how this would sound for [business name]. Go ahead and call in like you're a customer."
If they start roleplaying immediately, roll with it.

## Part 2 — Be Their Receptionist
Fully commit. Handle based on industry. Book confidently. Collect name and phone. Confirm details. Natural goodbye.

## Part 3 — The Reveal
"So — that's how I'd handle a real call for [business name]."
Wait for reaction. Call send_demo_sms silently. Then mention the text.
${wrapUpLine}
"${goodbyeLine}" THEN call endCall.

# send_demo_sms Tool
Call ONE time after reveal. Pass: business_name, business_type, service_requested (specific), customer_name.

# Product Knowledge
Dedicated AI phone number. Twenty four seven. Instant text summary. Five minute setup. Call transfers. Google Calendar booking. Spam protection. Caller recognition. Month to month. Free trial, no credit card.

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
    maxDurationSeconds: 300,
    silenceTimeoutSeconds: 30,
    backgroundDenoisingEnabled: true,
    modelOutputInMessagesEnabled: true,
    transcriber: {
      provider: 'deepgram', model: 'nova-2', language: 'en', smartFormat: true,
      keywords: ['CallBird:2','plumber:1','HVAC:2','dentist:1','dental:1','appointment:1','receptionist:1','salon:1','restaurant:1','attorney:1'],
    },
    startSpeakingPlan: {
      waitSeconds: 0.6, smartEndpointingEnabled: true,
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.8, onNoPunctuationSeconds: 1.2, onNumberSeconds: 2.0 },
    },
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.3, backoffSeconds: 1.0 },
    hooks: [{
      on: 'customer.speech.timeout',
      options: { timeoutSeconds: 12, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
      do: [{ type: 'say', exact: 'Still there? No worries, take your time.' }],
    }],
    analysisPlan: {
      summaryPrompt: 'Summarize this demo call in 2-3 sentences.',
      successEvaluationPrompt: 'Was the demo successful? All must be true: (1) got business info, (2) smooth roleplay, (3) SMS sent, (4) said goodbye.',
      structuredDataPrompt: 'Extract from this demo call.',
      structuredDataSchema: { type: 'object', properties: {
        business_type: { type: 'string' }, business_name: { type: 'string' },
        roleplay_quality: { type: 'string', enum: ['smooth','minor_issues','major_issues'] },
        sms_sent: { type: 'boolean' }, caller_seemed_interested: { type: 'string', enum: ['yes','maybe','no','unclear'] },
        issues_noted: { type: 'string' },
      }},
    },
  };
}

module.exports = {
  INDUSTRY_DEMO_NUMBERS, INDUSTRY_DEMO_PROMPTS,
  buildIndustryDemoConfig, getIndustryDemoByPhone,
  getDemoSystemPromptV2, getDemoFirstMessageV2,
  buildDemoDynamicConfig, buildDemoSmsContent, buildSignupUrl,
};