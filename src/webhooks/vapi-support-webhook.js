// ============================================================================
// VAPI SUPPORT LINE WEBHOOK
// Handles the shared support phone number for all agencies' clients.
//
// Flow:
//   1. Client calls the support number
//   2. VAPI sends assistant-request; we return dynamic config with agency name
//   3. AI helps the caller from the knowledge base
//   4. If the AI cannot help (or the caller asks for a person), it takes a
//      message and ends the call. There is NO transfer to a human.
//   5. On end-of-call, we log the interaction and text the owner a summary
//      (caller, duration, whether it needs follow-up, and the one-line message)
//
// UPDATED: 2026-09-17 - SECURITY: authenticated. Like the main VAPI webhook,
//   this drives live calls and looks callers up by phone (leaking whether a
//   number maps to a client + that client's business name) and writes
//   support_calls rows, so an unauthenticated POST is a hole. handleSupportWebhook
//   now calls verifyVapiWebhook (lib/vapi-webhook-auth.js) and 401s a bad/missing
//   secret. Fails open when VAPI_WEBHOOK_SECRET is unset so it cannot break live
//   support calls before VAPI is configured; see that module for rollout order.
// ============================================================================
const { supabase } = require('../lib/supabase');
const { verifyVapiWebhook } = require('../lib/vapi-webhook-auth');
const { sendAndLogSMS } = require('../lib/sms-logger');
const Anthropic = require('@anthropic-ai/sdk');

const SUPPORT_VOICE_ID = process.env.SUPPORT_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Sarah
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
// Owner-notify number (same resolution order as routes/help.js). recipientType
// 'admin' below keeps this on platform Telnyx regardless of the caller's agency.
const SUPPORT_PHONE = process.env.SUPPORT_PHONE_NUMBER || process.env.PLATFORM_OWNER_PHONE || '+16783161454';
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ============================================================================
// CALLER LOOKUP — find client + agency from caller's phone number
// ============================================================================
async function lookupCallerContext(callerPhone) {
  if (!callerPhone || callerPhone === 'Unknown') return null;

  const digits = callerPhone.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  if (last10.length < 10) return null;

  const phoneVariants = [
    `+1${last10}`,
    `1${last10}`,
    last10,
    `(${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}`,
  ];

  // Try matching client's owner_phone
  const { data: client, error } = await supabase
    .from('clients')
    .select(`
      id, business_name, owner_phone, email, industry, plan_type, subscription_status,
      agency_id,
      agencies (id, name, slug, support_email, support_phone)
    `)
    .in('owner_phone', phoneVariants)
    .limit(1)
    .single();

  if (!error && client) {
    return {
      type: 'client',
      agencyName: client.agencies?.name || 'VoiceAI Connect',
      agencyId: client.agency_id,
      callerName: client.business_name,
      businessName: client.business_name,
      clientId: client.id,
      planType: client.plan_type,
      industry: client.industry,
    };
  }

  // Try agency owner's phone
  const { data: agency } = await supabase
    .from('agencies')
    .select('id, name, slug, phone, support_email')
    .in('phone', phoneVariants)
    .limit(1)
    .single();

  if (agency) {
    return {
      type: 'agency_owner',
      agencyName: agency.name,
      agencyId: agency.id,
      callerName: null,
      businessName: null,
      clientId: null,
      planType: null,
      industry: null,
    };
  }

  return null;
}

