// ============================================================================
// VAPI WEBHOOK HANDLER - Multi-Tenant Aware
// UPDATED: 2026-05-05 — Comprehensive demo call summary with AI extraction,
//   fixed duration extraction, personalized SMS
// UPDATED: 2026-05-06 — Usage record tracking for metered billing (Phase 1)
// UPDATED: 2026-05-09 — Demo SMS: area code location, actionable follow-up,
//   sendAndLogSMS for full SMS logging
// UPDATED: 2026-05-14 — Multilingual: English-enforced summaries, callLanguage
//   extraction, call_language stored on every call record
// UPDATED: 2026-05-19 — Fix: demo admin SMS summary truncation cuts at word
//   boundary (300 char limit) instead of mid-word at 200
// UPDATED: 2026-05-20 — Save demo calls to demo_calls table for dashboard display.
// UPDATED: 2026-05-22 — Fix: Claude model string claude-sonnet-4-6 (was 404ing
//   with invalid dated version). Fix: demo_calls insert now checks Supabase
//   error return instead of silently succeeding.
// ============================================================================
const { supabase, getClientByVapiPhoneNumber } = require('../lib/supabase');
const { getPhoneNumberFromVapi } = require('../lib/vapi');
const { sendCallNotificationSMS, sendDemoCallFollowUpSMS, sendCallSummaryEmail, sendSpamBlockedSMS } = require('../lib/notifications');
const { upsertContactFromCall } = require('../lib/contact-upsert');
const { buildDynamicAssistantConfig } = require('../lib/assistant-config-builder');
const { notifyTeamMembers } = require('../lib/team-notifications');
const { buildDemoDynamicConfig, buildDemoSmsContent, getIndustryDemoByPhone, buildIndustryDemoConfig } = require('../lib/demo-config');
const { getSmsTemplate } = require('../lib/sms-templates');
const { sendAndLogSMS } = require('../lib/sms-logger');
const { formatPhone, getPhoneLocation, formatDuration } = require('../lib/area-codes');
const { insertUsageRecord } = require('../lib/usage-tracker');

const DEFAULT_PLAN_FEATURES = {
  starter: { sms_notifications: true, email_summaries: false, custom_greeting: false, custom_voice: false, knowledge_base: false, business_hours: false, advanced_analytics: false, priority_support: false },
  pro: { sms_notifications: true, email_summaries: true, custom_greeting: true, custom_voice: false, knowledge_base: true, business_hours: true, advanced_analytics: true, priority_support: false },
  growth: { sms_notifications: true, email_summaries: true, custom_greeting: true, custom_voice: true, knowledge_base: true, business_hours: true, advanced_analytics: true, priority_support: true },
};

function isFeatureEnabled(client, agency, featureKey) {
  const planType = client.plan_type || 'starter';
  const planConfig = agency?.plan_features?.[planType] || DEFAULT_PLAN_FEATURES[planType];
  if (!planConfig) return true;
  return planConfig[featureKey] !== false;
}

function detectTransferStatus(endedReason, transcript) {
  if (!endedReason) return { transferStatus: null, wasTransferred: false };
  if (endedReason === 'assistant-forwarded-call') return { transferStatus: 'transferred', wasTransferred: true };
  if (endedReason === 'pipeline-error') {
    const transferAttempted = transcript && (
      transcript.toLowerCase().includes('let me connect you') || transcript.toLowerCase().includes('let me transfer') ||
      transcript.toLowerCase().includes('let me get the team') || transcript.toLowerCase().includes('let me grab someone') ||
      transcript.toLowerCase().includes('i\'ll connect you'));
    if (transferAttempted) return { transferStatus: 'transfer_failed', wasTransferred: false };
  }
  return { transferStatus: null, wasTransferred: false };
}

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
  const prompt = `Analyze this phone call transcript for a ${industry} business.\n\nTranscript:\n${transcript}\n\nCaller Phone: ${callerPhone}\n\nExtract and return ONLY valid JSON:\n{"customerName":"string or Unknown","customerPhone":"formatted (XXX) XXX-XXXX","customerEmail":"string or null","urgency":"emergency|high|medium|routine","summary":"2-3 sentence summary IN ENGLISH focusing on: ${industryGuidance[industry] || 'what the customer needs'}","callLanguage":"two-letter language code of the language spoken during the call, e.g. en or es","isSpam":false,"spamReason":null}\n\nIMPORTANT: Always write the summary in English, even if the call was conducted in Spanish or another language. If the call was not in English, note the language in the callLanguage field and begin the summary with the language spoken (e.g. "Spanish-language call.").\n\nSPAM DETECTION: Set isSpam true ONLY if the caller is clearly a telemarketer, robocall, or solicitor. Indicators: plays a pre-recorded message or sales pitch, tries to sell a product or service TO the business (SEO, Google Ads, insurance leads, credit card processing, etc.), opens the call by asking for "the business owner" or "the person in charge of your Google listing" with no prior natural conversation, the line goes silent after connecting, or uses high-pressure sales tactics. Do NOT mark as spam if: the caller is a real customer asking a question, requesting service, or asking to speak with someone — even if the interaction is short. When in doubt, set isSpam to false.`;
  try {
    const _ac1 = new AbortController();
    const _t1 = setTimeout(() => _ac1.abort(), 15000);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      signal: _ac1.signal,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, temperature: 0.3, messages: [{ role: "user", content: prompt }] })
    });
    clearTimeout(_t1);
    if (!response.ok) throw new Error(`Claude API failed: ${response.status}`);
    const data = await response.json();
    let text = data.content[0].text.trim().replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(text);
    parsed.isSpam = parsed.isSpam === true;
    if (!parsed.isSpam) parsed.spamReason = null;
    return parsed;
  } catch (error) {
    console.error('❌ AI summary failed:', error.message);
    return { customerName: 'Unknown', customerPhone: callerPhone, customerEmail: null, urgency: 'routine',
      summary: `Customer called regarding ${industry.replace('_', ' ')} services.`, callLanguage: 'en', isSpam: false, spamReason: null };
  }
}

