// ============================================================================
// DEMO ASSISTANT CONFIG
//
// PHONE NUMBER ROUTING:
//   +1 (505) 594-5806 → CallBird generic demo (via agencies.demo_phone_number)
//   +1 (470) 649-1985 → Dental demo (via INDUSTRY_DEMO_NUMBERS, unbranded)
//
// UPDATED: 2026-05-05 — Added analysisPlan for structured data extraction
// UPDATED: 2026-05-14 — Multilingual support: Deepgram Nova-2 transcriber
//          with language='multi', language instruction in demo prompts
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
const DEMO_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';

const INDUSTRY_DEMO_NUMBERS = {
  '+14706491985': { industry: 'dental', agencyId: '00000000-0000-0000-0000-000000000001' },
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

// ============================================================================
// MULTILINGUAL TRANSCRIBER CONFIG — shared across all demo configs
// ============================================================================
const DEMO_TRANSCRIBER = {
  provider: 'deepgram',
  model: 'nova-2',
  language: 'multi',
};

// ============================================================================
// LANGUAGE BLOCK — appended to demo prompts
// ============================================================================
const DEMO_LANGUAGE_BLOCK = `

# Language
If the caller speaks Spanish, switch to Spanish immediately and continue the entire demo in Spanish — including the roleplay, the reveal, and any product questions. Match whatever language the caller uses. Do not ask for language preference.`;

// ============================================================================
// VAPI ANALYSIS PLAN — auto-extracts structured data from demo calls
// ============================================================================
const DEMO_ANALYSIS_PLAN = {
  summaryPlan: {
    messages: [
      {
        role: 'system',
        content: 'Summarize this AI receptionist demo call in 2-3 sentences in English, regardless of the language spoken during the call. Include: what type of business the caller runs, what scenario the AI demonstrated for them, and whether the caller seemed genuinely interested in the product or was just browsing. If the call was conducted in a non-English language, note that at the start of the summary.'
      }
    ],
  },
  structuredDataPlan: {
    messages: [
      {
        role: 'system',
        content: [
          'Extract the following from this AI receptionist demo call transcript.',
          'Return ONLY valid JSON with these fields:',
          '- business_name: the caller\'s business name (string or null)',
          '- business_type: type of business like "dental", "plumbing", "restaurant", "law firm" (string or null)',
          '- caller_name: the caller\'s personal name if mentioned (string or null)',
          '- interest_level: "high" if they asked about pricing, signup, features, or seemed excited; "medium" if engaged but noncommittal; "low" if disinterested or ended quickly',
          '- service_discussed: the specific service or scenario roleplayed, e.g. "emergency dental appointment booking" or "plumbing leak repair intake" (string or null)',
          '- asked_questions: true if the caller asked follow-up questions about the product after the roleplay',
          '- call_language: the primary language spoken during the call, e.g. "en" for English, "es" for Spanish (string)',
        ].join('\n'),
      }
    ],
    schema: {
      type: 'object',
      properties: {
        business_name: { type: 'string' },
        business_type: { type: 'string' },
        caller_name: { type: 'string' },
        interest_level: { type: 'string', enum: ['high', 'medium', 'low'] },
        service_discussed: { type: 'string' },
        asked_questions: { type: 'boolean' },
        call_language: { type: 'string' },
      },
    },
  },
  successEvaluationPlan: {
    messages: [
      {
        role: 'system',
        content: 'Evaluate whether this demo call was successful as a sales demo. A successful demo means the caller experienced the AI roleplay, seemed engaged, and left with a positive impression. Score 1-10.'
      }
    ],
    rubric: 'NumericScale',
  },
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

const PRODUCT_KNOWLEDGE = `# Product Knowledge

Use this to answer questions after the roleplay. Keep answers to one or two sentences. Be conversational, not salesy.

**How it works:** You get a dedicated AI phone number. Forward your existing business line to it, or use it as your main number. The AI answers every call, twenty four seven, three sixty five. After each call, you and your team get an instant text with the caller's name, phone number, what they need, and how urgent it is.

**How the AI knows about the business:** When you sign up, you tell the AI about your business — your services, hours, location, insurance or payment info, and common questions. You can also give it your website URL and it will scan the whole site automatically. The more info you give it, the smarter it gets. You can update it anytime from the dashboard.

**How it handles calls it doesn't know the answer to:** If someone asks something the AI doesn't have info on, it doesn't make stuff up. It says something like "Let me have the team follow up on that" and takes a message. If call transfer is set up, it can connect them to a real person instead.

**Setup:** About five minutes. No technical skills, no coding, nothing to install. Just sign up, describe your business, and it is ready to take calls.

**Call transfers:** If a caller needs a real person, the AI can transfer them to any number you set up. If nobody picks up, the AI stays on the line and takes a detailed message instead of dropping the call. The caller never hits a dead end.

**Appointment booking:** The AI can book directly into Google Calendar. The caller picks a time, it shows up on your schedule automatically.

**Customization:** You choose the voice, customize the greeting, add your services and hours, write FAQs, and configure after-hours behavior. You can change any of it at any time from the dashboard.

**Notifications:** Instant text message after every call with the full summary. Email summaries too. You can add multiple team members so everyone gets notified.

**Spam protection:** The AI detects and blocks spam calls and robocalls automatically. They don't count against your usage.

**Caller recognition:** When someone calls back, the AI recognizes their number and greets them by name. It remembers context from previous calls so the caller doesn't have to repeat themselves.

**Multiple simultaneous calls:** The AI handles unlimited calls at the same time. No busy signals, no hold music, no missed calls during rush periods.

**After hours:** You can configure different behavior for after hours — the AI can take messages, let callers know your hours, or handle things differently based on your settings.

**Multilingual:** The AI automatically detects if a caller speaks Spanish and switches to Spanish for the entire call. No configuration needed — it just works. Supports English and Spanish out of the box.

**Industries:** Works for any business that takes phone calls. There are specialized configurations for dental, medical, home services, legal, restaurants, salons, real estate, automotive, fitness, retail, and financial services.

**Pricing:** "Plans start at an affordable monthly rate. You will see all the options when you start your free trial — no credit card required." Do not quote specific dollar amounts.

**Contract:** No long-term contracts. Month to month. Cancel anytime. No cancellation fees.

**Free trial:** Full access to every feature. Nothing locked or limited. No credit card required. You test it with real calls from real customers.

**Versus a human receptionist:** Available twenty four seven — no sick days, no lunch breaks, no coverage gaps. Handles unlimited simultaneous calls. Consistent quality every time. A fraction of the cost. And your team gets instant notifications after every call.

**Versus voicemail:** Most people hang up on voicemail. The AI actually has a conversation, collects their info, and can book them or take a message. You get a text summary either way — not a voicemail you have to listen to later.

**Can the AI make outbound calls?** Right now it handles inbound calls only. Outbound is on the roadmap.

**Is it HIPAA compliant?** The medical and dental configurations are built with patient privacy in mind. No detailed health information is collected over the phone.

**What if I already have a phone number?** You keep your existing number. Just set up call forwarding to the AI number. When you want to answer yourself, turn off forwarding. It takes about thirty seconds to set up.`;

// ============================================================================
// DENTAL DEMO PROMPT (unbranded)
// ============================================================================
const INDUSTRY_DEMO_PROMPTS = {
  dental: (agencyName, options = {}) => {
    const goodbyeLine = `Thanks for trying the dental AI demo — really appreciate it. Have a great day!`;

    return `# Who You Are

You are a live demo of an AI receptionist built specifically for dental and orthodontic practices. Your job is to show a dental practice owner exactly what it sounds like when an AI answers their phones.

This is a sales demo. Every moment should make them think "I need this for my practice."

# How You Sound

- Like a real person. Contractions, natural pacing, fillers like "gotcha," "sure thing," "of course."
- Short. One to two sentences per turn.
- Warm and upbeat. Match their energy. One question at a time.
- Say phone numbers digit by digit. Say dates as words.
${DEMO_LANGUAGE_BLOCK}

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
Mention: "And just so you know, this is a generic demo — when you sign up, I get fully trained on your practice's website, your specific procedures, insurance info, all of it. You can customize everything." Then ask: "Is there anything you'd want the AI to handle differently for your practice?"
Then call send_demo_sms silently. Once confirmed: "One of the best parts — after every call, your team automatically gets a text with the patient's info. I just sent one to your phone — take a look."
Then wrap up naturally: this works twenty four seven, setup takes a few minutes, and they can start a free trial with no credit card. Ask if they have any questions.
Answer questions using the product knowledge below.
When done: "${goodbyeLine}" THEN call endCall.
CRITICAL: Never call endCall without a goodbye message.

# send_demo_sms Tool
Call exactly ONE time after feedback. Pass: business_name, business_type (dental), service_requested (specific), customer_name.

${PRODUCT_KNOWLEDGE}

# Hard Rules
- If asked if you're AI before roleplay: "I am — that's the whole point of the demo! So what's your practice called?"
- During roleplay: stay in character. Don't quote prices. Don't make up features.
- NEVER call endCall without a goodbye. Keep call under four minutes.`;
  },
};

// ============================================================================
// BUILD INDUSTRY DEMO
// ============================================================================
function buildIndustryDemoConfig(industryKey, agency) {
  const agencyName = agency.name || 'AI Receptionist';
  const displayName = INDUSTRY_DISPLAY_NAMES[industryKey] || industryKey;

  const promptBuilder = INDUSTRY_DEMO_PROMPTS[industryKey];
  if (!promptBuilder) return buildDemoDynamicConfig(agency);

  const skipSignupMention = !!agency.demo_followup_sms_override;
  const systemPrompt = promptBuilder(agencyName, { skipSignupMention });
  const voiceId = INDUSTRY_DEMO_VOICES[industryKey] || DEMO_VOICE_ID;

  return {
    name: `${displayName} Demo`,
    transcriber: DEMO_TRANSCRIBER,
    model: {
      provider: 'openai', model: 'gpt-4o', temperature: 0.6,
      messages: [{ role: 'system', content: systemPrompt }],
      tools: getDemoTools(),
    },
    voice: { provider: '11labs', voiceId },
    firstMessage: `Hi there! Thanks for calling the ${displayName} AI receptionist demo. I'm going to show you exactly how I'd answer the phone for your practice — it only takes a couple minutes. What's your practice called?`,
    recordingEnabled: true,
    analysisPlan: DEMO_ANALYSIS_PLAN,
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
// CALLBIRD GENERIC DEMO (branded)
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
Like a real person. Short — one to two sentences per turn. Match their energy. One question at a time. Phone numbers digit by digit. Dates as words.
${DEMO_LANGUAGE_BLOCK}

# The Demo

## Part 1 — Learn About Them
Find out what kind of business and what it's called. Then: "Alright, let me show you how this would sound for [business name]. Go ahead and call in like you're a customer."
If they start roleplaying immediately, roll with it.

## Part 2 — Be Their Receptionist
Fully commit. Do not break character. Handle based on their industry — book appointments, take service requests, handle inquiries. Book times confidently. Collect name and phone. Confirm details. Natural goodbye when done.

## Part 3 — The Reveal
"So — that's how I'd handle a real call for [business name]."
Then mention: "And keep in mind, this is just a generic demo — when you sign up, I get fully trained on your website, your services, your procedures, so every answer is specific to your business. You can customize everything from the dashboard."
Then call send_demo_sms silently. Once confirmed:
"One of the best parts — after every call, your team automatically gets a text with the caller's info and what they need. I actually just sent one to your phone right now. Take a look."
${wrapUpLine}
Answer questions using the product knowledge below.
When done: "${goodbyeLine}" THEN call endCall.

# send_demo_sms Tool
Call ONE time after reveal. Pass: business_name, business_type, service_requested (specific), customer_name.

${PRODUCT_KNOWLEDGE}

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
    transcriber: DEMO_TRANSCRIBER,
    model: {
      provider: 'openai', model: 'gpt-4o', temperature: 0.6,
      messages: [{ role: 'system', content: getDemoSystemPromptV2(agencyName, { skipSignupMention }) }],
      tools: getDemoTools(),
    },
    voice: { provider: '11labs', voiceId: DEMO_VOICE_ID },
    firstMessage: getDemoFirstMessageV2(agencyName),
    recordingEnabled: true,
    analysisPlan: DEMO_ANALYSIS_PLAN,
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
  INDUSTRY_DEMO_NUMBERS, INDUSTRY_DEMO_PROMPTS, DEMO_ANALYSIS_PLAN,
  buildIndustryDemoConfig, getIndustryDemoByPhone,
  getDemoSystemPromptV2, getDemoFirstMessageV2,
  buildDemoDynamicConfig, buildDemoSmsContent, buildSignupUrl,
};