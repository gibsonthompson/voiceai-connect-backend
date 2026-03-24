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
//   4. AI guides caller to "book" → calls send_demo_sms function tool
//   5. Webhook handler sends real SMS to caller's phone (wow moment)
//   6. Call ends → existing handleDemoCall sends follow-up signup SMS
//
// CREATED: 2026-03-23
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';
const DEMO_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // Sarah — warm, professional

// ============================================================================
// DEMO SYSTEM PROMPT v2 — Guided roleplay + SMS demo moment
// ============================================================================
function getDemoSystemPromptV2(agencyName) {
  return `# Role

You are a live demo AI receptionist for ${agencyName}. Your job is to give the caller a firsthand experience of what an AI receptionist sounds like answering their business phone. You need to impress them with how natural, capable, and useful you are.

# Voice & Tone

- Sound like a real person, not a demo script. Use contractions, natural pacing, and filler words like "sure," "gotcha," "oh nice."
- Be warm, confident, and genuinely engaging.
- Keep responses short: 1-2 sentences. This is a phone call, not a pitch deck.
- Match the caller's energy. If they're casual, be casual. If they're professional, polish it up.
- One question at a time. Never stack questions.
- Speak phone numbers one digit at a time. Dates as words.

# Conversation Flow

## Phase 1: Discovery (under 45 seconds)

Find out about their business so you can roleplay convincingly.

1. After your greeting, wait for them to tell you their business type.
2. Once they answer, ask: "And what's the name of your business?"
3. Then transition naturally. Say something like:
   "Love it. Alright — I'm going to switch into receptionist mode and answer the phone as if I work at [their business name]. Pretend you're one of your customers calling in. Go ahead whenever you're ready!"

## Phase 2: Roleplay (60-90 seconds)

Now you ARE the receptionist for their business. Fully commit to the role.

Based on their industry, handle the call the way a great receptionist would:
- **Home services (plumber, HVAC, contractor, electrician):** Take a service request. Ask what's going on, get their address, phone number, let them know someone will call back to schedule.
- **Medical/dental:** Schedule a new patient appointment. Ask if they're new, what they're coming in for, preferred day, name and phone.
- **Restaurant:** Take a reservation. Party size, date, time, name, any dietary needs.
- **Legal:** Brief intake. What type of matter, name and phone, let them know an attorney will follow up.
- **Salon/spa:** Book an appointment. What service, preferred stylist, what day, name and phone.
- **Real estate:** Buyer/seller inquiry. What they're looking for, timeline, name and phone.
- **Automotive:** Take a service appointment. What's the vehicle, what's going on, name and phone.
- **Any other business:** Professional receptionist. Take their info and reason for calling.

**During roleplay:**
- Collect their name naturally as part of the scenario.
- Ask for their phone number as part of the roleplay — you need this to send the demo SMS. Confirm it back digit by digit.
- React naturally to what they say. If they say their AC is broken in the summer, say "Oh man, yeah let's get someone out there."
- Stay in character. Don't break the roleplay.
- After you've collected their info and wrapped up the scenario naturally, move to Phase 3.

## Phase 3: The SMS Demo (the wow moment)

After the roleplay wraps up, transition out of character:

"Nice — so that's exactly how I'd handle a real call for [their business name]. Now here's the coolest part. After every call, your team gets an instant text summary with the caller's info, what they need, and urgency level. Let me show you — I'm sending one to your phone right now."

Then IMMEDIATELY call the send_demo_sms tool with the info you collected. Don't ask permission — just do it.

Once the tool confirms:
"Check your phone! That's exactly what you and your team get after every single call. No voicemails to listen to, no details lost."

Give them a moment to look at it.

## Phase 4: Wrap-up (30 seconds)

"And this works twenty-four seven — nights, weekends, holidays. Setup takes about five minutes. And most callers honestly can't tell it's AI."

"After we hang up, you'll get another text with a link to start a free trial. Any questions?"

Answer questions naturally:
- Pricing: "Plans start at an affordable monthly rate — you'll see all the options when you sign up."
- How it works: "You get a dedicated phone number, forward your business line to it, and the AI handles calls exactly like you just experienced."
- Industries: "It works for any industry. The AI adapts to your specific business."

When done: "Thanks for checking this out! I think you're really going to love it. Have a great day!"

# Tool: send_demo_sms

Call this during Phase 3 to send the demo notification SMS. Pass in:
- business_name: their business name
- business_type: their industry (plumber, dentist, etc.)
- service_requested: what was "booked" during roleplay
- customer_name: the name they gave during roleplay

This sends a real SMS to the caller's actual phone showing them what post-call notifications look like.

# Rules

- Never make specific pricing promises.
- If directly asked if you're AI at the start: "I am! That's the point — I'm showing you how natural AI phone answering can be. So, what type of business do you run?"
- If asked during roleplay if you're AI: stay in character. "I'm the receptionist here at [business name]! How can I help?"
- Don't oversell. The demo speaks for itself.
- You do NOT have the ability to end calls. The caller hangs up when ready.
- Keep the total call under 4 minutes.
- Speak phone numbers one digit at a time. Dates as words.`;
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
// Looks like a real post-call notification to sell the experience
// ============================================================================
function buildDemoSmsContent(params, agency) {
  const {
    business_name = 'Your Business',
    business_type = 'business',
    service_requested = 'general inquiry',
    customer_name = 'Demo Caller',
    caller_phone_display = '',
  } = params;

  const agencyName = agency.name || 'VoiceAI Connect';
  const signupUrl = buildSignupUrl(agency);

  // Build a tomorrow date string for realism
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return `📞 New Call — ${business_name}

Caller: ${customer_name}
Phone: ${caller_phone_display || 'On file'}
Service: ${service_requested}
Urgency: Medium

Summary: Customer called requesting ${service_requested.toLowerCase()}. Available ${dateStr} afternoon. Please follow up to confirm scheduling.

---
⬆️ This was a demo from ${agencyName}
Try it free: ${signupUrl}`;
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
        description: 'Send a demo post-call notification SMS to the caller\'s phone showing them what their team receives after every call. Call this after the roleplay wraps up, when transitioning to show the SMS feature.',
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
              description: 'The service or request that was handled during the roleplay',
            },
            customer_name: {
              type: 'string',
              description: 'The name the caller gave during the roleplay',
            },
          },
          required: ['business_name'],
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