async function sendUsageWarningEmail(client, agency, currentCalls, limit) { console.log(`📧 [STUB] 80% usage warning`); }
async function sendLimitReachedEmail(client, agency, limit) { console.log(`📧 [STUB] Limit reached`); }

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

async function getAgencyById(agencyId) {
  try {
    const { data, error } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
    if (error || !data) return null;
    return data;
  } catch { return null; }
}

async function resolveAgencyForDemo(phoneNumber) {
  const industryMatch = getIndustryDemoByPhone(phoneNumber);
  if (industryMatch) {
    const agency = await getAgencyById(industryMatch.agencyId);
    if (agency) return { agency, industryKey: industryMatch.industry };
    return { agency: { id: industryMatch.agencyId, name: 'CallBird AI', slug: 'callbird' }, industryKey: industryMatch.industry };
  }
  const agency = await getAgencyByDemoPhone(phoneNumber);
  if (agency) return { agency, industryKey: null };
  return { agency: null, industryKey: null };
}

function buildDisconnectedAssistantConfig(businessName) {
  return { assistant: {
    model: { provider: 'openai', model: 'gpt-3.5-turbo', temperature: 0.1,
      messages: [{ role: 'system', content: `Say: "We're sorry, the number for ${businessName || 'this business'} is no longer in service. Goodbye." Then end the call.` }],
      tools: [{ type: 'endCall' }] },
    voice: { provider: 'openai', voiceId: 'alloy' },
    firstMessage: `We're sorry, the number for ${businessName || 'this business'} is no longer in service. Goodbye.`,
    maxDurationSeconds: 15, recordingEnabled: false
  }};
}

