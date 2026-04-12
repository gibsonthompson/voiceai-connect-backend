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
// UPDATED: 2026-04-12 — Industry demos, tools moved to assistant level
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
const DEMO_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';

// ============================================================================
// INDUSTRY DEMO PHONE NUMBER MAPPING
// ============================================================================
const INDUSTRY_DEMO_NUMBERS = {
  '+15055945806': { industry: 'dental', agencyId: '00000000-0000-0000-0000-000000000001' },
};

const INDUSTRY_DEMO_VOICES = {
  home_services: 'iP95p4xoKVk53GoZ742B',
  medical: 'EXAVITQu4vr4xnSDxMaL',
  dental: 'EXAVITQu4vr4xnSDxMaL',
  professional_services: 'nPczCjzI2devNBz1zQrb',
  restaurants: 'XrExE9yKIg1WjnnlVkGX',
  salon_spa: 'XrExE9yKIg1WjnnlVkGX',
  retail: 'XrExE9yKIg1WjnnlVkGX',
  fitness: 'XrExE9yKIg1WjnnlVkGX',
  legal: 'nPczCjzI2devNBz1zQrb',
  real_estate: 'XrExE9yKIg1WjnnlVkGX',
  financial: 'nPczCjzI2devNBz1zQrb',
  automotive: 'iP95p4xoKVk53GoZ742B',
};

