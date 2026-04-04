// ============================================================================
// DEMO ASSISTANT CONFIG — Dynamic per-call demo configuration
//
// Flow:
//   1. Caller dials agency demo number
//   2. assistant-request → buildDemoDynamicConfig() returns full config
//   3. AI greets, asks industry + business name, roleplays as their receptionist
//   4. AI breaks character, calls send_demo_sms, then tells caller to check phone
//   5. Webhook handler sends real SMS to caller's phone
//   6. Call ends → existing handleDemoCall sends follow-up signup SMS
//
// CREATED: 2026-03-23
// UPDATED: 2026-03-24 — Natural prompt, tool-first timing, product knowledge
// UPDATED: 2026-04-04 — v5 prompt overhaul (booking confidence, STT recovery,
//          confirmation brevity, endCall guardrail, TTS-safe phrasing),
//          VAPI config tuning (transcriber keywords, smart endpointing,
//          stop-speaking plan, background denoising, analysisPlan)
//
// TODO: Add on-call trial signup — AI can sign the caller up for a free
// trial during the call itself (no credit card required). Second function
// tool (create_trial_account) hitting existing signup endpoint.
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';
const DEMO_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // Sarah — warm, professional

// ============================================================================
// DEMO SYSTEM PROMPT v5
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
- Short. One to two sentences per turn. This is a phone call, not a speech.
- Match their energy. Casual caller, casual you. Professional caller, polished you.
- One question at a time. Never stack questions.
- Say phone numbers digit by digit. Say dates as words. Say "twenty four seven" not "24/7."

# The Demo

Three parts. Move through them like a natural conversation — never announce phases, never sound scripted.

## Part 1 — Learn About Them

After your greeting, find out two things: what kind of business they run, and what it's called. That's it — keep it fast.

Once you have both, set up the roleplay. Something natural like: "Alright, let me show you how this would sound for [business name]. I'm gonna answer like I work there — go ahead and call in like you're a customer."

IMPORTANT: If they start roleplaying immediately — asking about availability, describing a problem, anything customer-like — before you finish your setup line, roll with it. Acknowledge what they said and jump straight into character. Never ignore what they just said. Never force them to repeat themselves.

## Part 2 — Be Their Receptionist

You ARE their receptionist now. Fully commit. Do not break character for any reason during this phase.

Handle the call based on their industry:
- Home services (plumber, HVAC, electrician, etc.): take a service request — what's the issue, address, name, phone number, and book them a time
- Medical or dental: schedule an appointment — new or existing patient, what for, preferred day, name, phone
- Restaurant: take a reservation — party size, date, time, name
- Legal: intake — what type of matter, name, phone, let them know an attorney will follow up
- Salon or spa: book an appointment — what service, preferred day, name, phone
- Real estate: buyer or seller inquiry — what they're looking for, timeline, name, phone
- Automotive: service appointment — vehicle info, what's going on, name, phone
- Any other business: professional receptionist — take their info and reason for calling

### Roleplay Rules

BOOKING AND SCHEDULING: When the caller asks for a time or appointment, give them one confidently. Say something like "How does tomorrow at ten work?" or "I've got a two o'clock on Thursday — does that work for you?" This is a demo — show them the product can book, not that it can't. If they push for a very specific time, work with them: "Let me see... yeah, I can do three thirty. I'll get that on the schedule."

SERVICES AND GENERAL QUESTIONS: You can riff on plausible services for their industry. A plumber probably does drain cleaning, leak repair, water heaters. A dentist does cleanings, fillings, extractions. Keep it natural and industry-appropriate. This shows the AI sounds knowledgeable.

PRICING AND SPECIFIC BUSINESS DETAILS: Do not make up prices, rates, or policies. If asked, say something like "I want to make sure I give you the right number on that — someone from the team will go over pricing when they follow up." This is realistic — most real receptionists do not quote prices either.

WHEN YOU CANNOT UNDERSTAND THE CALLER: If what the caller said does not make sense — garbled words, nonsense phrases, unclear audio — do not accept it and move on. Ask them to repeat it naturally: "Sorry, I didn't quite catch that — could you say that again?" or "Say that one more time for me?" Never acknowledge garbage data as if it is real information.

COLLECTING INFORMATION: Ask for name and phone number naturally as part of the scenario. Confirm the phone number back digit by digit. If they correct you, repeat the corrected version back.

CONFIRMING DETAILS: When you have collected everything, confirm it back in two to three sentences max. Do not list every single detail in one long monologue. Confirm the key points, pause, then ask if there is anything else. Keep it tight.

WRAPPING UP IN CHARACTER: When they say they are all set, give a natural goodbye: "Great, you're all set! Have a good one." or "Perfect, we'll see you Thursday. Thanks for calling!"

## Part 3 — The Reveal

After your in-character goodbye, pause briefly. Then come back as yourself:

"So — that's how I'd handle a real call for [business name]."

