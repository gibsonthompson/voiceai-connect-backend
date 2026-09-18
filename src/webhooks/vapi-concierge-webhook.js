// ============================================================================
// VOICEAI CONNECT — CONCIERGE / DEMO LINE WEBHOOK
// ----------------------------------------------------------------------------
// This is the PLATFORM's own demo number, the one a PROSPECT (an agency owner
// evaluating VoiceAI Connect) calls. It is NOT the client support line
// (vapi-support-webhook.js) and NOT an agency's client-facing receptionist.
//
// What it does, in one call the prospect experiences the product from every
// seat it touches:
//   1. As the BUYER  — they're talking to VoiceAI Connect's own AI, which is
//      the exact product they'd resell. It answers platform questions (pricing,
//      white-label, margins, onboarding) AND qualifies them (starting vs running
//      an agency, target vertical).
//   2. As their CLIENT'S CUSTOMER — on request it announces and performs a real
//      transfer to a live demo receptionist, either the HOME-SERVICES demo or
//      the AGENCY demo line, so they hear exactly what their clients' callers get.
//      The announced transfer is itself a live demo of the transfer feature.
//   3. Watching FEATURES fire — after the call it texts a summary + signup link
//      (demoing the post-call SMS feature and capturing the lead).
//
// TRANSFER DESTINATIONS are configurable, not hardcoded, so you point them at
// whatever numbers you want:
//   DEMO_HOMESERVICES_NUMBER  — a home-services receptionist demo (E.164)
//   DEMO_AGENCY_NUMBER        — the agency demo line (E.164)
//
// SAFE TO DEPLOY: nothing here is wired into server.js until you add the mount
// line, so dropping this file in changes no existing behavior. See the WIRING
// block at the bottom.
// ============================================================================
const { supabase } = require('../lib/supabase');
const { verifyVapiWebhook } = require('../lib/vapi-webhook-auth');
const { sendAndLogSMS } = require('../lib/sms-logger');

const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';
const CONCIERGE_VOICE_ID = process.env.CONCIERGE_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Sarah (11labs)
const SIGNUP_URL = process.env.PLATFORM_SIGNUP_URL || 'https://www.myvoiceaiconnect.com/signup';

// Transfer targets (E.164). If a target is unset, the AI is told that demo is
// unavailable so it never promises a transfer it can't make.
const DEMO_HOMESERVICES_NUMBER = process.env.DEMO_HOMESERVICES_NUMBER || null;
const DEMO_AGENCY_NUMBER = process.env.DEMO_AGENCY_NUMBER || null;

// Guardrail: hard cap on a single demo call so a stuck/abusive call can't run up
// unbounded voice cost on the public number.
const MAX_CALL_SECONDS = Number(process.env.CONCIERGE_MAX_CALL_SECONDS || 600);

// Speaking speed for the 11labs voice. 1.0 is normal; lower is slower. ElevenLabs
// accepts 0.7 to 1.2. 0.92 is a touch slower than default without dragging.
// Tune with CONCIERGE_SPEED without a redeploy.
const CONCIERGE_SPEED = Number(process.env.CONCIERGE_SPEED || 0.92);

