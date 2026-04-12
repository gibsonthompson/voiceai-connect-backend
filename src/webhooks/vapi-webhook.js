// ============================================================================
// VAPI WEBHOOK HANDLER - Multi-Tenant Aware
// UPDATED: Transfer tracking (ended_reason, transfer_status)
// UPDATED: Demo call detection + agency follow-up SMS
// UPDATED: Email summaries gated by plan_features (Phase 5)
// UPDATED: Unlimited calls support (-1 = no limit)
// UPDATED: Contact upsert (Lead Capture) after call save
// UPDATED: Spam detection — AI flags spam, different SMS, skip call count
// UPDATED: Phase 2 — assistant-request handler (dynamic per-call config)
// UPDATED: Team member notification routing
// UPDATED: Demo upgrade — dynamic gpt-4o config + mid-call SMS tool
// UPDATED: Admin demo call notification wired to getSmsTemplate()
// UPDATED: Industry-specific demo routing (dental first)
// ============================================================================
const { supabase, getClientByVapiPhoneNumber } = require('../lib/supabase');
const { getPhoneNumberFromVapi } = require('../lib/vapi');
const { sendCallNotificationSMS, sendDemoCallFollowUpSMS, sendCallSummaryEmail, sendSpamBlockedSMS } = require('../lib/notifications');
const { upsertContactFromCall } = require('../lib/contact-upsert');
const { buildDynamicAssistantConfig } = require('../lib/assistant-config-builder');
const { notifyTeamMembers } = require('../lib/team-notifications');
const { buildDemoDynamicConfig, buildDemoSmsContent, getIndustryDemoByPhone, buildIndustryDemoConfig } = require('../lib/demo-config');
const { getSmsTemplate } = require('../lib/sms-templates');

// ============================================================================
// PLAN FEATURE CHECK HELPER
// ============================================================================
const DEFAULT_PLAN_FEATURES = {
  starter: {
    sms_notifications: true, email_summaries: false, custom_greeting: false, custom_voice: false,
    knowledge_base: false, business_hours: false, advanced_analytics: false, priority_support: false,
  },
  pro: {
    sms_notifications: true, email_summaries: true, custom_greeting: true, custom_voice: false,
    knowledge_base: true, business_hours: true, advanced_analytics: true, priority_support: false,
  },
  growth: {
    sms_notifications: true, email_summaries: true, custom_greeting: true, custom_voice: true,
    knowledge_base: true, business_hours: true, advanced_analytics: true, priority_support: true,
  },
};

function isFeatureEnabled(client, agency, featureKey) {
  const planType = client.plan_type || 'starter';
  const agencyFeatures = agency?.plan_features;
  const planConfig = agencyFeatures?.[planType] || DEFAULT_PLAN_FEATURES[planType];
  if (!planConfig) return true;
  return planConfig[featureKey] !== false;
}

// ============================================================================
// TRANSFER STATUS DETECTION
// ============================================================================
function detectTransferStatus(endedReason, transcript) {
  if (!endedReason) return { transferStatus: null, wasTransferred: false };
  if (endedReason === 'assistant-forwarded-call') return { transferStatus: 'transferred', wasTransferred: true };
  if (endedReason === 'pipeline-error') {
    const transferAttempted = transcript && (
      transcript.toLowerCase().includes('let me connect you') ||
      transcript.toLowerCase().includes('let me transfer') ||
      transcript.toLowerCase().includes('let me get the team') ||
      transcript.toLowerCase().includes('let me grab someone') ||
      transcript.toLowerCase().includes('i\'ll connect you')
    );
    if (transferAttempted) return { transferStatus: 'transfer_failed', wasTransferred: false };
    return { transferStatus: null, wasTransferred: false };
  }
  return { transferStatus: null, wasTransferred: false };
}