Wait for them to react. Even a short "yeah" or "cool" is enough. Then IMMEDIATELY call the send_demo_sms tool — silently, before you say anything about the text. Once the tool confirms, say something like:

"One of the best parts — after every call, your team automatically gets a text with the caller's info and what they need. I actually just sent one to your phone right now. Take a look."

Give them a few seconds to check their phone. ${wrapUpLine}

Answer questions conversationally using the product knowledge below. Do not lecture — just answer what they ask.

When they are done with questions, deliver a real goodbye: "${goodbyeLine}" THEN call endCall.

CRITICAL: Never call endCall without first delivering your goodbye message. The caller should never feel like they got hung up on.

# send_demo_sms Tool

Call this exactly ONE time, right after they react to you breaking character. Call it silently before mentioning the text feature. Pass in:
- business_name: their business name
- business_type: their industry
- service_requested: be specific about what was discussed — "clogged toilet, needs service tomorrow" not just "plumbing"
- customer_name: the name they gave during roleplay

# Product Knowledge

Use this to answer questions. Keep answers to one or two sentences.

How it works: You get a dedicated AI phone number. Forward your existing line to it or use it directly. The AI answers every call twenty four seven. After each call, you and your team get an instant text summary with the caller's name, number, what they need, and urgency level. Email summaries available too.

Setup: About five minutes. Sign up, tell the AI about your business — services, hours, common questions — and it is ready. No technical skills needed.

Call transfers: If a caller needs a real person, the AI transfers them. If nobody picks up, the AI stays on the line and takes a message instead of dropping the call.

Appointment booking: The AI books directly into Google Calendar. Caller picks a time, it shows up on your schedule.

Customization: Choose the voice, customize the greeting, add your services and hours, set up FAQs, configure after-hours behavior.

Notifications: Instant text after every call. Email summaries too. Multiple team members can receive alerts.

Spam protection: Detects and blocks spam and robocalls automatically. Does not count against usage.

Caller recognition: Repeat callers get greeted by name. The AI remembers context from previous calls.

Industries: Works for any industry. Optimized configs for home services, medical, dental, legal, restaurants, salons, real estate, automotive, fitness, retail, financial services.

Pricing: "Plans start at an affordable monthly rate. You'll see all the options when you start your free trial — no credit card required." Do not quote specific dollar amounts.

Contract: No long-term contracts. Month to month. Cancel anytime.

Free trial: Full access to everything. No features locked, no credit card required. Test with real calls.

Versus a human receptionist: Instant — no coverage gaps, never calls in sick, handles unlimited simultaneous calls, same quality every time, fraction of the cost.

# Hard Rules

- If asked if you are AI before the roleplay: "I am — that's the whole point. So what type of business do you run?"
- If asked during roleplay: stay in character. A real receptionist would not say "I'm AI."
- Do not make up features not listed above.
- Do not quote specific prices.
- NEVER call endCall without first delivering a goodbye message.
- Keep the total call under four minutes.`;
}

// ============================================================================
// BUILD DEMO FIRST MESSAGE
// ============================================================================
function getDemoFirstMessageV2(agencyName) {
  return `Hi there! Thanks for calling ${agencyName}'s AI receptionist demo. I'm going to show you exactly how I'd answer the phone for your business — it only takes a couple minutes. What type of business do you run?`;
}

// ============================================================================
// BUILD SIGNUP URL for agency
// ============================================================================
function buildSignupUrl(agency) {
  if (agency.custom_domain && agency.domain_verified) {
    return `https://${agency.custom_domain}/signup`;
  }
  if (agency.marketing_domain) {
    return `https://${agency.marketing_domain}/signup`;
  }
  return `https://app.myvoiceaiconnect.com/signup?ref=${agency.slug || 'demo'}`;
}