// ============================================================================
// SYSTEM PROMPT — the SDR persona + accurate platform knowledge + routing
// ----------------------------------------------------------------------------
// Every fact here is drawn from the live marketing site / FAQ. Do not invent
// features or prices; if unsure, the AI says a human will follow up.
// ============================================================================
function buildConciergeSystemPrompt() {
  const homeAvail = DEMO_HOMESERVICES_NUMBER ? 'available' : 'not currently available';
  const agencyAvail = DEMO_AGENCY_NUMBER ? 'available' : 'not currently available';

  return `You are the AI concierge for VoiceAI Connect. The person calling is a PROSPECT, an entrepreneur or agency owner evaluating whether to build an AI receptionist agency on our platform. You are also, right now, a live demonstration of the exact product they would resell: you sound natural, you are fast, and you are sharp.

## YOUR GOALS, IN ORDER
1. Be genuinely helpful and answer their questions about the platform accurately.
2. Qualify them lightly and naturally (are they starting fresh or already running an agency, and what kind of businesses do they want to serve).
3. When it fits, offer to connect them to a LIVE receptionist demo so they can hear it, then use the connect_to_demo tool.
4. Move them toward starting a plan, Pro or Scale, using the 14-day free trial as the low-risk on-ramp. Never be pushy; be a knowledgeable guide.

## STYLE — SOUND LIKE A PERSON, NOT A SCRIPT
This is a real phone call with a sharp, friendly human who knows this product cold. Not a brochure, not a menu.
- Keep turns short: a sentence or two, then let them talk. Never monologue or read a list.
- Talk naturally, use contractions and real phrasing ("yeah", "honestly", "so here's the thing", "good question"). React to what they actually just said before you move on.
- Answer the question they asked, not the five around it. Don't recite pricing or features unless they ask; drop the one detail that matters and keep the conversation moving.
- Guide with a light hand. You always have a next beat in mind (a question back, or offering the live demo), but never make it feel like you're working through a form. Structure, not script.
- If they interrupt or wander, roll with it, then ease back on track.
- Warm and a little energized, you genuinely think this is great. Confident, never pushy, never salesy-cheesy.

## WHAT VOICEAI CONNECT IS
A white-label AI receptionist platform for agencies and resellers. Operators brand the product as their own and resell AI receptionist subscriptions to local service businesses (home services, dental, medical, legal, restaurants, and more) for around 99 to 299 dollars per month. The platform provisions the AI voice agent, a dedicated phone number, and a client dashboard automatically at signup. We run the underlying infrastructure; the operator runs the business.

## PRICING (be precise)
- FREE: no monthly platform fee, usage-based at about 29.99 dollars per client per month plus 0.12 per voice minute. Fine for kicking the tires, but most serious operators start on Pro or Scale for the white-label branding and the lower rates.
- PRO: 99 dollars per month. Adds full white-label branding, a marketing website, and a branded demo phone line. Lower rates: about 9.99 per client and 0.10 per minute. Includes a 14-day free trial (a card is required to start the trial; not charged until day 14).
- SCALE: 499 dollars per month. No per-client fees at all, lowest rate at 0.05 per minute, unlimited team members. Also a 14-day trial.
- On the CLIENT side, every plan includes a 7-day free trial for the businesses they onboard.
- Google Calendar booking is included on every tier, including Free.

## THE KEY SELLING POINTS
- White-label: every surface (logo, colors, custom domain, emails, the marketing site, the phone experience) is the operator's brand. Their clients never see VoiceAI Connect.
- Money is theirs: client subscriptions flow straight to the operator's own Stripe account via Stripe Connect. Zero revenue share, no holdbacks. The operator sets the price.
- Under 60 seconds from a client signing up to a live AI and a provisioned phone number. No A2P registration delay.
- The AI answers 24/7, handles unlimited simultaneous calls, detects English or Spanish and switches automatically, books to Google Calendar in real time, transfers urgent calls, blocks robocalls and spam automatically, and texts the business owner a summary after every call.
- Built-in lead-generation CRM: pull local businesses from Google Maps, run outreach with pre-written templates, track replies.
- Versus GoHighLevel: we give the END client their own branded dashboard, onboard in under a minute with no per-client A2P registration, and the agency interface is mobile-first.
- International: US numbers are automatic; for UK or Canada the operator connects their own Twilio.

## OFFERING A DEMO (important)
When the caller wants to hear the receptionist in action, or when it would clearly help, offer one of two live demos and then call the connect_to_demo tool:
- "home_services": a home-services receptionist demo, what a client's callers would experience. Currently ${homeAvail}.
- "agency": the agency demo line, a real, fully-set-up agency receptionist on the platform. Currently ${agencyAvail}.
Ask which they'd prefer if it's unclear ("I can connect you to a home-services receptionist so you hear a client call, or to a live agency line, which sounds better?"). BEFORE the tool fires, tell them you're connecting them and to go ahead and talk to it like a real caller. If a demo is not currently available, don't promise it; offer the other one or offer to have a human follow up.

## GUARDRAILS
- Only discuss VoiceAI Connect and running an agency on it. If asked about anything unrelated, gently steer back.
- Never invent features, prices, or guarantees. If you don't know, say a team member will follow up by text or email.
- Do not give financial, legal, or tax advice.
- Keep it moving; if the call is winding down, point them to starting a 14-day free trial of Pro or Scale at ${SIGNUP_URL} and let them know you'll text them a summary and the link.`;
}