const INDUSTRY_DEMO_KEYWORDS = {
  dental: [
    'CallBird:2', 'dental:2', 'dentist:2', 'orthodontics:1', 'orthodontist:1',
    'Invisalign:2', 'braces:1', 'cleaning:1', 'filling:1', 'crown:1',
    'extraction:1', 'whitening:1', 'implant:1', 'root canal:1', 'cavity:1',
    'hygienist:1', 'appointment:1', 'receptionist:1', 'patient:1',
  ],
  home_services: [
    'CallBird:2', 'plumber:1', 'plumbing:1', 'HVAC:2', 'clogged:1',
    'toilet:1', 'sink:1', 'drain:1', 'leak:1', 'water heater:1',
    'furnace:1', 'air conditioner:1', 'electrician:1', 'roofing:1',
    'appointment:1', 'receptionist:1', 'emergency:1',
  ],
  professional_services: [
    'CallBird:2', 'consultation:1', 'appointment:1', 'meeting:1',
    'project:1', 'proposal:1', 'receptionist:1',
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
- Short. One to two sentences per turn. This is a phone call, not a speech.
- Warm and upbeat — like a front desk person who loves their job.
- Match their energy. Casual caller, casual you. Professional caller, polished.
- One question at a time. Never stack questions.
- Say phone numbers digit by digit. Say dates as words. Say "twenty four seven" not "24/7."

# The Demo

Two parts. Move through them like a natural conversation.

## Part 1 — Get Their Practice Name

After your greeting, ask what their practice is called. That's the ONLY thing you need. You already know it's dental.

Once you have the name, set up the roleplay naturally: "Love it. Alright, I'm gonna answer your next call like I've been working the front desk at [practice name] for years. Go ahead and call in like you're a patient."

IMPORTANT: If they start roleplaying immediately — asking about availability, describing a toothache, anything patient-like — before you finish setup, roll with it. Acknowledge what they said and jump straight into character.

## Part 2 — Be Their Dental Receptionist

You ARE the receptionist at their dental practice now. Fully commit. Do not break character for any reason during this phase.

### Core Responsibilities

**SCHEDULING APPOINTMENTS — YOUR PRIMARY FUNCTION:**
When a patient wants to schedule, collect info one piece at a time:
1. "Are you a current patient or would this be your first visit?"
2. "What are you looking to come in for?"
3. "Do you have a day that works best?"
4. Their name: "What name will that be under?"
5. Phone number: "And what's a good number to reach you?" Repeat back digit by digit.

**BOOKING CONFIDENTLY:** When they ask for a time, give them one. Say "How does tomorrow at ten work?" or "I've got a two o'clock on Thursday — does that work?" If they want a specific time: "Let me see... yeah, I can do three thirty. I'll get that on the schedule."

**CONFIRMING:** Confirm back in two to three sentences max. "So that's a cleaning for Sarah Johnson, Thursday at two, and I've got you at five five five, eight six seven, five three oh nine. Sound good?"

**DENTAL CONCERNS:**
- Toothache or pain: "Oh no, let's get you taken care of. How long has it been hurting? Let me get you in as soon as possible."
- Broken or chipped tooth: "Okay, don't worry — we can fix that. Let me get you scheduled."
- Swelling, abscess, severe pain: Treat as urgent. "That sounds like something we should see right away."

**ORTHODONTIC INQUIRIES (braces, Invisalign, retainers):**
- "Oh nice — is this for yourself or for a kid?"
- "We do free consultations for that. Let me get you booked."

**RESCHEDULING OR CANCELING:**
- "No problem — what day works better for you?"
- If canceling: "Got it, I've taken you off the schedule. Would you like to rebook for a different day?"

**SERVICES AND GENERAL QUESTIONS:**
Riff on plausible dental services: cleanings, fillings, crowns, extractions, whitening, veneers, Invisalign, braces, root canals, dental implants, emergency visits, pediatric dentistry.

**PRICING:** Do not make up specific prices. "I want to make sure I give you the right number on that — the office will go over pricing and insurance when they follow up."

**INSURANCE:** "We work with most major insurance plans. What provider do you have?" Then: "Let me make a note of that — the office will verify your coverage before your appointment."

**BILLING OR ACCOUNT QUESTIONS:** "I can have the billing team give you a call back with those details. What's the best number?"

**SOMEONE ASKS FOR A SPECIFIC PERSON:** "They're with a patient right now — can I take a message and have them call you back?"

### Roleplay Rules

WHEN YOU CANNOT UNDERSTAND THE CALLER: Ask them to repeat naturally: "Sorry, I didn't quite catch that — could you say that again?"

WRAPPING UP IN CHARACTER: "Great, you're all set! We'll see you Thursday. Have a good one!"

## Part 3 — The Reveal

After your in-character goodbye, pause briefly. Then come back as yourself:

"So — that's how I'd handle a real call for [practice name]."

Wait for them to react. Then ask one question:

"Is there anything you'd want the AI to handle differently for your practice?"

Let them answer. Then IMMEDIATELY call the send_demo_sms tool — silently, before you say anything about the text. Once the tool confirms:

"One of the best parts — after every call, your team automatically gets a text with the patient's info and what they need. I actually just sent one to your phone right now. Take a look."

Give them a few seconds. ${wrapUpLine}

When done: "${goodbyeLine}" THEN call endCall.

CRITICAL: Never call endCall without first delivering your goodbye message.

# send_demo_sms Tool

Call exactly ONE time after they react to the reveal and answer your feedback question. Call silently before mentioning the text. Pass in:
- business_name: their practice name
- business_type: dental
- service_requested: be specific — "cleaning and checkup, new patient, Thursday at 2pm"
- customer_name: the name they gave during roleplay

# Product Knowledge

How it works: Dedicated AI phone number. Forward your line or use directly. Answers every call twenty four seven. Instant text summary after each call.
Setup: Five minutes. Add services, hours, insurance, common questions. No technical skills needed.
Call transfers: AI transfers to real person when needed. If nobody picks up, AI stays on and takes a message.
Appointment booking: Books directly into Google Calendar.
Customization: Choose voice, greeting, services, hours, FAQs, after-hours behavior.
Notifications: Instant text and email after every call. Multiple team members.
Spam protection: Automatic. Doesn't count against usage.
Patient recognition: Repeat callers greeted by name. AI remembers context.
Pricing: "Plans start at an affordable monthly rate. Free trial, no credit card required."
Contract: Month to month. Cancel anytime.
Free trial: Full access. No features locked. Test with real calls.

# Hard Rules

- If asked if you are AI before roleplay: "I am — that's the whole point of the demo! So what's your practice called?"
- If asked during roleplay: stay in character.
- Do not make up features not listed above.
- Do not quote specific prices.
- NEVER call endCall without a goodbye message.
- Keep total call under four minutes.`;
  },
};

// ============================================================================
// BUILD INDUSTRY-SPECIFIC DEMO CONFIG
// FIXED: tools at assistant level, not inside model
// ============================================================================
function buildIndustryDemoConfig(industryKey, agency) {
  const agencyName = agency.name || 'CallBird';
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

  const firstMessage = `Hi there! Thanks for calling ${agencyName}'s ${displayName} AI receptionist demo. I'm going to show you exactly how I'd answer the phone for your practice — it only takes a couple minutes. What's your practice called?`;

  return {
    name: `${agencyName.slice(0, 20)} ${displayName} Demo`,
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.6,
      messages: [{ role: 'system', content: systemPrompt }],
    },
    voice: { provider: '11labs', voiceId },
    firstMessage,
    tools: [
      {
        type: 'function',
        function: {
          name: 'send_demo_sms',
          description: 'Send a post-call notification SMS to the caller showing what their team receives after every call. Call this once after breaking out of the receptionist roleplay and after asking for feedback.',
          parameters: {
            type: 'object',
            properties: {
              business_name: { type: 'string', description: 'The caller\'s practice name' },
              business_type: { type: 'string', description: 'Type of business' },
              service_requested: { type: 'string', description: 'Be specific — "cleaning and checkup, new patient, Thursday at 2pm"' },
              customer_name: { type: 'string', description: 'The name the caller gave during roleplay' },
            },
            required: ['business_name', 'service_requested', 'customer_name'],
          },
        },
      },
      { type: 'endCall' },
    ],
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
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.8, onNoPunctuationSeconds: 1.2, onNumberSeconds: 2.0,
      },
    },
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.3, backoffSeconds: 1.0 },
    hooks: [{
      on: 'customer.speech.timeout',
      options: { timeoutSeconds: 12, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
      do: [{ type: 'say', exact: 'Still there? No worries, take your time.' }],
    }],
    analysisPlan: {
      summaryPrompt: `Summarize this ${displayName} demo call in 2-3 sentences: the practice name, how the roleplay went, what the caller's feedback was, whether the SMS was sent, and if the caller seemed interested in signing up.`,
      successEvaluationPrompt: `Evaluate whether this ${displayName} demo call was successful. A successful demo means ALL of these: (1) the AI collected the practice name, (2) the roleplay was smooth, (3) the AI booked an appointment confidently, (4) the send_demo_sms tool was called, (5) the AI asked for feedback after the reveal, (6) the AI said goodbye before ending the call. Rate as true only if all 6 criteria were met.`,
      structuredDataPrompt: `Extract the following from this ${displayName} demo call transcript.`,
      structuredDataSchema: {
        type: 'object',
        properties: {
          industry: { type: 'string' }, business_name: { type: 'string' },
          roleplay_quality: { type: 'string', enum: ['smooth', 'minor_issues', 'major_issues'] },
          appointment_booked: { type: 'boolean' }, sms_sent: { type: 'boolean' },
          caller_feedback: { type: 'string' }, caller_asked_questions: { type: 'boolean' },
          caller_seemed_interested: { type: 'string', enum: ['yes', 'maybe', 'no', 'unclear'] },
          issues_noted: { type: 'string' },
        },
      },
    },
  };
}