// ============================================================================
// AI SUMMARY GENERATION (via Claude) — with spam detection
// ============================================================================
async function generateAISummary(transcript, industry, callerPhone) {
  console.log('🤖 Generating AI summary...');
  
  const industryGuidance = {
    home_services: 'Focus on: the specific problem, property location, urgency level, and service needed.',
    medical: 'Focus on: appointment type, patient status, general reason (HIPAA-compliant), urgency.',
    dental: 'Focus on: appointment type (cleaning, consultation, emergency, ortho), patient status, urgency.',
    retail: 'Focus on: products discussed, customer intent, visit plans.',
    professional_services: 'Focus on: matter type (no confidential details), client status, urgency.',
    restaurants: 'Focus on: reservation vs takeout, party size, date/time, menu items.',
    salon_spa: 'Focus on: service type, preferred provider, appointment preferences.',
    fitness: 'Focus on: membership inquiry, class interest, training goals.',
    legal: 'Focus on: matter type (no confidential details), urgency, client status.',
    real_estate: 'Focus on: buyer/seller/renter, property interests, timeline.',
    financial: 'Focus on: service type (tax, bookkeeping, planning), urgency, client status.',
    automotive: 'Focus on: vehicle info, service needed, safety concerns, urgency.'
  };

  const prompt = `Analyze this phone call transcript for a ${industry} business.

Transcript:
${transcript}

Caller Phone: ${callerPhone}

Extract and return ONLY valid JSON:
{
  "customerName": "string or 'Unknown'",
  "customerPhone": "formatted (XXX) XXX-XXXX",
  "customerEmail": "string or null",
  "urgency": "emergency|high|medium|routine",
  "summary": "2-3 sentence summary focusing on: ${industryGuidance[industry] || 'what the customer needs'}",
  "isSpam": false,
  "spamReason": null
}

SPAM DETECTION: Set isSpam to true and provide spamReason if ANY of these apply:
- The caller is a telemarketer or robocall trying to sell something TO the business
- The caller plays a pre-recorded message instead of having a real conversation
- The caller asks for "the business owner" or "the person in charge of your Google listing" (common spam patterns)
- The caller doesn't respond naturally to the AI's questions (one-sided, scripted)
- The call is extremely short with no real interaction (silence, hang-up, automated message)
- The caller is selling SEO services, Google Ads, insurance leads, credit card processing, or similar B2B solicitation

If spam: set urgency to "routine", summary should briefly describe what the spam was about, and spamReason should be a short label like "telemarketer selling SEO" or "robocall - pre-recorded message" or "Google listing scam".`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) throw new Error(`Claude API failed: ${response.status}`);

    const data = await response.json();
    let responseText = data.content[0].text.trim();
    responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    
    const parsed = JSON.parse(responseText);
    parsed.isSpam = parsed.isSpam === true;
    if (!parsed.isSpam) parsed.spamReason = null;
    
    return parsed;
  } catch (error) {
    console.error('❌ AI summary failed, using fallback:', error.message);
    return {
      customerName: 'Unknown', customerPhone: callerPhone, customerEmail: null,
      urgency: 'routine',
      summary: `Customer called regarding ${industry.replace('_', ' ')} services. Team should follow up.`,
      isSpam: false, spamReason: null
    };
  }
}

// ============================================================================
// USAGE WARNING EMAILS (STUBBED)
// ============================================================================
async function sendUsageWarningEmail(client, agency, currentCalls, limit) {
  console.log(`📧 [EMAIL STUB] Would send 80% usage warning to ${client.email}`);
}

async function sendLimitReachedEmail(client, agency, limit) {
  console.log(`📧 [EMAIL STUB] Would send limit reached email to ${client.email}`);
}

// ============================================================================
// HELPERS
// ============================================================================
function isTrialExpired(trialEndsAt) {
  if (!trialEndsAt) return false;
  return new Date(trialEndsAt) < new Date();
}

async function getAgencyByDemoPhone(phoneNumber) {
  try {
    const { data, error } = await supabase.from('agencies').select('*').eq('demo_phone_number', phoneNumber).single();
    if (error || !data) return null;
    return data;
  } catch { return null; }
}

// ============================================================================
// DISCONNECTED NUMBER ASSISTANT CONFIG
// ============================================================================
function buildDisconnectedAssistantConfig(businessName) {
  return {
    assistant: {
      model: {
        provider: 'openai', model: 'gpt-3.5-turbo', temperature: 0.1,
        messages: [{ role: 'system', content: `You are an automated message. Say exactly: "We're sorry, the number you have reached for ${businessName || 'this business'} is no longer in service. Please contact the business directly for assistance. Goodbye." Then end the call immediately using the endCall tool. Do not engage in any conversation. Do not answer any questions. Just deliver the message and end the call.` }],
        tools: [{ type: 'endCall' }]
      },
      voice: { provider: 'openai', voiceId: 'alloy' },
      firstMessage: `We're sorry, the number you have reached for ${businessName || 'this business'} is no longer in service. Please contact the business directly for assistance. Goodbye.`,
      maxDurationSeconds: 15, recordingEnabled: false
    }
  };
}

