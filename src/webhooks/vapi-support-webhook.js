// ============================================================================
// VAPI SUPPORT LINE WEBHOOK
// Handles the shared support phone number for all agencies' clients.
//
// Flow:
//   1. Client calls the support number
//   2. VAPI sends assistant-request → we return dynamic config with agency name
//   3. AI helps the caller; if escalation needed, AI calls transferToHuman
//      with a summary of the issue
//   4. VAPI sends tool-calls to our serverUrl → we return transfer destination
//      with a dynamic whisper that includes WHO is calling and WHAT they need
//   5. Call transfers to Gibson at (678) 316-1454 with full context whisper
//   6. On end-of-call, we log the support interaction
// ============================================================================
const { supabase } = require('../lib/supabase');

const ESCALATION_PHONE = process.env.SUPPORT_ESCALATION_PHONE || '+16783161454';
const SUPPORT_VOICE_ID = process.env.SUPPORT_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Sarah
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';

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
function buildSupportAssistant(context) {
  const agencyName = context?.agencyName || 'VoiceAI Connect';
  const clientName = context?.businessName || null;
  const planType = context?.planType || null;

  const greeting = clientName
    ? `Hi, thanks for calling ${agencyName} support! I can see you're calling from ${clientName}. How can I help you today?`
    : `Hi, thanks for calling ${agencyName} support! How can I help you today?`;

  const contextLine = clientName
    ? `The caller is ${clientName}, a ${planType || 'client'} on the ${agencyName} platform.`
    : `The caller's identity is unknown. Ask for their name and business name to help them.`;

  const systemPrompt = `You are the phone support assistant for ${agencyName}. You help business owners who use ${agencyName}'s AI receptionist service.

## YOUR ROLE
You provide friendly, concise voice support. Keep responses SHORT — this is a phone call, not a text chat. 2-3 sentences max per turn. Be warm and helpful.

## CALLER CONTEXT
${contextLine}

## WHAT YOU CAN HELP WITH

### Call Forwarding Setup
- "To forward your calls to your AI number, open your phone app, go to Settings, then Call Forwarding, and enter your AI phone number."
- For conditional forwarding (only when busy/no answer): "Check with your phone carrier — most support codes like *67 or *61 for conditional forwarding."
- If they can't find the setting: "It varies by carrier. I'd recommend calling your phone provider and asking them to set up call forwarding to your AI number."

### AI Receptionist Issues
- "Not answering calls" → Check if they forwarded correctly, check if their trial is active, check if call limit is reached
- "Wrong information" → They can update their Knowledge Base in the app under AI Agent
- "Sounds robotic" → They can change the voice in AI Agent → Voice settings
- "Not booking appointments" → Calendar integration needs to be connected in Settings

### Dashboard / App Questions
- Login issues → Try "Forgot Password" which sends an SMS code, or contact support
- Can't find calls → Calls tab shows all call history with recordings and transcripts
- Updating greeting → AI Agent tab → Greeting section
- Changing voice → AI Agent tab → Voice section
- Business hours → AI Agent tab → Business Hours
- Knowledge base → AI Agent tab → Knowledge Base

### Billing Questions
- "How much does it cost?" → "Your agency sets the pricing. Check your plan details in Settings, or I can transfer you to the team."
- Upgrade/downgrade → Settings → Billing
- Cancel → Settings → Billing → Cancel subscription
- Payment failed → Settings → update payment method

### Things You CANNOT Do
- You cannot make changes to their account
- You cannot access their call recordings or transcripts
- You cannot process refunds or billing changes
- You cannot reset passwords (direct them to the app's Forgot Password)
- For any of these, offer to transfer to the support team

## ESCALATION RULES
Transfer the call using the transferToHuman tool if:
1. The caller explicitly asks to speak to a person/human/manager
2. The issue involves billing disputes, refunds, or account cancellation
3. You've attempted to help twice and the caller is still confused or frustrated
4. The issue is technical and beyond basic troubleshooting
5. The caller reports a critical outage (their AI isn't answering ANY calls)

When transferring, first call the transferToHuman tool with a clear summary of the issue, THEN say: "Let me connect you with our support team who can help with that directly. One moment please."

IMPORTANT: When you call transferToHuman, the 'issue_summary' should be a concise but complete description of what the caller needs help with. Example: "Caller says their AI receptionist stopped answering calls yesterday, they've verified call forwarding is set up correctly."

## GUARDRAILS
- ONLY discuss topics related to ${agencyName}'s AI receptionist service
- If asked about unrelated topics, say: "I'm here to help with your AI receptionist. What can I help you with?"
- NEVER reveal technical details: API providers, database systems, hosting, infrastructure
- NEVER mention: VAPI, Supabase, Telnyx, Vercel, or any internal tooling
- Keep responses conversational and brief — this is a phone call`;

  return {
    firstMessage: greeting,
    // serverUrl — VAPI sends tool-calls and transfer-destination-request here
    serverUrl: `${BACKEND_URL}/webhook/vapi-support`,
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6-20260217',
      messages: [
        { role: 'system', content: systemPrompt }
      ],
      temperature: 0.4,
    },
    voice: {
      provider: '11labs',
      voiceId: SUPPORT_VOICE_ID,
    },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    endCallMessage: "Thanks for calling support! If you need more help, don't hesitate to call back. Have a great day!",
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
    },
    // Transfer tool — AI passes issue_summary, backend builds dynamic whisper
    tools: [
      {
        type: 'transferCall',
        function: {
          name: 'transferToHuman',
          description: 'Transfer the call to a human support agent. Use when the caller asks for a human, has a billing issue, or you cannot resolve their problem after two attempts. You MUST provide a clear summary of the issue.',
          parameters: {
            type: 'object',
            properties: {
              issue_summary: {
                type: 'string',
                description: 'A concise summary of what the caller needs help with and what you already tried. Example: "Caller reports AI not answering calls since yesterday, verified forwarding is correct, may be a provisioning issue."',
              },
            },
            required: ['issue_summary'],
          },
        },
        // Destinations defined here as fallback; dynamic destination returned via
        // transfer-destination-request webhook overrides this
        destinations: [
          {
            type: 'number',
            number: ESCALATION_PHONE,
            message: 'Support call being transferred.',
          }
        ],
      },
    ],
    // Store caller context in metadata so we can access it in transfer-destination-request
    metadata: {
      callerContext: context || null,
    },
  };
}

