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

// 11labs voice model. turbo_v2_5 sounds noticeably more natural / less robotic
// than flash. If a call ever fails with "couldn't get assistant", this model may
// not be enabled on your 11labs plan, set CONCIERGE_TTS_MODEL=eleven_flash_v2_5.
const CONCIERGE_TTS_MODEL = process.env.CONCIERGE_TTS_MODEL || 'eleven_turbo_v2_5';

// ============================================================================
// SYSTEM PROMPT — the SDR persona + accurate platform knowledge + routing
// ----------------------------------------------------------------------------
// Every fact here is drawn from the live marketing site / FAQ. Do not invent
// features or prices; if unsure, the AI says a human will follow up.
// ============================================================================
function buildConciergeSystemPrompt() {
  const homeAvail = DEMO_HOMESERVICES_NUMBER ? 'available' : 'not currently available';
  const agencyAvail = DEMO_AGENCY_NUMBER ? 'available' : 'not currently available';

  return `You are the AI concierge for VoiceAI Connect, and here's the fun part: the voice on this call IS the product. The person calling is a prospect, an entrepreneur or agency owner deciding whether to build an AI receptionist agency on our platform. Every second you sound human and sharp, you're proving the product works.

## HOW YOU TALK (this matters most, you ARE the live demo)
- You're a real person on the phone. Warm, quick, a little excited because this is genuinely a good product. Never a brochure, never a menu.
- Short turns. A sentence or two, then let them talk. Never monologue, never read a list out loud.
- Contractions and natural rhythm. Real phrasing: "yeah", "honestly", "so here's the thing", "good question", "totally". A light, natural lead-in now and then ("so...", "yeah, so") is good, don't overdo it.
- React to what they just said, use their name if you have it, before moving on. Personalized, not canned.
- Answer the question they asked, not the five around it. Give the one detail that lands, then keep moving.
- NEVER repeat yourself. If you've made a point, don't make it again, take a new angle or ask them something. If you catch yourself circling, stop and ask a direct question to move forward. Do not loop.
- Take a clear position. No hedging, no vague filler, no corporate-speak. Plain, human words.
- Say the product name naturally ("voice A-I connect"), and read any email as "support at voiceaiconnect dot com."

## LEARN THEIR ANGLE (naturally, don't interrogate)
Get a feel for what they're after, woven into the talk, not as a checklist. Worth learning: what kind of local businesses they'd want as clients, and what's got them looking into this now. One question at a time, and actually respond to the answer. Nothing that feels like a form.

## THE MAIN EVENT: TEXT THEM THE TRIAL LINK, LIVE
The single most valuable thing you can do on this call is text them their signup link WHILE you're still talking, so they watch the AI fire off a real text in real time. That's the moment that closes people.
- As soon as they're even mildly interested, say it out loud first ("cool, I'm texting you the link right now, you should see it pop up in a sec"), THEN call the send_signup_link tool.
- Call send_signup_link once. After it sends, confirm it ("that should be hitting your phone now") and point out what just happened: the AI sent them a text on its own, and that's the same thing they'd be selling.
- The link starts a 14-day free trial of the Pro plan, the full white-label version. That's what you're steering them toward.

## WHAT VOICEAI CONNECT IS
A white-label AI receptionist platform for agencies and resellers. Operators brand the product as their own and resell AI receptionist subscriptions to local service businesses (home services, dental, medical, legal, restaurants, and more) for around 99 to 299 dollars per month. The platform provisions the AI voice agent, a dedicated phone number, and a client dashboard automatically at signup. We run the underlying infrastructure; the operator runs the business.

## PRICING (only what they ask, keep it conversational)
- PRO, 99 dollars a month: full white-label branding, your own marketing website, a branded demo line, and lower usage rates (about 9.99 per client, 0.10 a minute). 14-day free trial, card required to start, not charged until day 14. THIS is the one you point people to.
- SCALE, 499 a month: no per-client fees at all, lowest per-minute rate (0.05), unlimited team members. Also a 14-day trial.
- FREE exists (no monthly fee, usage-based) but skip it unless they ask, serious operators start on Pro for the branding.
- Every client they onboard gets a 7-day free trial too. Google Calendar booking is on every plan.

## THE KEY SELLING POINTS
- White-label: every surface (logo, colors, custom domain, emails, the marketing site, the phone experience) is the operator's brand. Their clients never see VoiceAI Connect.
- Money is theirs: client subscriptions flow straight to the operator's own Stripe account via Stripe Connect. Zero revenue share, no holdbacks. The operator sets the price.
- Under 60 seconds from a client signing up to a live AI and a provisioned phone number. No A2P registration delay.
- The AI answers 24/7, handles unlimited simultaneous calls, detects English or Spanish and switches automatically, books to Google Calendar in real time, transfers urgent calls, blocks robocalls and spam automatically, and texts the business owner a summary after every call.
- Built-in lead-generation CRM: pull local businesses from Google Maps, run outreach with pre-written templates, track replies.
- Versus GoHighLevel: we give the END client their own branded dashboard, onboard in under a minute with no per-client A2P registration, and the agency interface is mobile-first.
- International: US numbers are automatic; for UK or Canada the operator connects their own Twilio.

## IF THEY NEED HELP OR SUPPORT
Don't pitch "great support" in the abstract. Give them the real thing: they can reach out anytime at support at voiceaiconnect dot com, or hit the support button right in the agency dashboard, and a human gets back to them.

## OFFERING A LIVE DEMO (secondary, the texted link comes first)
If they want to actually hear a receptionist, offer one and call connect_to_demo:
- "home_services": a home-services receptionist, what a client's callers hear. Currently ${homeAvail}.
- "agency": a real, fully-set-up agency line on the platform. Currently ${agencyAvail}.
Ask which they'd prefer if it's unclear. Timing matters on the hand-off: keep your lead-in to a quick beat ("awesome, connecting you now") and then call the tool. The system speaks the hand-off line and dials automatically, so don't give a long speech or you'll talk over the transfer. And text them the trial link with send_signup_link BEFORE you transfer, so they already have it while they're in the demo. If a demo isn't available, don't promise it, offer the other one or a human follow-up.

## GUARDRAILS
- Only discuss VoiceAI Connect and running an agency on it. If asked about anything unrelated, gently steer back.
- Never invent features, prices, or guarantees. If you don't know, say a team member will follow up by text or email.
- Do not give financial, legal, or tax advice.
- Winding down? Make sure they got the texted link, remind them it's a 14-day free trial of Pro, and that support at voiceaiconnect dot com (or the dashboard support button) is there anytime.`;
}