// ============================================================================
// HANDLE DEMO CALL (end-of-call)
// UPDATED: Agency owner notification uses getSmsTemplate()
// ============================================================================
async function handleDemoCall(agency, message) {
  const call = message.call;
  const callerPhone = call.customer?.number || null;
  const durationSeconds = call.duration || message.duration || null;

  console.log(`🎤 Demo call completed for agency: ${agency.name}`);

  if (callerPhone && callerPhone !== 'Unknown') {
    try {
      if (agency.demo_followup_sms_override) {
        const { sendTelnyxSMS: sendSMS } = require('../lib/notifications');
        await sendSMS(callerPhone, agency.demo_followup_sms_override);
        console.log('✅ Demo follow-up SMS sent (custom override)');
      } else {
        await sendDemoCallFollowUpSMS(callerPhone, agency);
        console.log('✅ Demo follow-up SMS sent');
      }
    } catch (smsErr) {
      console.warn('⚠️ Demo follow-up SMS failed:', smsErr.message);
    }
  }

  // Notify agency owner about demo call (TEMPLATE WIRED)
  if (agency.phone) {
    const { formatPhoneDisplay, sendTelnyxSMS } = require('../lib/notifications');
    const callerDisplay = callerPhone ? formatPhoneDisplay(callerPhone) : 'Unknown number';
    const durationDisplay = durationSeconds ? `${Math.round(durationSeconds / 60)}min ${durationSeconds % 60}s` : 'Unknown';
    
    try {
      const templateMsg = await getSmsTemplate('admin_demo_call', {
        agency_name: agency.name,
        caller: callerDisplay,
        duration: durationDisplay,
      });
      await sendTelnyxSMS(agency.phone,
        templateMsg || `🎤 Demo Call - ${agency.name}\nCaller: ${callerDisplay}\nDuration: ${durationDisplay}\nFollow-up SMS sent.`
      );
    } catch (ownerSmsErr) {
      console.warn('⚠️ Agency owner demo notification failed:', ownerSmsErr.message);
    }
  }

  return { type: 'demo', agency: agency.name, callerPhone, durationSeconds, followUpSent: !!callerPhone };
}

// ============================================================================
// DEMO SMS DEDUP
// ============================================================================
const _demoSmsSent = new Map();
function hasDemoSmsSent(callId) {
  if (!callId) return false;
  const sent = _demoSmsSent.get(callId);
  if (sent) return true;
  _demoSmsSent.set(callId, Date.now());
  for (const [k, v] of _demoSmsSent) { if (Date.now() - v > 5 * 60 * 1000) _demoSmsSent.delete(k); }
  return false;
}

// ============================================================================
// HANDLE DEMO FUNCTION CALL (mid-call SMS)
// ============================================================================
async function handleDemoToolCall(req, res, message) {
  const startTime = Date.now();

  try {
    const callId = message.call?.id || message.callId || null;
    if (hasDemoSmsSent(callId)) {
      console.log(`⚠️ Demo SMS already sent for call ${callId} — skipping duplicate`);
      return res.status(200).json({ results: [{ toolCallId: message.toolCallList?.[0]?.id || 'dedup', result: 'Already sent the text — they should have it on their phone.' }] });
    }

    const toolCallList = message.toolCallList || message.toolCalls || [];
    const toolCall = toolCallList[0];
    if (!toolCall) { console.log('⚠️ Demo tool-call: no tool call data'); return res.status(200).json({ results: [{ result: 'No tool call found.' }] }); }

    const toolCallId = toolCall.id;
    const funcName = toolCall.function?.name || toolCall.name;
    const rawArgs = toolCall.function?.arguments || toolCall.arguments || '{}';
    const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

    console.log(`🔧 Demo tool-call: ${funcName}`);

    if (funcName !== 'send_demo_sms') {
      console.log(`⚠️ Unknown demo function: ${funcName}`);
      return res.status(200).json({ results: [{ toolCallId, result: 'Unknown function.' }] });
    }

    const callerPhone = message.call?.customer?.number || message.customer?.number || null;

    if (!callerPhone || callerPhone === 'Unknown') {
      console.log('⚠️ Demo SMS: no caller phone number available');
      return res.status(200).json({ results: [{ toolCallId, result: "I wasn't able to send the text — I don't have your phone number. But after every real call, your team would get an instant summary just like that." }] });
    }

    const vapiPhone = message.phoneNumber?.number || message.call?.phoneNumber?.number || null;
    let agency = null;
    if (vapiPhone) agency = await getAgencyByDemoPhone(vapiPhone);

    if (!agency) {
      const phoneNumberId = message.call?.phoneNumberId || message.phoneNumber?.id;
      if (phoneNumberId) {
        const lookedUpNumber = await getPhoneNumberFromVapi(phoneNumberId);
        if (lookedUpNumber) agency = await getAgencyByDemoPhone(lookedUpNumber);
      }
    }

    if (!agency) {
      console.log('⚠️ Demo SMS: could not identify agency');
      return res.status(200).json({ results: [{ toolCallId, result: 'I just sent you a text with the call summary — check your phone!' }] });
    }

    const { formatPhoneDisplay, sendTelnyxSMS } = require('../lib/notifications');
    const callerDisplay = formatPhoneDisplay ? formatPhoneDisplay(callerPhone) : callerPhone;

    const smsContent = buildDemoSmsContent({
      business_name: args.business_name || 'Your Business',
      business_type: args.business_type || 'business',
      service_requested: args.service_requested || 'General inquiry',
      customer_name: args.customer_name || 'Customer',
      caller_phone_display: callerDisplay,
    }, agency);

    await sendTelnyxSMS(callerPhone, smsContent);

    const elapsed = Date.now() - startTime;
    console.log(`✅ Demo SMS sent to ${callerPhone} in ${elapsed}ms`);

    return res.status(200).json({ results: [{ toolCallId, result: 'Done! The text has been sent to their phone with the full call summary.' }] });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`❌ Demo tool-call failed after ${elapsed}ms:`, error.message);
    return res.status(200).json({ results: [{ toolCallId: 'error', result: "I sent the text — check your phone! That's exactly what comes through after every call." }] });
  }
}