// ============================================================================
// BUILD DYNAMIC ASSISTANT CONFIG
// ============================================================================
async function buildSupportAssistant(context) {
  const agencyName = context?.agencyName || null;
  const clientName = context?.businessName || null;
  const planType = context?.planType || null;

  // Agency-aware greeting: a caller who matches a client hears their agency's own
  // branded support line. Unknown callers get a plain greeting (no platform name).
  const greeting = agencyName
    ? `Thanks for calling ${agencyName} support. How can I help you today?`
    : `Thanks for calling support. How can I help you today?`;

  const contextLine = clientName
    ? `The caller is ${clientName}, a ${planType || 'client'} on ${agencyName}. Treat this as ${agencyName}'s own support line.`
    : (agencyName
        ? `The caller is with ${agencyName}. Treat this as ${agencyName}'s own support line.`
        : `The caller's identity is unknown. If you need it, ask for their name and business name.`);

  const systemPrompt = `You are the voice support line for an AI receptionist service${agencyName ? ` provided by ${agencyName}` : ''}. Callers are business owners who use the AI receptionist and have questions about setting it up or troubleshooting it: their greeting, call forwarding, reading call transcripts, voice, business hours, billing, and so on.

How to help:
- For any how-to or troubleshooting question, FIRST call the search_knowledge_base tool and answer from what it returns. Do not guess, and never invent features, prices, or policies.
- Keep every reply short and natural, one or two sentences, the way a real person talks on the phone. Get to the point and ask a quick follow-up if you need more.
- You cannot make changes to their account, access their recordings or transcripts, process billing, or reset passwords. For those, point them to the right place in the app, or take a message.
- There is no live person to transfer to. If you cannot resolve it, or they ask for a human, take a message: get their name, business name, a callback number, and a one-sentence description, read it back, and let them know the team will follow up. The team is texted a summary after every call, so nothing is lost.

${contextLine}

Never mention internal tools or vendors (no VAPI, Supabase, Telnyx, and so on). Stay warm, brief, and focused on getting the caller unstuck.`;

  // Load the KB query tool so the assistant can actually answer from the support
  // knowledge base. Without it the line is only conversational, not useful.
  let toolId = null;
  try {
    const { data } = await supabase.from('platform_settings').select('value').eq('key', 'support_query_tool_id').maybeSingle();
    toolId = data?.value || null;
  } catch (e) {
    console.warn('\u26a0\ufe0f Could not load support_query_tool_id (KB tool):', e.message);
  }

  return {
    firstMessage: greeting,
    serverUrl: `${BACKEND_URL}/webhook/vapi-support`,
    serverMessages: ['end-of-call-report', 'transcript', 'status-update'],
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [{ role: 'system', content: systemPrompt }],
      ...(toolId && { toolIds: [toolId] }),
      tools: [{ type: 'endCall' }],
    },
    voice: {
      provider: '11labs',
      model: 'eleven_flash_v2_5',
      voiceId: SUPPORT_VOICE_ID,
    },
    startSpeakingPlan: {
      waitSeconds: 0.4,
      smartEndpointingPlan: { provider: 'vapi' },
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.2, onNoPunctuationSeconds: 1.0, onNumberSeconds: 0.4 },
    },
    stopSpeakingPlan: {
      numWords: 2,
      voiceSeconds: 0.2,
      backoffSeconds: 1.0,
    },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    endCallMessage: "Thanks for calling support! If you need more help, don't hesitate to call back. Have a great day!",
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
    },
  };
}

// ============================================================================
// POST-CALL OWNER NOTIFICATION
// Every support call texts Gibson a short summary. On this line the AI takes a
// message when it cannot help, so this text IS the message delivery, and the
// only push visibility into calls the AI handled on its own or that hung up. A
// support_calls row nobody reads is not a signal; a text is.
// ============================================================================
function formatCallDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s <= 0) return 'unknown';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function buildCallerLabel(context) {
  if (!context) return 'Unknown caller';
  if (context.type === 'agency_owner') {
    return `${context.agencyName} (agency owner)`;
  }
  const parts = [context.businessName || 'Client'];
  const meta = [];
  if (context.agencyName && context.agencyName !== 'VoiceAI Connect') meta.push(context.agencyName);
  if (context.planType) meta.push(`${context.planType} plan`);
  if (meta.length) parts.push(`(${meta.join(', ')})`);
  return parts.join(' ');
}

// One-line "what did they need" plus whether it still needs Gibson's follow-up,
// from the transcript. Returns null when there is nothing worth summarizing
// (very short call, no transcript, or AI unavailable). On any parse trouble it
// defaults to needs-follow-up: over-notifying is safer than dropping a message.
async function summarizeSupportCall(transcript) {
  const text = (transcript || '').trim();
  if (!anthropic || text.length < 40) return null;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 120,
      system: 'You review a support phone call transcript for an AI receptionist product. Reply with ONLY a JSON object, no preamble and no code fences: {"need":"<one sentence, 15 words max, what the caller needed>","needs_followup":<true if the AI did not fully resolve it or the caller wanted a person, false if the AI clearly handled it>}.',
      messages: [{ role: 'user', content: `Transcript:\n${text.substring(0, 6000)}` }],
    });
    const raw = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .trim();
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(cleaned);
      return {
        need: (parsed.need || '').toString().trim() || null,
        needsFollowup: parsed.needs_followup !== false,
      };
    } catch {
      return { need: cleaned || null, needsFollowup: true };
    }
  } catch (err) {
    console.warn('⚠️ Support summary generation failed (non-fatal):', err.message);
    return null;
  }
}