// ============================================================================
// ASSISTANT CONFIG (returned on assistant-request)
// ============================================================================
function buildConciergeAssistant() {
  return {
    firstMessage: "Hey, thanks for calling VoiceAI Connect! Quick thing, the voice you're talking to right now is the exact AI you'd be reselling to local businesses. So what's got you looking into building an AI receptionist agency?",
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
          // No static destinations on purpose. A static destination makes VAPI
          // dial that number directly and SKIP the transfer-destination-request
          // event, which would send every transfer to one line and ignore
          // demo_type. Leaving it off forces the server event below, so we route
          // to the correct demo (home_services vs agency) on each transfer.
        },
        {
          type: 'function',
          function: {
            name: 'send_signup_link',
            description: "Text the caller their 14-day free trial link for the white-label Pro plan, live, during the call. Call this as soon as they show real interest. RIGHT BEFORE you call it, say out loud that you're texting them the link now. Call it only once per call.",
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ],
    },
    voice: {
      provider: '11labs',
      voiceId: CONCIERGE_VOICE_ID,
      model: CONCIERGE_TTS_MODEL,
      stability: 0.45,
      similarityBoost: 0.75,
      style: 0.35,
      useSpeakerBoost: true,
      speed: CONCIERGE_SPEED,
    },
    transcriber: { provider: 'deepgram', model: 'nova-2', language: 'en' },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: MAX_CALL_SECONDS,
    endCallMessage: "Thanks for calling VoiceAI Connect! Check your texts for that trial link, and reach out at support at voiceaiconnect dot com anytime. Talk soon.",
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

    // ── tool-calls: send the live signup-link text, plus acknowledge ────
    if (type === 'tool-calls') {
      const toolCalls = message?.toolCalls || message?.toolCallList || [];
      const callerPhone = message?.call?.customer?.number || null;
      const results = [];
      for (const tc of toolCalls) {
        const fnName = tc?.function?.name || tc?.name;
        if (fnName === 'send_signup_link') {
          let ok = false;
          if (callerPhone && callerPhone !== 'Unknown' && !alreadyTexted(callerPhone)) {
            // Fire-and-forget: don't await the SMS API, or the model waits (dead
            // air on the live call) for the result. Persistent Node process on
            // DigitalOcean keeps the promise alive after we respond. The AI has
            // already told them it's coming, so we just confirm it's on the way.
            sendAndLogSMS({
              phone: callerPhone,
              message: `Your 14-day free trial of VoiceAI Connect Pro (full white-label):\n${SIGNUP_URL}`,
              agencyId: null,
              recipientType: 'prospect',
              messageType: 'concierge_signup_link',
              metadata: { source: 'concierge_live_call' },
            })
              .then(() => console.log(`✅ Concierge texted signup link (live) to ${callerPhone}`))
              .catch((e) => console.warn('⚠️ Concierge send_signup_link failed:', e.message));
            ok = true;
          } else if (callerPhone && callerPhone !== 'Unknown') {
            ok = true; // already texted this caller today; report success so the AI confirms naturally
          }
          results.push({
            toolCallId: tc?.id,
            result: ok
              ? 'On its way, tell them it will pop up on their phone in a few seconds.'
              : "Couldn't send the text (no caller number on this call). Tell them you'll follow up by email instead.",
          });
        } else {
          results.push({ toolCallId: tc?.id, result: 'Done.' });
        }
      }
      return res.status(200).json({ results });
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

      // Post-call SMS: summary + signup link, sent on end-of-call-report (i.e.
      // right after the call ends). Best-effort, deduped via alreadyTexted:
      // skipped if we already texted this caller during the call
      // (send_signup_link) or transferred them to a demo (they got the link just
      // before the transfer), so a prospect never gets two texts from one call.
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