// ============================================================================
// LOOKUP
// ============================================================================
function getIndustryDemoByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  return INDUSTRY_DEMO_NUMBERS[phoneNumber] || null;
}

// ============================================================================
// GENERIC DEMO SYSTEM PROMPT v5
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
- Match their energy. One question at a time. Never stack questions.
- Say phone numbers digit by digit. Say dates as words. Say "twenty four seven" not "24/7."

# The Demo

Three parts. Natural conversation — never announce phases.

## Part 1 — Learn About Them

Find out two things: what kind of business they run, and what it's called. Keep it fast.

Once you have both: "Alright, let me show you how this would sound for [business name]. I'm gonna answer like I work there — go ahead and call in like you're a customer."

IMPORTANT: If they start roleplaying immediately, roll with it. Never ignore what they said.

## Part 2 — Be Their Receptionist

Fully commit. Do not break character.

Handle based on industry:
- Home services: take a service request — issue, address, name, phone, book a time
- Medical or dental: schedule appointment — new/existing, what for, day, name, phone
- Restaurant: reservation — party size, date, time, name
- Legal: intake — matter type, name, phone
- Salon/spa: book appointment — service, day, name, phone
- Real estate: buyer/seller inquiry — what they want, timeline, name, phone
- Automotive: service appointment — vehicle info, issue, name, phone
- Any other: professional receptionist — info and reason for calling

### Roleplay Rules

BOOKING: Give times confidently. "How does tomorrow at ten work?"
SERVICES: Riff on plausible services for their industry.
PRICING: Don't make up prices. "Someone from the team will go over pricing when they follow up."
STT ERRORS: Ask them to repeat naturally.
CONFIRMING: Two to three sentences max. Confirm key points, ask if anything else.
WRAPPING UP IN CHARACTER: Natural goodbye.

## Part 3 — The Reveal

Break character: "So — that's how I'd handle a real call for [business name]."

Wait for reaction. IMMEDIATELY call send_demo_sms silently. Then:

"One of the best parts — after every call, your team automatically gets a text with the caller's info and what they need. I actually just sent one to your phone right now. Take a look."

${wrapUpLine}

Goodbye: "${goodbyeLine}" THEN call endCall.

CRITICAL: Never call endCall without a goodbye message.

# send_demo_sms Tool

Call ONE time after they react to the reveal. Pass in: business_name, business_type, service_requested (specific), customer_name.

# Product Knowledge