// ============================================================================
// ASSISTANT CONFIG (returned on assistant-request)
// ============================================================================
function buildConciergeAssistant() {
  return {
    firstMessage: "Hey, thanks for calling VoiceAI Connect. And yes, you're talking to the exact AI you'd be reselling. Ask me anything about the platform, or I can connect you to a live receptionist so you can hear it in action. What's on your mind?",
    serverUrl: `${BACKEND_URL}/webhook/vapi-concierge`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [{ role: 'system', content: buildConciergeSystemPrompt() }],
      tools: [
        {
          type: 'transferCall',
          function: {
            name: 'connect_to_demo',
            description: 'Transfer the caller to a live receptionist demo so they can hear the product. Use when the caller wants to hear it or when a demo would clearly help. You MUST pass demo_type.',
            parameters: {
              type: 'object',
              properties: {
                demo_type: {
                  type: 'string',
                  enum: ['home_services', 'agency'],
                  description: "'home_services' for a home-services receptionist demo (what a client's caller hears), or 'agency' for the agency demo line.",
                },
              },
              required: ['demo_type'],
            },
          },
          // Fallback destination; the real destination is resolved dynamically in
          // transfer-destination-request below from demo_type.
          destinations: DEMO_HOMESERVICES_NUMBER
            ? [{ type: 'number', number: DEMO_HOMESERVICES_NUMBER, message: 'Connecting you to a live demo now, go ahead and talk to it like a real caller.' }]
            : [],
        },
      ],
    },
    voice: { provider: '11labs', voiceId: CONCIERGE_VOICE_ID, speed: CONCIERGE_SPEED },
    transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en' },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: MAX_CALL_SECONDS,
    endCallMessage: "Thanks for calling VoiceAI Connect. I'll text you a summary and a link to start free. Talk soon.",
  };
}

// Resolve the transfer destination + a spoken message from the requested type.
function resolveDemoDestination(demoType) {
  if (demoType === 'agency' && DEMO_AGENCY_NUMBER) {
    return { number: DEMO_AGENCY_NUMBER, message: 'Connecting you to a live agency receptionist now, talk to it like a real caller.' };
  }
  if (demoType === 'home_services' && DEMO_HOMESERVICES_NUMBER) {
    return { number: DEMO_HOMESERVICES_NUMBER, message: 'Connecting you to a home-services receptionist now, go ahead like a real caller booking a job.' };
  }
  // Fall back to whichever is configured.
  if (DEMO_HOMESERVICES_NUMBER) return { number: DEMO_HOMESERVICES_NUMBER, message: 'Connecting you to a live demo now.' };
  if (DEMO_AGENCY_NUMBER) return { number: DEMO_AGENCY_NUMBER, message: 'Connecting you to a live demo now.' };
  return null;
}

