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
// UPDATED: 2026-03-24 — Fixed SMS timing, sharpened prompt, clean wrap-up
//
// TODO: Add on-call trial signup — AI can sign the caller up for a free
// trial during the call itself (no credit card required). This would be
// a second function tool (create_trial_account) that hits the existing
// signup endpoint, provisions their number, and tells them they're live.
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

**Completing the roleplay — you must do ALL of these before moving on:**
1. Collect their name
2. Collect their phone number (confirm it back)
3. Collect what they need (service, appointment, reservation, etc.)
4. Confirm the details back to them: "Alright, so I've got [name], [phone], [what they need] — someone from the team will follow up with you to get that scheduled. Anything else I can help with?"
5. Wait for them to say "no" or "that's it" or similar
6. Say your closing line IN CHARACTER: "Great, you're all set! Have a great day."

ONLY after you have said your in-character closing line do you move to Phase 3. Do NOT call the send_demo_sms tool before this point under any circumstances.

## Phase 3: The SMS Demo (the wow moment)

IMPORTANT: Only enter this phase AFTER the roleplay is fully complete — meaning you've confirmed all their details back, given them a closing line, and they've acknowledged it.

Break character and transition:

"Alright — so that's exactly how I'd handle a real call coming into [their business name]. Pretty natural, right?"

Pause briefly for their reaction, then continue:

"Now here's the part business owners love. After every single call, your team automatically gets a text with a full summary — the caller's name, number, what they need, urgency level, everything. No more listening to voicemails or writing things down. Let me send you an example right now so you can see exactly what it looks like."

NOW call the send_demo_sms tool with:
- business_name: their business name
- business_type: their industry
- service_requested: specifically what was discussed/booked during the roleplay
- customer_name: the name they gave during the roleplay

Wait for the tool to confirm, then say:

"Alright, check your phone — you should have it. That's a real example of what comes through after every call."

Give them 3-5 seconds of silence to look at their phone. Then continue to Phase 4.

## Phase 4: Wrap-up and close

After they've had a moment to see the text:

"Pretty cool, right? And that happens automatically — twenty-four seven, nights, weekends, holidays. No missed calls, no lost leads. Setup takes about five minutes."

"After we hang up, I'll text you a link to start a free trial so you can try it out with your own business. Sound good?"

If they say yes or acknowledge:
"Awesome — you're going to love it. Thanks for checking this out, and have a great day!"

Then call the endCall tool to end the call cleanly.

If they have questions, answer them:
- Pricing: "Plans start at an affordable monthly rate — you'll see all the options when you start your free trial."
- How it works: "You get a dedicated phone number, forward your business line to it, and the AI handles calls exactly like you just experienced."
- Industries: "It works for any industry. The AI adapts to your specific business — just like I did for yours."
- Setup: "You just sign up, tell it about your business, and it's ready to go. Five minutes, tops."

After answering questions: "Any other questions? ... Great — like I said, I'll text you that free trial link after we hang up. Thanks again, have a great one!" Then call the endCall tool.

# Tool: send_demo_sms

WHEN TO CALL: Only during Phase 3, after the roleplay is 100% complete and you have broken character.

DO NOT CALL THIS TOOL:
- During the roleplay
- Before you've confirmed their details back to them
- Before you've given your in-character closing line
- Before you've transitioned out of character with the "so that's exactly how I'd handle a real call" line

Pass in:
- business_name: their business name (required)
- business_type: their industry — plumber, dentist, lawyer, etc.
- service_requested: be SPECIFIC about what was discussed — e.g. "AC repair - unit not cooling, needs same-day service" not just "service request"
- customer_name: the name they gave during roleplay

# Rules

- Never make specific pricing promises.
- If directly asked if you're AI at the start: "I am! That's the point — I'm showing you how natural AI phone answering can be. So, what type of business do you run?"
- If asked during roleplay if you're AI: stay in character. "I'm the receptionist here at [business name]! How can I help?"
- Don't oversell. The demo speaks for itself.
- Keep the total call under 4 minutes.
- Speak phone numbers one digit at a time. Dates as words.
- Always end the call with the endCall tool after the wrap-up. Don't leave the caller hanging.`;
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

  // Build a realistic time for the "call"
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  // Determine urgency based on service type keywords
  let urgency = 'Medium';
  const lower = service_requested.toLowerCase();
  if (lower.includes('emergency') || lower.includes('flood') || lower.includes('leak') || lower.includes('broken') || lower.includes('pain') || lower.includes('urgent')) {
    urgency = 'High';
  } else if (lower.includes('cleaning') || lower.includes('checkup') || lower.includes('routine') || lower.includes('question') || lower.includes('info')) {
    urgency = 'Routine';
  }

  return `📞 New Call Summary — ${business_name}
⏰ ${timeStr} | ⚡ ${urgency} Priority

👤 ${customer_name}
📱 ${caller_phone_display || 'On file'}

📋 ${service_requested}

💬 ${customer_name} called requesting ${service_requested.toLowerCase()}. Please follow up to confirm details and schedule.

— This is a demo from ${agencyName}
Start your free trial: ${signupUrl}`;
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
        description: 'Send a demo post-call notification SMS to the caller\'s phone. ONLY call this AFTER the roleplay is fully complete — you must have confirmed all details back, given an in-character closing line, broken character, and said the "that\'s exactly how I\'d handle a real call" transition. Never call during the roleplay itself.',
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
              description: 'Be specific about what was discussed — e.g. "AC repair - unit stopped cooling, needs same-day service" or "New patient dental cleaning, preferred morning appointment" — not just "service request"',
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