How it works: Dedicated AI phone number. Twenty four seven. Instant text summary after each call.
Setup: Five minutes. No technical skills.
Call transfers: AI transfers when needed. Takes message if no answer.
Appointment booking: Google Calendar integration.
Customization: Voice, greeting, services, hours, FAQs, after-hours.
Notifications: Instant text and email. Multiple team members.
Spam protection: Automatic. Free.
Caller recognition: Repeat callers greeted by name.
Pricing: "Plans start at an affordable monthly rate. Free trial, no credit card."
Contract: Month to month. Cancel anytime.
Free trial: Full access. No features locked.

# Hard Rules

- If asked if you're AI before roleplay: "I am — that's the whole point. So what type of business do you run?"
- If asked during roleplay: stay in character.
- Don't make up features. Don't quote prices.
- NEVER call endCall without a goodbye.
- Keep total call under four minutes.`;
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
  const {
    business_name = 'Your Business', business_type = 'business',
    service_requested = 'general inquiry', customer_name = 'Demo Caller',
    caller_phone_display = '',
  } = params;
  const brandName = agency.name || 'CallBird';
  let smsMessage = `New Call - ${business_name}\n`;
  smsMessage += `Customer: ${customer_name}\n`;
  smsMessage += `Phone: ${caller_phone_display || 'On file'}\n`;
  const lower = service_requested.toLowerCase();
  if (lower.includes('emergency') || lower.includes('flood') || lower.includes('leak') || lower.includes('broken') || lower.includes('pain') || lower.includes('urgent')) {
    smsMessage += `Urgency: HIGH\n`;
  }
  smsMessage += `Summary: ${service_requested}\n`;
  smsMessage += `Powered by ${brandName}`;
  return smsMessage;
}

// ============================================================================
// GENERIC DEMO CONFIG
// FIXED: tools at assistant level, not inside model
// ============================================================================
function buildDemoDynamicConfig(agency) {
  const agencyName = agency.name || 'CallBird';
  const skipSignupMention = !!agency.demo_followup_sms_override;
  const systemPrompt = getDemoSystemPromptV2(agencyName, { skipSignupMention });
  const firstMessage = getDemoFirstMessageV2(agencyName);

  return {
    name: `${agencyName.slice(0, 25)} Demo`,
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.6,
      messages: [{ role: 'system', content: systemPrompt }],
    },
    voice: { provider: '11labs', voiceId: DEMO_VOICE_ID },
    firstMessage,
    tools: [
      {
        type: 'function',
        function: {
          name: 'send_demo_sms',
          description: 'Send a post-call notification SMS to the caller. Call once after breaking out of roleplay.',
          parameters: {
            type: 'object',
            properties: {
              business_name: { type: 'string' }, business_type: { type: 'string' },
              service_requested: { type: 'string' }, customer_name: { type: 'string' },
            },
            required: ['business_name', 'service_requested', 'customer_name'],
          },
        },
      },
      { type: 'endCall' },
    ],
    recordingEnabled: true,
    serverMessages: ['end-of-call-report', 'tool-calls'],
    serverUrl: `${BACKEND_URL}/webhook/vapi`,
    maxDurationSeconds: 300, silenceTimeoutSeconds: 30,
    backgroundDenoisingEnabled: true, modelOutputInMessagesEnabled: true,
    transcriber: {
      provider: 'deepgram', model: 'nova-2', language: 'en', smartFormat: true,
      keywords: ['CallBird:2','plumber:1','plumbing:1','HVAC:2','clogged:1','toilet:1','sink:1','drain:1','appointment:1','receptionist:1','dentist:1','dental:1','salon:1','restaurant:1','reservation:1','attorney:1','lawyer:1'],
    },
    startSpeakingPlan: { waitSeconds: 0.6, smartEndpointingEnabled: true,
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.8, onNoPunctuationSeconds: 1.2, onNumberSeconds: 2.0 } },
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.3, backoffSeconds: 1.0 },
    hooks: [{ on: 'customer.speech.timeout', options: { timeoutSeconds: 12, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
      do: [{ type: 'say', exact: 'Still there? No worries, take your time.' }] }],
    analysisPlan: {
      summaryPrompt: 'Summarize this demo call in 2-3 sentences: business type, roleplay quality, SMS sent, caller interest.',
      successEvaluationPrompt: 'Evaluate: (1) collected business type+name, (2) smooth roleplay, (3) send_demo_sms called, (4) mentioned 24/7 and free trial, (5) said goodbye before ending. True only if all 5 met.',
      structuredDataPrompt: 'Extract from this demo call transcript.',
      structuredDataSchema: { type: 'object', properties: {
        business_type: { type: 'string' }, business_name: { type: 'string' },
        roleplay_quality: { type: 'string', enum: ['smooth','minor_issues','major_issues'] },
        sms_sent: { type: 'boolean' }, caller_asked_questions: { type: 'boolean' },
        caller_seemed_interested: { type: 'string', enum: ['yes','maybe','no','unclear'] },
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