// ============================================================================
// MAIN WEBHOOK HANDLER
// ============================================================================
async function handleSupportWebhook(req, res) {
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

      const assistant = buildSupportAssistant(context);
      return res.status(200).json({ assistant });
    }

    // ============================
    // TRANSFER DESTINATION REQUEST — dynamic whisper with conversation context
    // This fires when the AI triggers transferToHuman. VAPI asks us where to
    // send the call. We return the destination with a whisper that includes
    // WHO is calling and WHAT they discussed.
    // ============================
    if (messageType === 'transfer-destination-request') {
      console.log('🔀 Transfer destination request received');

      // Extract caller context from the call metadata (set during assistant-request)
      const metadata = message?.call?.assistant?.metadata || message?.artifact?.metadata || {};
      const callerContext = metadata.callerContext || null;

      // Extract the issue summary from the tool call arguments
      const toolCallArgs = message?.toolCalls?.[0]?.function?.arguments || 
                           message?.functionCall?.parameters || {};
      
      let issueSummary = '';
      try {
        const parsed = typeof toolCallArgs === 'string' ? JSON.parse(toolCallArgs) : toolCallArgs;
        issueSummary = parsed.issue_summary || '';
      } catch {
        issueSummary = typeof toolCallArgs === 'string' ? toolCallArgs : '';
      }

      // Build the dynamic whisper with full context
      const whisperParts = [];
      whisperParts.push('Incoming support call');

      if (callerContext?.businessName) {
        whisperParts.push(`from ${callerContext.businessName}`);
      }
      if (callerContext?.agencyName && callerContext.agencyName !== 'VoiceAI Connect') {
        whisperParts.push(`${callerContext.agencyName} client`);
      }
      if (callerContext?.planType) {
        whisperParts.push(`on the ${callerContext.planType} plan`);
      }
      if (issueSummary) {
        whisperParts.push(`Issue: ${issueSummary}`);
      }

      const whisperMessage = whisperParts.join('. ') + '.';
      console.log(`📋 Whisper: ${whisperMessage}`);

      return res.status(200).json({
        destination: {
          type: 'number',
          number: ESCALATION_PHONE,
          message: whisperMessage,
        },
      });
    }

    // ============================
    // TOOL CALLS — handle server-side tool execution
    // (VAPI sends this when the AI calls a function with serverUrl set)
    // ============================
    if (messageType === 'tool-calls') {
      const toolCalls = message?.toolCalls || message?.toolCallList || [];
      
      for (const toolCall of toolCalls) {
        const functionName = toolCall?.function?.name;
        
        if (functionName === 'transferToHuman') {
          // The transfer-destination-request handles the actual routing
          // Just acknowledge here
          console.log('🔀 Transfer tool called — waiting for transfer-destination-request');
          return res.status(200).json({
            results: [{
              toolCallId: toolCall.id,
              result: 'Transferring to support team now.',
            }],
          });
        }
      }

      // Unknown tool — acknowledge
      return res.status(200).json({ received: true });
    }

    // ============================
    // END OF CALL REPORT — log the support interaction
    // ============================
    if (messageType === 'end-of-call-report') {
      const call = message.call;
      const callerPhone = call?.customer?.number || 'Unknown';
      const transcript = message.transcript || '';
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