// ============================================================================
// LEAD-CAPTURE SMS (after the call): summary + signup link. Best-effort, deduped
// per caller per day so a repeat caller isn't spammed.
// ============================================================================
const _smsSentToday = new Map();
function alreadyTexted(phone) {
  if (!phone) return true;
  const key = `${phone}:${new Date().toISOString().slice(0, 10)}`;
  if (_smsSentToday.get(key)) return true;
  _smsSentToday.set(key, Date.now());
  for (const [k, v] of _smsSentToday) { if (Date.now() - v > 26 * 60 * 60 * 1000) _smsSentToday.delete(k); }
  return false;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================
async function handleConciergeWebhook(req, res) {
  // Authenticate (fails open only while VAPI_WEBHOOK_SECRET is unset).
  const auth = verifyVapiWebhook(req);
  if (!auth.ok) {
    console.warn(`🚫 Rejected concierge webhook (${auth.reason})`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const message = req.body.message || req.body;
    const type = message?.type;

    // ── assistant-request: hand VAPI the concierge config ──────────────
    if (type === 'assistant-request') {
      const callerPhone = message?.call?.customer?.number || null;
      console.log(`🎧 Concierge call from ${callerPhone || 'unknown'}`);
      return res.status(200).json({ assistant: buildConciergeAssistant() });
    }

    // ── transfer-destination-request: route to the requested demo ──────
    if (type === 'transfer-destination-request') {
      // Pull demo_type out of the tool call arguments.
      const args = message?.toolCalls?.[0]?.function?.arguments || message?.functionCall?.parameters || {};
      let demoType = null;
      try {
        const parsed = typeof args === 'string' ? JSON.parse(args) : args;
        demoType = parsed.demo_type || null;
      } catch { /* leave null */ }

      const dest = resolveDemoDestination(demoType);
      if (!dest) {
        // No destination configured, decline gracefully; the AI keeps talking.
        return res.status(200).json({ error: 'No demo line is available right now.' });
      }
      console.log(`🔀 Concierge transferring to ${demoType || 'default'} demo → ${dest.number}`);
      return res.status(200).json({ destination: { type: 'number', number: dest.number, message: dest.message } });
    }

    // ── tool-calls: acknowledge (transfer routing handled above) ───────
    if (type === 'tool-calls') {
      const tc = (message?.toolCalls || message?.toolCallList || [])[0];
      return res.status(200).json({ results: [{ toolCallId: tc?.id, result: 'Connecting you now.' }] });
    }

    // ── end-of-call-report: log + lead-capture SMS ─────────────────────
    if (type === 'end-of-call-report') {
      const call = message.call || {};
      const callerPhone = call.customer?.number || null;
      const transcript = message.transcript || message.artifact?.transcript || '';
      const recordingUrl = message.recordingUrl || message.artifact?.recordingUrl || call.recordingUrl || null;
      let durationSeconds = call.duration || message.duration || message.durationSeconds || null;
      durationSeconds = (durationSeconds != null && !Number.isNaN(Number(durationSeconds))) ? Math.round(Number(durationSeconds)) : null;
      const summary = message.analysis?.summary || message.artifact?.summary || call.analysis?.summary || null;
      const endedReason = call.endedReason || message.endedReason || null;

      // Did a transfer happen? (VAPI marks forwarded calls.)
      const transferred = endedReason === 'assistant-forwarded-call';

      try {
        const { error } = await supabase.from('platform_demo_calls').insert({
          caller_phone: callerPhone,
          transcript: transcript || null,
          recording_url: recordingUrl,
          duration_seconds: durationSeconds,
          summary: summary || null,
          transferred,
          ended_reason: endedReason,
          vapi_call_id: call.id || null,
          created_at: new Date().toISOString(),
        });
        if (error) console.warn('⚠️ platform_demo_calls insert failed:', error.message);
        else console.log(`✅ Concierge call logged (${callerPhone || 'unknown'}, ${durationSeconds || '?'}s, transferred=${transferred})`);
      } catch (e) {
        console.warn('⚠️ platform_demo_calls insert threw:', e.message);
      }

      // Lead-capture SMS: summary + signup link. Best-effort, deduped. Skipped
      // when the call was transferred to a demo: the demo destination sends the
      // better, reframed follow-up (with the actual demo summary), so sending one
      // here too would double-text the prospect.
      if (!transferred && callerPhone && callerPhone !== 'Unknown' && !alreadyTexted(callerPhone)) {
        try {
          const summaryText = (summary && summary.trim()) ? summary.trim() : null;
          const lines = summaryText
            ? [
                'Thanks for calling VoiceAI Connect! 🎉',
                '',
                "Here's the summary from our call, the exact kind of text your clients get automatically after every call they answer:",
                '',
                summaryText,
                '',
                'Ready to launch your own agency? Start a 14-day free trial of Pro or Scale:',
                SIGNUP_URL,
              ]
            : [
                'Thanks for calling VoiceAI Connect! 🎉',
                '',
                'The automatic post-call text your clients get after every call? That is the feature you just experienced.',
                '',
                'Ready to launch your own agency? Start a 14-day free trial of Pro or Scale:',
                SIGNUP_URL,
              ];
          await sendAndLogSMS({
            phone: callerPhone,
            message: lines.join('\n'),
            agencyId: null,
            recipientType: 'prospect',
            messageType: 'concierge_followup',
            metadata: { transferred, durationSeconds },
          });
          console.log('✅ Concierge follow-up SMS sent');
        } catch (smsErr) {
          console.warn('⚠️ Concierge follow-up SMS failed:', smsErr.message);
        }
      }

      return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Concierge webhook error:', error);
    // 200 so VAPI doesn't retry-storm; we've logged it.
    return res.status(200).json({ received: true });
  }
}

module.exports = { handleConciergeWebhook, buildConciergeAssistant };

// ============================================================================
// WIRING (your steps, none of this is automatic)
// ----------------------------------------------------------------------------
// 1. server.js, mount the route (near the other /webhook routes):
//      const { handleConciergeWebhook } = require('./webhooks/vapi-concierge-webhook');
//      app.post('/webhook/vapi-concierge', handleConciergeWebhook);
//
// 2. Provision (or repurpose) a VAPI phone number for the demo line and point it
//    at this webhook in dynamic mode:
//      assistantId: null
//      serverUrl:  `${BACKEND_URL}/webhook/vapi-concierge`
//      serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET   (once you turn auth on)
//    This is the number you put on the marketing site as "call and talk to it."
//
// 3. Env vars:
//      DEMO_HOMESERVICES_NUMBER = +1... (home-services receptionist demo)
//      DEMO_AGENCY_NUMBER       = +1... (the agency demo line)
//      PLATFORM_SIGNUP_URL      = https://www.myvoiceaiconnect.com/signup  (optional)
//      CONCIERGE_MAX_CALL_SECONDS = 600 (optional cap)
//
// 4. Create the log table (SQL provided separately) and mount the admin route
//    (routes/admin-demo-calls.js) so these calls show in the admin panel with
//    recording, transcript, and caller info.
// ============================================================================