// ============================================================================
// EXTRACT BUSINESS NAME FROM VAPI END-OF-CALL DATA
// ============================================================================
function extractBusinessNameFromCall(message) {
  const structured = message.analysis?.structuredData
    || message.artifact?.structuredData
    || message.call?.analysis?.structuredData
    || null;
  if (structured?.business_name) return structured.business_name;

  const transcript = message.transcript || message.artifact?.transcript || '';
  if (transcript) {
    const match = transcript.match(/(?:practice|business|company|office)\s+(?:is\s+)?(?:called\s+)?["']?([A-Z][A-Za-z\s&'.]+?)["']?\s*[.,!?]/);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

// ============================================================================
// GENERATE DEMO CALL SUMMARY (AI extraction via Claude)
// ============================================================================
async function generateDemoSummary(transcript, callerPhone, industryKey) {
  if (!transcript || transcript.length < 50) return null;

  console.log('🤖 Generating demo call summary...');

  const industryHint = industryKey ? `\nDemo Type: ${industryKey} industry demo` : '';
  const prompt = `Analyze this AI receptionist DEMO call transcript. This is a sales demo where the AI showed a business owner how it would answer their phones.

Transcript:
${transcript}

Caller Phone: ${callerPhone || 'Unknown'}${industryHint}

Extract and return ONLY valid JSON — no backticks, no extra text:
{
  "businessName": "the caller's business name, or null if not mentioned",
  "businessType": "type of business like dental, plumbing, restaurant, law firm — or null",
  "callerName": "the caller's personal name if mentioned, or null",
  "interestLevel": "high if they asked about pricing, signup, features, or seemed excited; medium if engaged but noncommittal; low if disinterested or ended quickly",
  "serviceDiscussed": "the specific scenario roleplayed in one short phrase, e.g. 'emergency dental appointment booking' or 'plumbing leak repair intake' — or null",
  "askedQuestions": true or false — did the caller ask follow-up questions about the product after the roleplay,
  "summary": "2-3 sentence summary in English covering: what business they run, what the AI demonstrated for them, and their reaction/interest level"
}`;

  try {
    const _ac2 = new AbortController();
    const _t2 = setTimeout(() => _ac2.abort(), 15000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      signal: _ac2.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    clearTimeout(_t2);
    if (!response.ok) throw new Error(`Claude API failed: ${response.status}`);

    const data = await response.json();
    let text = data.content[0].text.trim()
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = JSON.parse(text);

    return {
      businessName: parsed.businessName || null,
      businessType: parsed.businessType || null,
      callerName: parsed.callerName || null,
      interestLevel: parsed.interestLevel || 'medium',
      serviceDiscussed: parsed.serviceDiscussed || null,
      askedQuestions: parsed.askedQuestions === true,
      summary: parsed.summary || null,
    };
  } catch (error) {
    console.error('❌ Demo AI summary failed:', error.message);
    return null;
  }
}

// ============================================================================
// HANDLE DEMO CALL (end-of-call)
// ============================================================================
async function handleDemoCall(agency, message, industryKey = null) {
  const call = message.call;
  const callerPhone = call.customer?.number || null;

  let durationSeconds = call.duration
    || message.duration
    || message.artifact?.duration
    || message.durationSeconds
    || null;

  if (!durationSeconds && call.startedAt && call.endedAt) {
    durationSeconds = Math.round(
      (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000
    );
  }

  console.log(`🎤 Demo call completed for agency: ${agency.name}${industryKey ? ` (${industryKey} demo)` : ''}`);

  const vapiAnalysis = message.analysis || {};
  const vapiStructured = vapiAnalysis.structuredData
    || message.artifact?.structuredData
    || call.analysis?.structuredData
    || null;
  const vapiSummary = vapiAnalysis.summary
    || message.artifact?.summary
    || call.analysis?.summary
    || null;
  const vapiSuccessScore = vapiAnalysis.successEvaluation
    || call.analysis?.successEvaluation
    || null;

  let businessName = vapiStructured?.business_name || extractBusinessNameFromCall(message) || null;
  let businessType = vapiStructured?.business_type || industryKey || null;
  let interestLevel = vapiStructured?.interest_level || null;
  let serviceDiscussed = vapiStructured?.service_discussed || null;
  let callerName = vapiStructured?.caller_name || null;
  let askedQuestions = vapiStructured?.asked_questions || false;
  let summary = vapiSummary || null;

  const transcript = message.transcript || message.artifact?.transcript || '';
  if (transcript && (!businessName || !summary)) {
    try {
      const demoSummary = await generateDemoSummary(transcript, callerPhone, industryKey);
      if (demoSummary) {
        businessName = businessName || demoSummary.businessName;
        businessType = businessType || demoSummary.businessType;
        interestLevel = interestLevel || demoSummary.interestLevel;
        serviceDiscussed = serviceDiscussed || demoSummary.serviceDiscussed;
        callerName = callerName || demoSummary.callerName;
        askedQuestions = askedQuestions || demoSummary.askedQuestions;
        summary = summary || demoSummary.summary;
      }
    } catch (err) {
      console.warn('⚠️ Demo AI summary failed:', err.message);
    }
  }

  const { formatPhoneDisplay } = require('../lib/notifications');

  const callerFormatted = callerPhone ? formatPhone(callerPhone) : 'Unknown';
  const callerLocation = callerPhone ? getPhoneLocation(callerPhone) : null;
  const callerDisplay = callerLocation
    ? `${callerFormatted} · ${callerLocation}`
    : callerFormatted;

  const durationDisplay = durationSeconds
    ? formatDuration(durationSeconds)
    : null;

  const businessLabel = businessName
    ? (businessType ? `${businessName} (${businessType.replace(/_/g, ' ')})` : businessName)
    : (businessType ? businessType.replace(/_/g, ' ') : null);

  if (businessName) console.log(`   📋 Business: ${businessLabel}`);
  if (interestLevel) console.log(`   📊 Interest: ${interestLevel}`);
  if (durationDisplay) console.log(`   ⏱ Duration: ${durationDisplay}`);

  // ════════════════════════════════════════════════════════════════════════
  // CALLER FOLLOW-UP SMS
  // ════════════════════════════════════════════════════════════════════════
  if (callerPhone && callerPhone !== 'Unknown') {
    try {
      if (industryKey) {
        const displayName = industryKey.replace(/_/g, ' ');
        const nameNote = businessName ? ` for ${businessName}` : '';
        const lines = [
          `Thanks for trying the ${displayName} AI receptionist demo${nameNote}! 🎉`,
          '',
        ];
        if (serviceDiscussed) {
          lines.push(`Here's what we covered:`);
          lines.push(`✅ ${serviceDiscussed}`);
          lines.push(`✅ Instant text summaries after every call`);
          lines.push(`✅ 24/7 coverage, unlimited simultaneous calls`);
          lines.push('');
        }
        lines.push(`Questions? Give us a call back anytime.`);

        await sendAndLogSMS({
          phone: callerPhone,
          message: lines.join('\n'),
          agencyId: agency.id,
          recipientType: 'prospect',
          messageType: 'demo_followup_industry',
          metadata: { industryKey, businessName, businessType },
        });
        console.log('✅ Industry demo follow-up SMS sent');

      } else if (agency.demo_followup_sms_override) {
        await sendAndLogSMS({
          phone: callerPhone,
          message: agency.demo_followup_sms_override,
          agencyId: agency.id,
          recipientType: 'prospect',
          messageType: 'demo_followup_custom',
          metadata: { businessName, businessType, custom: true },
        });
        console.log('✅ Demo follow-up SMS sent (custom override)');

      } else {
        const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
        let signupUrl;
        if (agency.marketing_domain && agency.domain_verified) {
          signupUrl = `https://${agency.marketing_domain}/signup`;
        } else if (agency.slug) {
          signupUrl = `https://${agency.slug}.${platformDomain}/signup`;
        } else {
          signupUrl = `https://${platformDomain}/signup`;
        }

        const agencyName = agency.name || 'our';
        const nameNote = businessName ? ` for ${businessName}` : '';

        const lines = [];

        if (businessName) {
          lines.push(`Thanks for trying ${agencyName}'s AI receptionist${nameNote}! 🎉`);
          lines.push('');
          lines.push(`That demo showed exactly how AI would answer calls for ${businessName} — 24/7, with instant text summaries after every call.`);
        } else {
          lines.push(`Thanks for trying ${agencyName}'s AI receptionist! 🎉`);
          lines.push('');
          lines.push(`What you just experienced is exactly how AI would answer your business calls — 24/7, no missed calls, instant summaries.`);
        }

        lines.push('');
        lines.push(`Ready to get this${businessName ? ` for ${businessName}` : ' for your business'}? Start free, no credit card needed:`);
        lines.push(signupUrl);

        await sendAndLogSMS({
          phone: callerPhone,
          message: lines.join('\n'),
          agencyId: agency.id,
          recipientType: 'prospect',
          messageType: 'demo_followup',
          metadata: { businessName, businessType, serviceDiscussed },
        });
        console.log('✅ Demo follow-up SMS sent');
      }
    } catch (smsErr) {
      console.warn('⚠️ Demo follow-up SMS failed:', smsErr.message);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // ADMIN NOTIFICATION SMS (to agency owner)
  // ════════════════════════════════════════════════════════════════════════
  if (agency.phone) {
    try {
      const lines = [];
      lines.push(`🎤 Demo Call — ${agency.name}`);
      lines.push(`━━━━━━━━━━━━━━━━━━`);
      lines.push(`📞 ${callerDisplay}`);
      if (businessLabel) lines.push(`🏢 ${businessLabel}`);
      if (callerName && callerName !== 'Unknown') lines.push(`👤 ${callerName}`);
      if (durationDisplay) lines.push(`⏱ ${durationDisplay}`);

      if (interestLevel) {
        const emoji = interestLevel === 'high' ? '🔥' : interestLevel === 'medium' ? '👀' : '❄️';
        lines.push(`${emoji} Interest: ${interestLevel.toUpperCase()}`);
      }
      if (askedQuestions) lines.push(`❓ Asked follow-up questions`);
      if (vapiSuccessScore) lines.push(`📊 Demo score: ${vapiSuccessScore}/10`);

      if (summary) {
        lines.push(`━━━━━━━━━━━━━━━━━━`);
        let truncSummary = summary;
        if (summary.length > 300) {
          truncSummary = summary.slice(0, 297);
          const lastSpace = truncSummary.lastIndexOf(' ');
          if (lastSpace > 200) truncSummary = truncSummary.slice(0, lastSpace);
          truncSummary += '...';
        }
        lines.push(truncSummary);
      }

      lines.push(`━━━━━━━━━━━━━━━━━━`);
      if (interestLevel === 'high') {
        lines.push(`💡 Hot lead — follow up within the hour.`);
      } else if (interestLevel === 'medium') {
        lines.push(`💡 Warm lead — follow up within 24 hours.`);
      } else {
        lines.push(callerPhone && callerPhone !== 'Unknown'
          ? `✅ Follow-up SMS sent to caller`
          : `⚠️ No caller phone — follow-up not sent`
        );
      }

      await sendAndLogSMS({
        phone: agency.phone,
        message: lines.join('\n'),
        agencyId: agency.id,
        recipientType: 'agency_owner',
        messageType: 'demo_admin',
        metadata: {
          callerPhone,
          callerLocation,
          businessName,
          businessType,
          interestLevel,
          durationSeconds,
        },
      });
      console.log('✅ Admin demo notification sent');
    } catch (ownerSmsErr) {
      console.warn('⚠️ Agency owner notification failed:', ownerSmsErr.message);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // SAVE DEMO CALL TO DATABASE
  // Stores full call data so agencies can review demo calls in their
  // dashboard with transcripts, recordings, and AI summaries.
  // ════════════════════════════════════════════════════════════════════════
  try {
    const recordingUrl = message.recordingUrl || message.artifact?.recordingUrl || call.recordingUrl || null;

    const { error: dbError } = await supabase.from('demo_calls').insert({
      agency_id: agency.id,
      caller_phone: callerPhone,
      caller_name: callerName || null,
      business_name: businessName || null,
      business_type: businessType || null,
      interest_level: interestLevel || 'medium',
      service_discussed: serviceDiscussed || null,
      asked_questions: askedQuestions || false,
      summary: summary || null,
      transcript: transcript || null,
      recording_url: recordingUrl,
      duration_seconds: durationSeconds ? Math.round(durationSeconds) : null,
      vapi_call_id: call.id || null,
      vapi_success_score: vapiSuccessScore || null,
      call_language: 'en',
      industry_key: industryKey || null,
      caller_location: callerLocation || null,
    });

    if (dbError) {
      console.error('❌ Demo call insert failed:', dbError.message, dbError.code, dbError.details);
    } else {
      console.log('✅ Demo call saved to database');
    }
  } catch (dbErr) {
    console.error('❌ Failed to save demo call (exception):', dbErr.message);
  }

  return {
    type: 'demo',
    agency: agency.name,
    callerPhone,
    callerName,
    callerBusinessName: businessName,
    businessType,
    interestLevel,
    serviceDiscussed,
    askedQuestions,
    durationSeconds,
    summary,
    vapiSuccessScore,
    followUpSent: !!(callerPhone && callerPhone !== 'Unknown'),
  };
}

const _demoSmsSent = new Map();
function hasDemoSmsSent(callId) {
  if (!callId) return false;
  if (_demoSmsSent.get(callId)) return true;
  _demoSmsSent.set(callId, Date.now());
  for (const [k, v] of _demoSmsSent) { if (Date.now() - v > 5 * 60 * 1000) _demoSmsSent.delete(k); }
  return false;
}

async function handleDemoToolCall(req, res, message) {
  const startTime = Date.now();
  try {
    const callId = message.call?.id || message.callId || null;
    if (hasDemoSmsSent(callId))
      return res.status(200).json({ results: [{ toolCallId: message.toolCallList?.[0]?.id || 'dedup', result: 'Already sent the text.' }] });

    const toolCallList = message.toolCallList || message.toolCalls || [];
    const toolCall = toolCallList[0];
    if (!toolCall) return res.status(200).json({ results: [{ result: 'No tool call found.' }] });

    const toolCallId = toolCall.id;
    const funcName = toolCall.function?.name || toolCall.name;
    const rawArgs = toolCall.function?.arguments || toolCall.arguments || '{}';
    const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    console.log(`🔧 Demo tool-call: ${funcName}`);

    if (funcName !== 'send_demo_sms')
      return res.status(200).json({ results: [{ toolCallId, result: 'Unknown function.' }] });

    const callerPhone = message.call?.customer?.number || message.customer?.number || null;
    if (!callerPhone || callerPhone === 'Unknown')
      return res.status(200).json({ results: [{ toolCallId, result: "I wasn't able to send the text — I don't have your phone number. But after every real call, your team would get an instant summary." }] });

    let vapiPhone = message.phoneNumber?.number || message.call?.phoneNumber?.number || null;
    if (!vapiPhone) {
      const phoneNumberId = message.call?.phoneNumberId || message.phoneNumber?.id;
      if (phoneNumberId) vapiPhone = await getPhoneNumberFromVapi(phoneNumberId);
    }
    let agency = null;
    if (vapiPhone) { const resolved = await resolveAgencyForDemo(vapiPhone); agency = resolved.agency; }
    if (!agency)
      return res.status(200).json({ results: [{ toolCallId, result: 'I just sent you a text — check your phone!' }] });

    const { formatPhoneDisplay, sendTelnyxSMS } = require('../lib/notifications');
    const callerDisplay = formatPhoneDisplay ? formatPhoneDisplay(callerPhone) : callerPhone;
    const smsContent = buildDemoSmsContent({
      business_name: args.business_name || 'Your Business', business_type: args.business_type || 'business',
      service_requested: args.service_requested || 'General inquiry', customer_name: args.customer_name || 'Customer',
      caller_phone_display: callerDisplay,
    }, agency);
    await sendTelnyxSMS(callerPhone, smsContent);
    console.log(`✅ Demo SMS sent to ${callerPhone} in ${Date.now() - startTime}ms`);
    return res.status(200).json({ results: [{ toolCallId, result: 'Done! The text has been sent to their phone with the full call summary.' }] });
  } catch (error) {
    console.error(`❌ Demo tool-call failed:`, error.message);
    return res.status(200).json({ results: [{ toolCallId: 'error', result: "I sent the text — check your phone!" }] });
  }
}

// ============================================================================
// ASSISTANT-REQUEST HANDLER
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
          message.phoneNumber = { ...message.phoneNumber, number: lookedUpNumber };
          return handleAssistantRequest(req, res, message);
        }
      }
      return res.status(200).json({ error: 'No phone number' });
    }

    const client = await getClientByVapiPhoneNumber(vapiPhoneNumber);

    if (!client) {
      console.log('⚠️ No client found for:', vapiPhoneNumber);
      const { agency: demoAgency, industryKey } = await resolveAgencyForDemo(vapiPhoneNumber);

      if (demoAgency && industryKey) {
        console.log(`🎯 Industry demo call (${industryKey}) — building config for: ${demoAgency.name}`);
        try {
          const demoConfig = buildIndustryDemoConfig(industryKey, demoAgency);
          console.log(`✅ Industry demo config built in ${Date.now() - startTime}ms`);
          return res.status(200).json({ assistant: demoConfig });
        } catch (indErr) {
          console.error(`❌ Industry demo config failed:`, indErr.message);
        }
      }

      if (demoAgency) {
        console.log(`🎤 Generic demo call — building config for: ${demoAgency.name}`);
        try {
          const demoConfig = buildDemoDynamicConfig(demoAgency);
          console.log(`✅ Generic demo config built in ${Date.now() - startTime}ms`);
          return res.status(200).json({ assistant: demoConfig });
        } catch (demoErr) {
          console.error('❌ Demo config failed:', demoErr.message);
          if (demoAgency.demo_assistant_id)
            return res.status(200).json({ assistantId: demoAgency.demo_assistant_id });
          return res.status(200).json({ error: 'Demo config failed' });
        }
      }

      return res.status(200).json({ error: 'Client not found' });
    }

    console.log(`✅ Client: ${client.business_name}`);
    const agency = client.agencies || null;

    if (agency) {
      if (!['active', 'trial', 'trialing'].includes(agency.subscription_status))
        return res.status(200).json(buildDisconnectedAssistantConfig(client.business_name));
      if (['trial', 'trialing'].includes(agency.subscription_status) && isTrialExpired(agency.trial_ends_at)) {
        await supabase.from('agencies').update({ subscription_status: 'expired' }).eq('id', agency.id);
        return res.status(200).json(buildDisconnectedAssistantConfig(client.business_name));
      }
    }

    if (!['active', 'trial'].includes(client.subscription_status))
      return res.status(200).json(buildDisconnectedAssistantConfig(client.business_name));
    if (client.subscription_status === 'trial' && isTrialExpired(client.trial_ends_at)) {
      await supabase.from('clients').update({ subscription_status: 'trial_expired', status: 'suspended' }).eq('id', client.id);
      return res.status(200).json(buildDisconnectedAssistantConfig(client.business_name));
    }

    const currentCallCount = client.calls_this_month || 0;
    const callLimit = client.monthly_call_limit ?? 50;
    if (callLimit !== -1 && currentCallCount >= callLimit) {
      return res.status(200).json({ assistant: {
        model: { provider: 'openai', model: 'gpt-3.5-turbo', temperature: 0.1,
          messages: [{ role: 'system', content: `Say: "Thank you for calling ${client.business_name}. We're currently unable to take your call. Goodbye." Then end the call.` }],
          tools: [{ type: 'endCall' }] },
        voice: { provider: 'openai', voiceId: 'alloy' },
        firstMessage: `Thank you for calling ${client.business_name}. We're currently unable to take your call. Goodbye.`,
        maxDurationSeconds: 15, recordingEnabled: false
      }});
    }

    let callerContext = null;
    if (callerPhone && callerPhone !== 'Unknown') {
      try {
        let n = callerPhone;
        if (!n.startsWith('+')) { const d = n.replace(/\D/g, ''); if (d.length === 10) n = `+1${d}`; else if (d.length === 11 && d.startsWith('1')) n = `+${d}`; }
        const { data: contact, error } = await supabase
          .from('client_contacts').select('name, phone, email, total_calls, last_call_at, ai_summary, notes, tags, status')
          .eq('client_id', client.id).eq('phone', n).single();
        if (!error && contact && contact.name !== 'Unknown') { callerContext = contact; console.log(`📇 Recognized: ${contact.name}`); }
        else console.log(`📇 Unknown caller: ${callerPhone}`);
      } catch (e) { console.warn('⚠️ Contact lookup failed:', e.message); }
    }

    const assistantConfig = await buildDynamicAssistantConfig(client, agency, callerContext);
    console.log(`✅ Assistant config built in ${Date.now() - startTime}ms`);
    return res.status(200).json({ assistant: assistantConfig });

  } catch (error) {
    console.error(`❌ Assistant-request CRASHED:`, error.message, error.stack);
    try {
      const v = message.phoneNumber?.number;
      if (v) {
        const { data: fb } = await supabase.from('clients').select('vapi_assistant_id, subscription_status').eq('vapi_phone_number', v).single();
        if (fb?.vapi_assistant_id && ['active', 'trial'].includes(fb.subscription_status))
          return res.status(200).json({ assistantId: fb.vapi_assistant_id });
      }
    } catch {}
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
      let vapiPhone = message.phoneNumber?.number || message.call?.phoneNumber?.number || null;
      if (!vapiPhone) {
        const pid = message.call?.phoneNumberId || message.phoneNumber?.id;
        if (pid) { vapiPhone = await getPhoneNumberFromVapi(pid); if (vapiPhone) message.phoneNumber = { ...(message.phoneNumber || {}), number: vapiPhone }; }
      }
      if (vapiPhone) { const { agency } = await resolveAgencyForDemo(vapiPhone); if (agency) return handleDemoToolCall(req, res, message); }
      console.log(`🔧 Tool-call received (non-demo) — acknowledging`);
      return res.status(200).json({ received: true });
    }

    console.log('📞 VAPI webhook received');
    if (message?.type !== 'end-of-call-report') return res.status(200).json({ received: true });

    const call = message.call;
    const phoneNumber = await getPhoneNumberFromVapi(call.phoneNumberId);
    if (!phoneNumber) return res.status(200).json({ received: true });

    console.log('📱 Phone number:', phoneNumber);
    const client = await getClientByVapiPhoneNumber(phoneNumber);

    if (!client) {
      console.log('⚠️ No client found for:', phoneNumber);
      const { agency: demoAgency, industryKey } = await resolveAgencyForDemo(phoneNumber);
      if (demoAgency) {
        console.log(`✅ Demo end-of-call${industryKey ? ` (${industryKey})` : ''}: ${demoAgency.name}`);
        const result = await handleDemoCall(demoAgency, message, industryKey);
        return res.status(200).json({ received: true, demo: true, industry: industryKey, ...result });
      }
      return res.status(200).json({ received: true });
    }

    console.log('✅ Client found:', client.business_name);
    const agency = client.agencies;

    if (agency) {
      if (!['active', 'trial', 'trialing'].includes(agency.subscription_status))
        return res.status(200).json({ received: true, blocked: true, reason: 'Agency not active' });
      if (['trial', 'trialing'].includes(agency.subscription_status) && isTrialExpired(agency.trial_ends_at)) {
        await supabase.from('agencies').update({ subscription_status: 'expired' }).eq('id', agency.id);
        return res.status(200).json({ received: true, blocked: true, reason: 'Agency trial expired' });
      }
    }

    if (!['active', 'trial'].includes(client.subscription_status))
      return res.status(200).json({ received: true, blocked: true, reason: 'Not active' });
    if (client.subscription_status === 'trial' && isTrialExpired(client.trial_ends_at)) {
      await supabase.from('clients').update({ subscription_status: 'trial_expired', status: 'suspended' }).eq('id', client.id);
      return res.status(200).json({ received: true, blocked: true, reason: 'Trial expired' });
    }

    const currentCallCount = client.calls_this_month || 0;
    const callLimit = client.monthly_call_limit ?? 50;
    if (callLimit !== -1 && currentCallCount >= callLimit) {
      if (currentCallCount === callLimit) await sendLimitReachedEmail(client, agency, callLimit);
      return res.status(200).json({ received: true, blocked: true, reason: 'Limit reached' });
    }

    const transcript = message.transcript || '';
    const callerPhone = call.customer?.number || 'Unknown';
    const aiData = await generateAISummary(transcript, client.industry || 'professional_services', callerPhone);
    const { customerName, customerPhone, customerEmail, urgency, summary: aiSummary } = aiData;
    let { isSpam, spamReason } = aiData;
    const recordingUrl = message.recordingUrl || message.artifact?.recordingUrl || call.recordingUrl || null;
    const durationSeconds = call.duration || message.duration || message.artifact?.duration || message.durationSeconds || null;
    const endedReason = call.endedReason || message.endedReason || null;
    const { transferStatus, wasTransferred } = detectTransferStatus(endedReason, transcript);

    // ── HIPAA mode: strip recording and transcript before storage ──────
    const hipaaMode = client.hipaa_mode === true;
    const storedRecordingUrl = hipaaMode ? null : recordingUrl;
    const storedTranscript = hipaaMode ? null : transcript;
    if (hipaaMode) {
      console.log('🏥 HIPAA mode — recording and transcript will not be stored');
    }

    if (wasTransferred && isSpam) {
      console.log(`⚠️ Spam flag overridden — call was successfully transferred (${endedReason})`);
      isSpam = false;
      spamReason = null;
    }

    if (isSpam) {
      console.log(`🚫 SPAM: ${spamReason}`);
      const rec = {
        client_id: client.id, customer_name: customerName || 'Spam', customer_phone: customerPhone || callerPhone,
        customer_email: null, ai_summary: aiSummary, transcript: storedTranscript, recording_url: storedRecordingUrl,
        duration_seconds: durationSeconds, urgency_level: 'spam', call_status: 'spam',
        ended_reason: endedReason, transfer_status: null, is_spam: true, spam_reason: spamReason,
        call_language: aiData.callLanguage || 'en', created_at: new Date().toISOString()
      };
      const { data: inserted, error } = await supabase.from('calls').insert([rec]).select();
      if (error) { delete rec.is_spam; delete rec.spam_reason; delete rec.ended_reason; delete rec.transfer_status; delete rec.call_language; await supabase.from('calls').insert([rec]).select(); }

      // ── Record usage even for spam calls (they still cost VAPI minutes) ──
      try {
        const agencyId = agency?.id || client.agency_id;
        if (agencyId && durationSeconds && durationSeconds > 0) {
          await insertUsageRecord({
            agencyId,
            clientId: client.id,
            callId: inserted?.[0]?.id || null,
            durationSeconds,
          });
        }
      } catch (usageErr) {
        console.warn('⚠️ Usage record failed (non-fatal):', usageErr.message);
      }

      if (client.owner_phone) { try { await sendSpamBlockedSMS(client, agency, callerPhone, spamReason); } catch {} }
      return res.status(200).json({ received: true, saved: true, spam: true, spamReason, callId: inserted?.[0]?.id });
    }

    const rec = {
      client_id: client.id, customer_name: customerName, customer_phone: customerPhone,
      customer_email: customerEmail, ai_summary: aiSummary, transcript: storedTranscript, recording_url: storedRecordingUrl,
      duration_seconds: durationSeconds, urgency_level: urgency,
      call_status: wasTransferred ? 'transferred' : 'completed',
      ended_reason: endedReason, transfer_status: transferStatus,
      is_spam: false, spam_reason: null,
      call_language: aiData.callLanguage || 'en', created_at: new Date().toISOString()
    };
    const { data: insertedCall, error: insertError } = await supabase.from('calls').insert([rec]).select();
    if (insertError) {
      if (insertError.message && (insertError.message.includes('ended_reason') || insertError.message.includes('transfer_status') || insertError.message.includes('is_spam') || insertError.message.includes('spam_reason') || insertError.message.includes('call_language'))) {
        delete rec.ended_reason; delete rec.transfer_status; delete rec.is_spam; delete rec.spam_reason; delete rec.call_language; rec.call_status = 'completed';
        var { data: insertedCallFinal, error: retryError } = await supabase.from('calls').insert([rec]).select();
        if (retryError) return res.status(500).json({ error: 'Failed to save call' });
      } else return res.status(500).json({ error: 'Failed to save call' });
    }
    const savedCall = insertedCall || insertedCallFinal;
    console.log('✅ Call saved');

    // ── Record voice usage for metered billing ──────────────────────────
    try {
      const agencyId = agency?.id || client.agency_id;
      if (agencyId && durationSeconds && durationSeconds > 0) {
        await insertUsageRecord({
          agencyId,
          clientId: client.id,
          callId: savedCall?.[0]?.id || null,
          durationSeconds,
        });
      }
    } catch (usageErr) {
      console.warn('⚠️ Usage record failed (non-fatal):', usageErr.message);
    }

    try {
      const { contact, isNew } = await upsertContactFromCall({ clientId: client.id, agencyId: agency?.id, callId: savedCall?.[0]?.id,
        customerPhone, customerName, customerEmail, customerAddress: call.customer?.address || null,
        aiSummary, urgency, serviceRequested: call.customer?.serviceRequested || null });
      if (contact) console.log(`📇 Contact ${isNew ? 'created' : 'updated'}: ${contact.name}`);
    } catch (e) { console.warn('⚠️ Contact upsert failed:', e.message); }

    const newCount = currentCallCount + 1;
    const isFirst = newCount === 1;
    const upd = { calls_this_month: newCount };
    if (isFirst) { upd.first_call_received = true; upd.first_call_received_at = new Date().toISOString(); }
    await supabase.from('clients').update(upd).eq('id', client.id);

    if (callLimit !== -1) {
      const pct = (newCount / callLimit) * 100;
      if (pct >= 80 && pct < 100 && newCount === Math.floor(callLimit * 0.8)) await sendUsageWarningEmail(client, agency, newCount, callLimit);
      if (newCount >= callLimit && newCount === callLimit) await sendLimitReachedEmail(client, agency, callLimit);
    }

    let smsSent = false, emailSent = false;
    if (client.owner_phone) smsSent = await sendCallNotificationSMS(client, agency, aiData);
    await notifyTeamMembers(client.id, aiData, agency);
    if (isFeatureEnabled(client, agency, 'email_summaries') && client.email) {
      const r = await sendCallSummaryEmail(client, agency, aiData, { duration_seconds: durationSeconds, transcript: storedTranscript, created_at: savedCall?.[0]?.created_at || new Date().toISOString() });
      emailSent = r?.success || false;
    }

    return res.status(200).json({ received: true, saved: true, callId: savedCall?.[0]?.id,
      smsSent, emailSent, firstCall: isFirst, agency: agency?.name, duration: durationSeconds,
      endedReason, transferStatus, wasTransferred, spam: false });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}

module.exports = { handleVapiWebhook };