// ============================================================================
// MAIN WEBHOOK HANDLER
// ============================================================================
async function handleSupportWebhook(req, res) {
  // SECURITY: verify this POST actually came from VAPI before doing anything.
  // Fails open only when VAPI_WEBHOOK_SECRET is unset (see lib/vapi-webhook-auth).
  const _auth = verifyVapiWebhook(req);
  if (!_auth.ok) {
    console.warn(`🚫 Rejected VAPI support webhook (${_auth.reason})`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const message = req.body.message || req.body;
    const messageType = message?.type || req.body?.type;

    console.log(`🎧 Support webhook: ${messageType}`);

    // ============================
    // ASSISTANT REQUEST — dynamic config based on caller
    // ============================
    if (messageType === 'assistant-request') {
      const callerPhone = message?.call?.customer?.number || req.body?.call?.customer?.number || null;
      console.log(`🔍 Support call from: ${callerPhone || 'Unknown'}`);

      const context = await lookupCallerContext(callerPhone);

      if (context) {
        console.log(`✅ Caller identified: ${context.businessName || 'Agency owner'} (${context.agencyName})`);
      } else {
        console.log('⚠️ Unknown caller — generic greeting');
      }

      const assistant = await buildSupportAssistant(context);
      return res.status(200).json({ assistant });
    }

    // ============================
    // END OF CALL REPORT — log the support interaction
    // ============================
    if (messageType === 'end-of-call-report') {
      const call = message.call;
      const callerPhone = call?.customer?.number || 'Unknown';
      const transcript = message.transcript || message.artifact?.transcript || '';
      const durationSeconds = call?.duration || message?.duration || null;

      console.log(`🎧 Support call completed: ${callerPhone}, ${durationSeconds ? durationSeconds + 's' : 'unknown duration'}`);

      const context = await lookupCallerContext(callerPhone);

      try {
        await supabase.from('support_calls').insert([{
          caller_phone: callerPhone,
          client_id: context?.clientId || null,
          agency_id: context?.agencyId || null,
          agency_name: context?.agencyName || null,
          business_name: context?.businessName || null,
          transcript: transcript,
          duration_seconds: durationSeconds,
          created_at: new Date().toISOString(),
        }]);
        console.log('✅ Support call logged');
      } catch (dbErr) {
        console.warn('⚠️ Could not log support call (non-fatal):', dbErr.message);
      }

      // Notify the owner. Best-effort and non-blocking: a texting failure must
      // never 500 the webhook back to VAPI. This delivers the message the AI
      // took and is the only push visibility into every support call.
      try {
        const summary = await summarizeSupportCall(transcript);
        const need = summary?.need || null;
        const needsFollowup = summary ? summary.needsFollowup : true;

        const smsBody = [
          '🎧 VoiceAI Support Call',
          `From: ${buildCallerLabel(context)}`,
          `Number: ${callerPhone}`,
          `Duration: ${formatCallDuration(durationSeconds)}`,
          `Status: ${needsFollowup ? 'Needs your follow-up' : 'Handled by AI'}`,
          `Message: ${need || 'No transcript (very short call)'}`,
          `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
        ].join('\n');

        await sendAndLogSMS({
          phone: SUPPORT_PHONE,
          message: smsBody,
          agencyId: context?.agencyId || null,
          recipientType: 'admin',
          messageType: 'support_call_summary',
          metadata: { callerPhone, needsFollowup, clientId: context?.clientId || null },
        });
        console.log('✅ Support call summary texted to owner');
      } catch (smsErr) {
        console.warn('⚠️ Support summary SMS failed (non-fatal):', smsErr.message);
      }

      return res.status(200).json({ received: true });
    }

    // All other message types — acknowledge
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Support webhook error:', error);
    return res.status(200).json({ received: true });
  }
}

module.exports = { handleSupportWebhook };