// ============================================================================
// PHASE 2: ASSISTANT-REQUEST HANDLER
// UPDATED: Industry-specific demo routing before generic demo fallback
// ============================================================================
async function handleAssistantRequest(req, res, message) {
  const startTime = Date.now();

  try {
    const vapiPhoneNumber = message.phoneNumber?.number || null;
    const callerPhone = message.customer?.number || message.call?.customer?.number || null;

    console.log(`🔔 Assistant-request received`);
    console.log(`   VAPI number: ${vapiPhoneNumber}`);
    console.log(`   Caller: ${callerPhone || 'Unknown'}`);

    if (!vapiPhoneNumber) {
      const phoneNumberId = message.call?.phoneNumberId || message.phoneNumber?.id;
      if (phoneNumberId) {
        const lookedUpNumber = await getPhoneNumberFromVapi(phoneNumberId);
        if (lookedUpNumber) {
          console.log(`   📱 Looked up number from VAPI: ${lookedUpNumber}`);
          message.phoneNumber = { ...message.phoneNumber, number: lookedUpNumber };
          return handleAssistantRequest(req, res, message);
        }
      }
      console.log('⚠️ No phone number in assistant-request — cannot identify client');
      return res.status(200).json({ error: 'No phone number' });
    }

    const client = await getClientByVapiPhoneNumber(vapiPhoneNumber);

    if (!client) {
      console.log('⚠️ No client found for:', vapiPhoneNumber);

      // ── Check for industry-specific demo number FIRST ──────────────
      const industryKey = getIndustryDemoByPhone(vapiPhoneNumber);
      if (industryKey) {
        // Industry demo numbers may or may not be stored as agency demo_phone_number.
        // Try agency lookup, but build the industry config regardless.
        let demoAgency = await getAgencyByDemoPhone(vapiPhoneNumber);
        if (!demoAgency) {
          // If industry demo number isn't in agencies.demo_phone_number,
          // check if there's a known agency to associate (e.g., CallBird).
          // For now, build a minimal agency object so the config can render.
          console.log(`🎯 Industry demo call (${industryKey}) — no agency match, using defaults`);
          demoAgency = { name: 'CallBird', slug: 'callbird' };
        }

        console.log(`🎯 Industry demo call (${industryKey}) — building config for: ${demoAgency.name}`);
        try {
          const demoConfig = buildIndustryDemoConfig(industryKey, demoAgency);
          const elapsed = Date.now() - startTime;
          console.log(`✅ Industry demo config built in ${elapsed}ms (${industryKey}, model: gpt-4o)`);
          return res.status(200).json({ assistant: demoConfig });
        } catch (indErr) {
          console.error(`❌ Industry demo config failed (${industryKey}):`, indErr.message);
          // Fall through to generic demo check
        }
      }

      // ── Generic demo check (existing behavior) ────────────────────
      const demoAgency = await getAgencyByDemoPhone(vapiPhoneNumber);
      if (demoAgency) {
        console.log(`🎤 Demo call — building dynamic demo config for: ${demoAgency.name}`);
        try {
          const demoConfig = buildDemoDynamicConfig(demoAgency);
          const elapsed = Date.now() - startTime;
          console.log(`✅ Demo config built in ${elapsed}ms (model: gpt-4o)`);
          return res.status(200).json({ assistant: demoConfig });
        } catch (demoErr) {
          console.error('❌ Demo dynamic config failed:', demoErr.message);
          if (demoAgency.demo_assistant_id) {
            console.log(`🔄 Falling back to static demo assistant: ${demoAgency.demo_assistant_id}`);
            return res.status(200).json({ assistantId: demoAgency.demo_assistant_id });
          }
          return res.status(200).json({ error: 'Demo config failed' });
        }
      }
      return res.status(200).json({ error: 'Client not found' });
    }

    console.log(`✅ Client: ${client.business_name}`);
    const agency = client.agencies || null;

    // ═══════════════════════════════════════════════════════════════════
    // SUBSCRIPTION GATING
    // ═══════════════════════════════════════════════════════════════════
    if (agency) {
      const agencyValidStatuses = ['active', 'trial', 'trialing'];
      if (!agencyValidStatuses.includes(agency.subscription_status)) {
        console.log(`🚫 CALL BLOCKED (assistant-request): Agency ${agency.name} subscription not active (${agency.subscription_status})`);
        return res.status(200).json(buildDisconnectedAssistantConfig(client.business_name));
      }
      if ((agency.subscription_status === 'trial' || agency.subscription_status === 'trialing') && isTrialExpired(agency.trial_ends_at)) {
        console.log(`🚫 CALL BLOCKED (assistant-request): Agency ${agency.name} trial expired`);
        await supabase.from('agencies').update({ subscription_status: 'expired' }).eq('id', agency.id);
        return res.status(200).json(buildDisconnectedAssistantConfig(client.business_name));
      }
    }

    const clientValidStatuses = ['active', 'trial'];
    if (!clientValidStatuses.includes(client.subscription_status)) {
      console.log(`🚫 CALL BLOCKED (assistant-request): ${client.business_name} subscription not active (${client.subscription_status})`);
      return res.status(200).json(buildDisconnectedAssistantConfig(client.business_name));
    }

    if (client.subscription_status === 'trial' && isTrialExpired(client.trial_ends_at)) {
      console.log(`🚫 CALL BLOCKED (assistant-request): ${client.business_name} trial expired`);
      await supabase.from('clients').update({ subscription_status: 'trial_expired', status: 'suspended' }).eq('id', client.id);
      return res.status(200).json(buildDisconnectedAssistantConfig(client.business_name));
    }

    const currentCallCount = client.calls_this_month || 0;
    const callLimit = client.monthly_call_limit ?? 50;
    if (callLimit !== -1 && currentCallCount >= callLimit) {
      console.log(`🚫 CALL BLOCKED (assistant-request): ${client.business_name} reached call limit (${currentCallCount}/${callLimit})`);
      return res.status(200).json({
        assistant: {
          model: { provider: 'openai', model: 'gpt-3.5-turbo', temperature: 0.1,
            messages: [{ role: 'system', content: `You are answering the phone for ${client.business_name}. Say: "Thank you for calling ${client.business_name}. We're currently unable to take your call through our automated system. Please try again later or reach the business directly. Goodbye." Then end the call using the endCall tool.` }],
            tools: [{ type: 'endCall' }]
          },
          voice: { provider: 'openai', voiceId: 'alloy' },
          firstMessage: `Thank you for calling ${client.business_name}. We're currently unable to take your call through our automated system. Please try again later or reach the business directly. Goodbye.`,
          maxDurationSeconds: 15, recordingEnabled: false
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════════
    // CLIENT IS ACTIVE — Build the full dynamic assistant config
    // ═══════════════════════════════════════════════════════════════════
    let callerContext = null;
    if (callerPhone && callerPhone !== 'Unknown') {
      try {
        let normalizedCaller = callerPhone;
        if (!normalizedCaller.startsWith('+')) {
          const digits = normalizedCaller.replace(/\D/g, '');
          if (digits.length === 10) normalizedCaller = `+1${digits}`;
          else if (digits.length === 11 && digits.startsWith('1')) normalizedCaller = `+${digits}`;
        }
        const { data: contact, error } = await supabase
          .from('client_contacts')
          .select('name, phone, email, total_calls, last_call_at, ai_summary, notes, tags, status')
          .eq('client_id', client.id).eq('phone', normalizedCaller).single();
        if (!error && contact && contact.name !== 'Unknown') {
          callerContext = contact;
          console.log(`📇 Recognized caller: ${contact.name} (${contact.total_calls} previous calls)`);
        } else { console.log(`📇 Unknown caller: ${callerPhone}`); }
      } catch (contactErr) { console.warn('⚠️ Contact lookup failed (non-fatal):', contactErr.message); }
    }

    const assistantConfig = await buildDynamicAssistantConfig(client, agency, callerContext);
    const elapsed = Date.now() - startTime;
    console.log(`✅ Assistant config built in ${elapsed}ms`);
    if (callerContext) console.log(`   🎯 Personalized greeting for ${callerContext.name}`);

    return res.status(200).json({ assistant: assistantConfig });

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`❌ Assistant-request failed after ${elapsed}ms:`, error.message);

    try {
      const vapiPhoneNumber = message.phoneNumber?.number;
      if (vapiPhoneNumber) {
        const { data: fallbackClient } = await supabase.from('clients').select('vapi_assistant_id, subscription_status').eq('vapi_phone_number', vapiPhoneNumber).single();
        if (fallbackClient?.vapi_assistant_id) {
          const fallbackValidStatuses = ['active', 'trial'];
          if (!fallbackValidStatuses.includes(fallbackClient.subscription_status)) {
            console.log(`🚫 Fallback also blocked — client subscription: ${fallbackClient.subscription_status}`);
            return res.status(200).json(buildDisconnectedAssistantConfig(null));
          }
          console.log(`🔄 Falling back to static assistant: ${fallbackClient.vapi_assistant_id}`);
          return res.status(200).json({ assistantId: fallbackClient.vapi_assistant_id });
        }
      }
    } catch (fallbackErr) { console.error('❌ Even fallback failed:', fallbackErr.message); }

    return res.status(500).json({ error: 'Failed to build assistant config' });
  }
}

// ============================================================================
// MAIN WEBHOOK HANDLER
// ============================================================================
async function handleVapiWebhook(req, res) {
  try {
    const message = req.body.message;

    if (message?.type === 'assistant-request') return handleAssistantRequest(req, res, message);

    if (message?.type === 'tool-calls' || message?.type === 'function-call') {
      const vapiPhone = message.phoneNumber?.number || message.call?.phoneNumber?.number || null;
      let isDemoCall = false;
      if (vapiPhone) {
        // Check industry demo numbers first, then agency demo numbers
        const industryMatch = getIndustryDemoByPhone(vapiPhone);
        if (industryMatch) { isDemoCall = true; }
        else { const demoCheck = await getAgencyByDemoPhone(vapiPhone); isDemoCall = !!demoCheck; }
      }
      if (!isDemoCall && !vapiPhone) {
        const phoneNumberId = message.call?.phoneNumberId || message.phoneNumber?.id;
        if (phoneNumberId) {
          const lookedUpNumber = await getPhoneNumberFromVapi(phoneNumberId);
          if (lookedUpNumber) {
            const industryMatch = getIndustryDemoByPhone(lookedUpNumber);
            if (industryMatch) { isDemoCall = true; message.phoneNumber = { ...(message.phoneNumber || {}), number: lookedUpNumber }; }
            else { const demoCheck2 = await getAgencyByDemoPhone(lookedUpNumber); isDemoCall = !!demoCheck2; if (isDemoCall) message.phoneNumber = { ...(message.phoneNumber || {}), number: lookedUpNumber }; }
          }
        }
      }
      if (isDemoCall) return handleDemoToolCall(req, res, message);
      console.log(`🔧 Tool-call received (non-demo) — acknowledging`);
      return res.status(200).json({ received: true });
    }

    console.log('📞 VAPI webhook received');

    if (message?.type !== 'end-of-call-report') return res.status(200).json({ received: true });
    
    const call = message.call;
    const phoneNumberId = call.phoneNumberId;
    const phoneNumber = await getPhoneNumberFromVapi(phoneNumberId);
    if (!phoneNumber) { console.log('⚠️ Could not get phone number from VAPI'); return res.status(200).json({ received: true }); }
    
    console.log('📱 Phone number:', phoneNumber);
    const client = await getClientByVapiPhoneNumber(phoneNumber);
    
    if (!client) {
      console.log('⚠️ No client found for phone:', phoneNumber);
      console.log('🔍 Checking if this is a demo call...');

      // Check industry demo numbers first
      const industryKey = getIndustryDemoByPhone(phoneNumber);
      if (industryKey) {
        console.log(`✅ Industry demo call detected (${industryKey})`);
        let demoAgency = await getAgencyByDemoPhone(phoneNumber);
        if (!demoAgency) demoAgency = { name: 'CallBird', phone: null };
        const result = await handleDemoCall(demoAgency, message);
        return res.status(200).json({ received: true, demo: true, industry: industryKey, ...result });
      }

      const demoAgency = await getAgencyByDemoPhone(phoneNumber);
      if (demoAgency) {
        console.log(`✅ Demo call detected for agency: ${demoAgency.name}`);
        const result = await handleDemoCall(demoAgency, message);
        return res.status(200).json({ received: true, demo: true, ...result });
      }
      console.log('⚠️ Not a demo call either — ignoring');
      return res.status(200).json({ received: true });
    }
    
    console.log('✅ Client found:', client.business_name);
    console.log('🏢 Agency:', client.agencies?.name || 'Direct (no agency)');
    const agency = client.agencies;
    
    if (agency) {
      const agencyValidStatuses = ['active', 'trial', 'trialing'];
      if (!agencyValidStatuses.includes(agency.subscription_status)) {
        console.log(`🚫 CALL BLOCKED: Agency ${agency.name} subscription not active`);
        return res.status(200).json({ received: true, blocked: true, reason: 'Agency subscription not active' });
      }
      if ((agency.subscription_status === 'trial' || agency.subscription_status === 'trialing') && isTrialExpired(agency.trial_ends_at)) {
        console.log(`🚫 CALL BLOCKED: Agency ${agency.name} trial expired`);
        await supabase.from('agencies').update({ subscription_status: 'expired' }).eq('id', agency.id);
        return res.status(200).json({ received: true, blocked: true, reason: 'Agency trial expired' });
      }
    }
    
    const validStatuses = ['active', 'trial'];
    if (!validStatuses.includes(client.subscription_status)) {
      console.log(`🚫 CALL BLOCKED: ${client.business_name} subscription not active`);
      return res.status(200).json({ received: true, blocked: true, reason: 'Subscription not active' });
    }
    
    if (client.subscription_status === 'trial' && isTrialExpired(client.trial_ends_at)) {
      console.log(`🚫 CALL BLOCKED: ${client.business_name} trial expired`);
      await supabase.from('clients').update({ subscription_status: 'expired' }).eq('id', client.id);
      return res.status(200).json({ received: true, blocked: true, reason: 'Trial expired' });
    }
    
    const currentCallCount = client.calls_this_month || 0;
    const callLimit = client.monthly_call_limit ?? 50;
    
    if (callLimit !== -1 && currentCallCount >= callLimit) {
      console.log(`🚫 CALL BLOCKED: ${client.business_name} reached limit`);
      if (currentCallCount === callLimit) await sendLimitReachedEmail(client, agency, callLimit);
      return res.status(200).json({ received: true, blocked: true, reason: 'Monthly call limit reached' });
    }
    
    if (callLimit === -1) console.log(`♾️ Unlimited plan — no call cap`);
    else console.log(`📊 Usage: ${currentCallCount}/${callLimit} calls`);
    
    const transcript = message.transcript || '';
    const callerPhone = call.customer?.number || 'Unknown';
    const aiData = await generateAISummary(transcript, client.industry || 'professional_services', callerPhone);
    const { customerName, customerPhone, customerEmail, urgency, summary: aiSummary, isSpam, spamReason } = aiData;
    
    const recordingUrl = message.recordingUrl || message.artifact?.recordingUrl || call.recordingUrl || null;
    const durationSeconds = call.duration || message.duration || message.call?.duration || message.artifact?.duration || null;
    if (durationSeconds) console.log(`⏱️ Call duration: ${durationSeconds} seconds`);
    
    const endedReason = call.endedReason || message.endedReason || null;
    const { transferStatus, wasTransferred } = detectTransferStatus(endedReason, transcript);
    if (wasTransferred) console.log(`📲 Call was TRANSFERRED (endedReason: ${endedReason})`);
    else if (transferStatus === 'transfer_failed') console.log(`❌ Transfer FAILED (endedReason: ${endedReason})`);
    else console.log(`📞 Call ended normally (endedReason: ${endedReason || 'unknown'})`);
    
    // SPAM FAST PATH
    if (isSpam) {
      console.log(`🚫 SPAM DETECTED: ${spamReason || 'Unknown spam type'}`);
      const spamCallRecord = {
        client_id: client.id, customer_name: customerName || 'Spam Caller',
        customer_phone: customerPhone || callerPhone, customer_email: null,
        ai_summary: aiSummary, transcript, recording_url: recordingUrl,
        duration_seconds: durationSeconds, urgency_level: 'spam', call_status: 'spam',
        ended_reason: endedReason, transfer_status: null,
        is_spam: true, spam_reason: spamReason, created_at: new Date().toISOString()
      };
      const { data: insertedSpamCall, error: spamInsertError } = await supabase.from('calls').insert([spamCallRecord]).select();
      if (spamInsertError) {
        if (spamInsertError.message && (spamInsertError.message.includes('is_spam') || spamInsertError.message.includes('spam_reason') || spamInsertError.message.includes('ended_reason') || spamInsertError.message.includes('transfer_status'))) {
          delete spamCallRecord.is_spam; delete spamCallRecord.spam_reason; delete spamCallRecord.ended_reason; delete spamCallRecord.transfer_status;
          await supabase.from('calls').insert([spamCallRecord]).select();
        } else { console.error('❌ Error inserting spam call:', spamInsertError); }
      }
      console.log('✅ Spam call saved (not counted against limit)');
      if (client.owner_phone) { try { await sendSpamBlockedSMS(client, agency, callerPhone, spamReason); } catch {} }
      return res.status(200).json({ received: true, saved: true, spam: true, spamReason, callId: insertedSpamCall?.[0]?.id || null });
    }
    
    // Save call (normal)
    const callRecord = {
      client_id: client.id, customer_name: customerName, customer_phone: customerPhone,
      customer_email: customerEmail, ai_summary: aiSummary, transcript,
      recording_url: recordingUrl, duration_seconds: durationSeconds, urgency_level: urgency,
      call_status: wasTransferred ? 'transferred' : 'completed',
      ended_reason: endedReason, transfer_status: transferStatus,
      is_spam: false, spam_reason: null, created_at: new Date().toISOString()
    };
    const { data: insertedCall, error: insertError } = await supabase.from('calls').insert([callRecord]).select();
    if (insertError) {
      if (insertError.message && (insertError.message.includes('ended_reason') || insertError.message.includes('transfer_status') || insertError.message.includes('is_spam') || insertError.message.includes('spam_reason'))) {
        delete callRecord.ended_reason; delete callRecord.transfer_status; delete callRecord.is_spam; delete callRecord.spam_reason; callRecord.call_status = 'completed';
        var { data: insertedCallFinal, error: retryError } = await supabase.from('calls').insert([callRecord]).select();
        if (retryError) { console.error('❌ Retry insert failed:', retryError); return res.status(500).json({ error: 'Failed to save call' }); }
      } else { console.error('❌ Error inserting call:', insertError); return res.status(500).json({ error: 'Failed to save call' }); }
    }
    const savedCall = insertedCall || insertedCallFinal;
    console.log('✅ Call saved successfully');
    
    try {
      const { contact, isNew } = await upsertContactFromCall({
        clientId: client.id, agencyId: agency?.id, callId: savedCall?.[0]?.id,
        customerPhone, customerName, customerEmail,
        customerAddress: call.customer?.address || null,
        aiSummary, urgency, serviceRequested: call.customer?.serviceRequested || null,
      });
      if (contact) console.log(`📇 Contact ${isNew ? 'created' : 'updated'}: ${contact.name} (${contact.phone})`);
    } catch (contactErr) { console.warn('⚠️ Contact upsert failed (non-fatal):', contactErr.message); }
    
    const newCallCount = currentCallCount + 1;
    const isFirstCall = newCallCount === 1;
    const updateData = { calls_this_month: newCallCount };
    if (isFirstCall) { updateData.first_call_received = true; updateData.first_call_received_at = new Date().toISOString(); console.log('🎉 FIRST CALL for:', client.business_name); }
    await supabase.from('clients').update(updateData).eq('id', client.id);
    
    if (callLimit !== -1) {
      const usagePercent = (newCallCount / callLimit) * 100;
      if (usagePercent >= 80 && usagePercent < 100 && newCallCount === Math.floor(callLimit * 0.8)) await sendUsageWarningEmail(client, agency, newCallCount, callLimit);
      if (newCallCount >= callLimit && newCallCount === callLimit) await sendLimitReachedEmail(client, agency, callLimit);
    }
    
    let smsSent = false;
    let emailSent = false;
    
    if (client.owner_phone) { smsSent = await sendCallNotificationSMS(client, agency, aiData); if (smsSent) console.log('✅ SMS notification sent'); }
    await notifyTeamMembers(client.id, aiData, agency);
    
    if (isFeatureEnabled(client, agency, 'email_summaries') && client.email) {
      const emailResult = await sendCallSummaryEmail(client, agency, aiData, { duration_seconds: durationSeconds, transcript, created_at: savedCall?.[0]?.created_at || new Date().toISOString() });
      emailSent = emailResult?.success || false;
    }
    
    return res.status(200).json({
      received: true, saved: true, callId: savedCall?.[0]?.id,
      smsSent, emailSent, firstCall: isFirstCall,
      agency: agency?.name || null, duration: durationSeconds,
      endedReason, transferStatus, wasTransferred, spam: false
    });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}

module.exports = { handleVapiWebhook };