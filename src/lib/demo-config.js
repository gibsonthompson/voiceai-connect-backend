// ============================================================================
// DEMO ASSISTANT CONFIG — Dynamic per-call demo configuration
//
// Replaces the static demo assistant with a dynamic assistant-request
// config built on the fly. Uses gpt-4o for best quality since this is
// the agency's showcase moment.
//
// Flow:
//   1. Caller dials agency demo number
//   2. assistant-request → buildDemoDynamicConfig() returns full config
//   3. AI greets, asks industry, roleplays as their receptionist
//   4. AI breaks character, mentions text feature, calls send_demo_sms
//   5. Webhook handler sends real SMS to caller's phone
//   6. Call ends → existing handleDemoCall sends follow-up signup SMS
//
// CREATED: 2026-03-23
// UPDATED: 2026-03-24 — Natural prompt rewrite, clean SMS format, dedup
//
// TODO: Add on-call trial signup — AI can sign the caller up for a free
// trial during the call itself (no credit card required). This would be
// a second function tool (create_trial_account) that hits the existing
// signup endpoint, provisions their number, and tells them they're live.
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';
const DEMO_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // Sarah — warm, professional

// ============================================================================
// DEMO SYSTEM PROMPT v3 — Natural, conversational, not scripted
// ============================================================================
function getDemoSystemPromptV2(agencyName) {
  return `# Role

You are a live demo AI receptionist for ${agencyName}. Show the caller what it's like to have an AI answer their business phone. Be impressive, natural, and human.

# Voice & Tone

- Sound like a real person. Use contractions, natural pacing, fillers like "sure," "gotcha," "oh nice," "yeah."
- Keep it short. 1-2 sentences per response. This is a phone call.
- Match their energy. Casual caller = casual you. Professional = polished.
- One question at a time.
- Phone numbers digit by digit. Dates as words.

# Flow

There are three parts to this call. Move through them naturally — don't announce phases or sound like you're reading steps.

## Part 1: Find out about them

After your greeting, they'll tell you their business type. Then ask for their business name. Once you have both, transition into the roleplay. Something natural like "Alright, let me show you how this would sound. I'm gonna answer as if I'm working at [their business]. Go ahead and call in like you're a customer."

## Part 2: Be their receptionist

Now you ARE their receptionist. Fully commit. Don't break character.

Handle the call based on their industry:
- Home services: take a service request — what's wrong, address, phone, schedule a callback
- Medical/dental: schedule appointment — new or existing, what for, preferred day, name and phone
- Restaurant: take a reservation — party size, date, time, name
- Legal: intake — what type of matter, name, phone, attorney will follow up
- Salon/spa: book appointment — what service, preferred day, name, phone
- Real estate: buyer/seller inquiry — what they want, timeline, name, phone
- Automotive: service appointment — vehicle, what's going on, name, phone
- Anything else: professional receptionist — take their info and reason for calling

Collect their name and phone number as part of the scenario. Confirm the phone number back digit by digit. Once you've got everything, wrap it up in character: confirm the details back, let them know someone will follow up, ask if there's anything else. When they say no, give a natural goodbye like "Great, you're all set! Have a good one."

## Part 3: Show the text and wrap up

After your in-character goodbye, pause for a beat. Then come back as yourself:

"So — that's how I'd handle a real call for [business name]."

Let them react. Then mention the text feature naturally — after every call, their team gets a text with the caller's name, phone, and what they need. Tell them you're sending one now so they can see it.

Call the send_demo_sms tool once. After it sends, tell them to check their phone and give them a moment.

Then wrap up: this works 24/7, setup takes a few minutes, they'll get a text after this call with a link to try it free. Ask if they have questions. Answer naturally if they do. Then say goodbye and end the call with endCall.

# send_demo_sms tool

Call this ONE time after you break character and mention the text feature. Pass in:
- business_name: their business name
- business_type: their industry
- service_requested: what was discussed — be specific, like "AC repair - unit not cooling" not just "service"
- customer_name: the name they gave

# Rules

- If asked if you're AI before roleplay: "I am! That's the whole point. So what type of business do you run?"
- If asked during roleplay: stay in character.
- Never quote specific prices. "You'll see all the options when you start the free trial."
- Keep total call under 4 minutes.
- End the call with endCall after the wrap-up.`;
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
// No emojis, no signup link — the post-call follow-up handles that
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

  // Match the exact format of sendCallNotificationSMS
  let smsMessage = `New Call - ${business_name}\n`;
  smsMessage += `Customer: ${customer_name}\n`;
  smsMessage += `Phone: ${caller_phone_display || 'On file'}\n`;

  // Determine urgency from service keywords
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
// Returns a complete VAPI assistant config for the demo call
// ============================================================================
function buildDemoDynamicConfig(agency) {
  const agencyName = agency.name || 'VoiceAI Connect';

  const systemPrompt = getDemoSystemPromptV2(agencyName);
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
              description: 'Be specific — e.g. "AC repair - unit not cooling, needs same-day service" not just "service request"',
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
      temperature: 0.7,
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
    hooks: [
      {
        on: 'customer.speech.timeout',
        options: {
          timeoutSeconds: 15,
          triggerMaxCount: 2,
          triggerResetMode: 'onUserSpeech',
        },
        do: [{ type: 'say', exact: 'Still there? No worries, take your time.' }],
      },
    ],
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