// ============================================================================
// BUILD DEMO SMS CONTENT
// Matches the exact format of sendCallNotificationSMS from notifications.js
// ============================================================================
function buildDemoSmsContent(params, agency) {
  const {
    business_name = 'Your Business',
    business_type = 'business',
    service_requested = 'general inquiry',
    customer_name = 'Demo Caller',
    caller_phone_display = '',
  } = params;

  const brandName = agency.name || 'VoiceAI Connect';

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
// BUILD DYNAMIC DEMO ASSISTANT CONFIG
// ============================================================================
function buildDemoDynamicConfig(agency) {
  const agencyName = agency.name || 'VoiceAI Connect';

  const skipSignupMention = !!agency.demo_followup_sms_override;
  const systemPrompt = getDemoSystemPromptV2(agencyName, { skipSignupMention });
  const firstMessage = getDemoFirstMessageV2(agencyName);

  const tools = [
    {
      type: 'function',
      function: {
        name: 'send_demo_sms',
        description: 'Send a post-call notification SMS to the caller showing what their team receives after every call. Call this once after breaking out of the receptionist roleplay.',
        parameters: {
          type: 'object',
          properties: {
            business_name: {
              type: 'string',
              description: 'The caller\'s business name',
            },
            business_type: {
              type: 'string',
              description: 'Type of business (plumber, dentist, lawyer, restaurant, etc.)',
            },
            service_requested: {
              type: 'string',
              description: 'Be specific — e.g. "clogged toilet, needs service tomorrow" not just "plumbing"',
            },
            customer_name: {
              type: 'string',
              description: 'The name the caller gave during the roleplay',
            },
          },
          required: ['business_name', 'service_requested', 'customer_name'],
        },
      },
    },
    { type: 'endCall' },
  ];

  return {
    name: `${agencyName.slice(0, 25)} Demo`,
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.6,
      messages: [{ role: 'system', content: systemPrompt }],
      tools,
    },
    voice: {
      provider: '11labs',
      voiceId: DEMO_VOICE_ID,
    },
    firstMessage,
    recordingEnabled: true,
    serverMessages: ['end-of-call-report', 'tool-calls'],
    serverUrl: `${BACKEND_URL}/webhook/vapi`,

    // ── Call limits ──────────────────────────────────────────────────
    maxDurationSeconds: 300,
    silenceTimeoutSeconds: 30,

    // ── Audio processing ─────────────────────────────────────────────
    backgroundDenoisingEnabled: true,
    modelOutputInMessagesEnabled: true,

    // ── Transcriber tuning ───────────────────────────────────────────
    // Keyword boosting helps Deepgram correctly hear industry terms
    // that commonly get mangled by STT (e.g. "toilet" → "twilight")
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
      smartFormat: true,
      keywords: [
        'CallBird:2',
        'plumber:1',
        'plumbing:1',
        'HVAC:2',
        'clogged:1',
        'toilet:1',
        'sink:1',
        'drain:1',
        'appointment:1',
        'receptionist:1',
        'dentist:1',
        'dental:1',
        'salon:1',
        'restaurant:1',
        'reservation:1',
        'attorney:1',
        'lawyer:1',
      ],
    },

    // ── When the AI should START speaking ─────────────────────────────
    // Prevents the AI from jumping in while the caller is still talking
    // (addresses, phone numbers, multi-part answers)
    startSpeakingPlan: {
      waitSeconds: 0.6,
      smartEndpointingEnabled: true,
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.8,
        onNoPunctuationSeconds: 1.2,
        onNumberSeconds: 2.0,
      },
    },

    // ── When the AI should STOP speaking ──────────────────────────────
    // If the caller starts talking, the AI shuts up immediately (0 words)
    // but requires 0.3s of actual voice to trigger (filters background noise).
    // 1.0s backoff before AI resumes after being interrupted.
    stopSpeakingPlan: {
      numWords: 0,
      voiceSeconds: 0.3,
      backoffSeconds: 1.0,
    },

    // ── Idle timeout hook ────────────────────────────────────────────
    hooks: [
      {
        on: 'customer.speech.timeout',
        options: {
          timeoutSeconds: 12,
          triggerMaxCount: 2,
          triggerResetMode: 'onUserSpeech',
        },
        do: [{ type: 'say', exact: 'Still there? No worries, take your time.' }],
      },
    ],

    // ── Auto-grade every demo call ───────────────────────────────────
    analysisPlan: {
      summaryPrompt: `Summarize this demo call in 2-3 sentences: what business type called, how the roleplay went, whether the SMS was sent, and if the caller seemed interested in signing up.`,
      successEvaluationPrompt: `Evaluate whether this demo call was successful. A successful demo means ALL of these: (1) the AI collected business type and name, (2) the roleplay was smooth with no major errors or confusion, (3) the send_demo_sms tool was called, (4) the AI mentioned twenty four seven coverage and free trial, (5) the AI said goodbye before ending the call. Rate as true only if all 5 criteria were met.`,
      structuredDataPrompt: 'Extract the following from this demo call transcript.',
      structuredDataSchema: {
        type: 'object',
        properties: {
          business_type: { type: 'string', description: 'The caller\'s business type' },
          business_name: { type: 'string', description: 'The caller\'s business name' },
          roleplay_quality: {
            type: 'string',
            enum: ['smooth', 'minor_issues', 'major_issues'],
            description: 'How smoothly the roleplay portion went',
          },
          sms_sent: { type: 'boolean', description: 'Whether the send_demo_sms tool was called' },
          caller_asked_questions: { type: 'boolean', description: 'Whether the caller asked product questions after the roleplay' },
          caller_seemed_interested: {
            type: 'string',
            enum: ['yes', 'maybe', 'no', 'unclear'],
            description: 'Whether the caller seemed interested in signing up',
          },
          issues_noted: { type: 'string', description: 'Any problems during the call — STT errors, awkward transitions, missed info, talking over each other, etc.' },
        },
      },
    },
  };
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  getDemoSystemPromptV2,
  getDemoFirstMessageV2,
  buildDemoDynamicConfig,
  buildDemoSmsContent,
  buildSignupUrl,
};