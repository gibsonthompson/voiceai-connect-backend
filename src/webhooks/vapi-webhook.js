// ============================================================================
// VAPI WEBHOOK HANDLER - Multi-Tenant Aware
// UPDATED: Transfer tracking (ended_reason, transfer_status)
// UPDATED: Demo call detection + agency follow-up SMS
// UPDATED: Email summaries gated by plan_features (Phase 5)
// UPDATED: Unlimited calls support (-1 = no limit)
// UPDATED: Contact upsert (Lead Capture) after call save
// ============================================================================
const { supabase, getClientByVapiPhoneNumber } = require('../lib/supabase');
const { getPhoneNumberFromVapi } = require('../lib/vapi');
const { sendCallNotificationSMS, sendDemoCallFollowUpSMS, sendCallSummaryEmail } = require('../lib/notifications');
const { upsertContactFromCall } = require('../lib/contact-upsert');

// ============================================================================
// PLAN FEATURE CHECK HELPER
// ============================================================================
const DEFAULT_PLAN_FEATURES = {
  starter: {
    sms_notifications: true,
    email_summaries: false,
    custom_greeting: false,
    custom_voice: false,
    knowledge_base: false,
    business_hours: false,
    advanced_analytics: false,
    priority_support: false,
  },
  pro: {
    sms_notifications: true,
    email_summaries: true,
    custom_greeting: true,
    custom_voice: false,
    knowledge_base: true,
    business_hours: true,
    advanced_analytics: true,
    priority_support: false,
  },
  growth: {
    sms_notifications: true,
    email_summaries: true,
    custom_greeting: true,
    custom_voice: true,
    knowledge_base: true,
    business_hours: true,
    advanced_analytics: true,
    priority_support: true,
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
// Maps VAPI endedReason to a transfer status for our records
// ============================================================================
function detectTransferStatus(endedReason, transcript) {
  if (!endedReason) return { transferStatus: null, wasTransferred: false };

  // Successful transfer — VAPI forwarded the call
  if (endedReason === 'assistant-forwarded-call') {
    return { transferStatus: 'transferred', wasTransferred: true };
  }

  // Transfer was attempted but failed — check for specific error patterns
  if (endedReason === 'pipeline-error') {
    // Check if transcript shows a transfer attempt (AI said transfer-like words then errored)
    const transferAttempted = transcript && (
      transcript.toLowerCase().includes('let me connect you') ||
      transcript.toLowerCase().includes('let me transfer') ||
      transcript.toLowerCase().includes('let me get the team') ||
      transcript.toLowerCase().includes('let me grab someone') ||
      transcript.toLowerCase().includes('i\'ll connect you')
    );
    if (transferAttempted) {
      return { transferStatus: 'transfer_failed', wasTransferred: false };
    }
    return { transferStatus: null, wasTransferred: false };
  }

  // Call ended for other reasons — no transfer involved
  return { transferStatus: null, wasTransferred: false };
}

// ============================================================================
// AI SUMMARY GENERATION (via Claude)
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
  "summary": "2-3 sentence summary focusing on: ${industryGuidance[industry] || 'what the customer needs'}"
}`;

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

    if (!response.ok) {
      throw new Error(`Claude API failed: ${response.status}`);
    }

    const data = await response.json();
    let responseText = data.content[0].text.trim();
    responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    
    return JSON.parse(responseText);
  } catch (error) {
    console.error('❌ AI summary failed, using fallback:', error.message);
    
    return {
      customerName: 'Unknown',
      customerPhone: callerPhone,
      customerEmail: null,
      urgency: 'routine',
      summary: `Customer called regarding ${industry.replace('_', ' ')} services. Team should follow up.`
    };
  }
}

// ============================================================================
// USAGE WARNING EMAILS (STUBBED)
// ============================================================================
async function sendUsageWarningEmail(client, agency, currentCalls, limit) {
  const agencyName = agency?.name || 'Your AI Receptionist';
  console.log(`📧 [EMAIL STUB] Would send 80% usage warning to ${client.email}`);
  console.log(`   Agency: ${agencyName}, Usage: ${currentCalls}/${limit}`);
}

async function sendLimitReachedEmail(client, agency, limit) {
  const agencyName = agency?.name || 'Your AI Receptionist';
  console.log(`📧 [EMAIL STUB] Would send limit reached email to ${client.email}`);
  console.log(`   Agency: ${agencyName}, Limit: ${limit}`);
}

// ============================================================================
// HELPER - Check if trial has expired
// ============================================================================
function isTrialExpired(trialEndsAt) {
  if (!trialEndsAt) return false;
  return new Date(trialEndsAt) < new Date();
}

// ============================================================================
// HELPER - Find agency by demo phone number
// ============================================================================
async function getAgencyByDemoPhone(phoneNumber) {
  try {
    const { data, error } = await supabase
      .from('agencies')
      .select('*')
      .eq('demo_phone_number', phoneNumber)
      .single();
    
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

// ============================================================================
// HANDLE DEMO CALL
// ============================================================================
async function handleDemoCall(agency, message) {
  const call = message.call;
  const callerPhone = call.customer?.number || null;
  const transcript = message.transcript || '';
  const durationSeconds = call.duration || message.duration || null;

  console.log(`🎤 Demo call completed for agency: ${agency.name}`);
  console.log(`   Caller: ${callerPhone || 'Unknown'}`);
  console.log(`   Duration: ${durationSeconds ? `${durationSeconds}s` : 'Unknown'}`);

  if (callerPhone && callerPhone !== 'Unknown') {
    try {
      await sendDemoCallFollowUpSMS(callerPhone, agency);
      console.log('✅ Demo follow-up SMS sent');
    } catch (smsErr) {
      console.warn('⚠️ Demo follow-up SMS failed:', smsErr.message);
    }
  }

  if (agency.phone) {
    const { formatPhoneDisplay } = require('../lib/notifications');
    const callerDisplay = callerPhone ? formatPhoneDisplay(callerPhone) : 'Unknown number';
    const durationDisplay = durationSeconds ? `${Math.round(durationSeconds / 60)}min ${durationSeconds % 60}s` : 'Unknown';
    
    const ownerMsg = 
      `🎤 Demo Call - ${agency.name}\n` +
      `Caller: ${callerDisplay}\n` +
      `Duration: ${durationDisplay}\n` +
      `They received your signup link via SMS.`;
    
    try {
      const { sendTelnyxSMS } = require('../lib/notifications');
      await sendTelnyxSMS(agency.phone, ownerMsg);
      console.log('✅ Agency owner notified of demo call');
    } catch (ownerSmsErr) {
      console.warn('⚠️ Agency owner demo notification failed:', ownerSmsErr.message);
    }
  }

  return {
    type: 'demo',
    agency: agency.name,
    callerPhone,
    durationSeconds,
    followUpSent: !!callerPhone
  };
}

// ============================================================================
// MAIN WEBHOOK HANDLER
// ============================================================================
async function handleVapiWebhook(req, res) {
  try {
    console.log('📞 VAPI webhook received');
    
    const message = req.body.message;
    
    // Only process end-of-call reports
    if (message?.type !== 'end-of-call-report') {
      return res.status(200).json({ received: true });
    }
    
    const call = message.call;
    const phoneNumberId = call.phoneNumberId;
    
    // Get phone number from VAPI
    const phoneNumber = await getPhoneNumberFromVapi(phoneNumberId);
    if (!phoneNumber) {
      console.log('⚠️ Could not get phone number from VAPI');
      return res.status(200).json({ received: true });
    }
    
    console.log('📱 Phone number:', phoneNumber);
    
    // Find client by VAPI phone number (includes agency data with plan_features)
    const client = await getClientByVapiPhoneNumber(phoneNumber);
    
    // ============================================
    // IF NO CLIENT FOUND → CHECK IF IT'S A DEMO CALL
    // ============================================
    if (!client) {
      console.log('⚠️ No client found for phone:', phoneNumber);
      console.log('🔍 Checking if this is a demo call...');
      
      const demoAgency = await getAgencyByDemoPhone(phoneNumber);
      
      if (demoAgency) {
        console.log(`✅ Demo call detected for agency: ${demoAgency.name}`);
        const result = await handleDemoCall(demoAgency, message);
        return res.status(200).json({ 
          received: true,
          demo: true,
          ...result
        });
      }
      
      console.log('⚠️ Not a demo call either — ignoring');
      return res.status(200).json({ received: true });
    }
    
    console.log('✅ Client found:', client.business_name);
    console.log('🏢 Agency:', client.agencies?.name || 'Direct (no agency)');
    
    const agency = client.agencies;
    
    // ============================================
    // CHECK AGENCY STATUS
    // ============================================
    if (agency) {
      const agencyValidStatuses = ['active', 'trial', 'trialing'];
      if (!agencyValidStatuses.includes(agency.subscription_status)) {
        console.log(`🚫 CALL BLOCKED: Agency ${agency.name} subscription not active`);
        return res.status(200).json({ 
          received: true,
          blocked: true,
          reason: 'Agency subscription not active'
        });
      }
      
      if ((agency.subscription_status === 'trial' || agency.subscription_status === 'trialing') 
          && isTrialExpired(agency.trial_ends_at)) {
        console.log(`🚫 CALL BLOCKED: Agency ${agency.name} trial expired`);
        
        await supabase
          .from('agencies')
          .update({ subscription_status: 'expired' })
          .eq('id', agency.id);
        
        return res.status(200).json({ 
          received: true,
          blocked: true,
          reason: 'Agency trial expired'
        });
      }
    }
    
    // ============================================
    // CHECK CLIENT SUBSCRIPTION STATUS
    // ============================================
    const validStatuses = ['active', 'trial'];
    if (!validStatuses.includes(client.subscription_status)) {
      console.log(`🚫 CALL BLOCKED: ${client.business_name} subscription not active`);
      return res.status(200).json({ 
        received: true,
        blocked: true,
        reason: 'Subscription not active'
      });
    }
    
    // ============================================
    // CHECK CLIENT TRIAL EXPIRATION
    // ============================================
    if (client.subscription_status === 'trial' && isTrialExpired(client.trial_ends_at)) {
      console.log(`🚫 CALL BLOCKED: ${client.business_name} trial expired`);
      
      await supabase
        .from('clients')
        .update({ subscription_status: 'expired' })
        .eq('id', client.id);
      
      return res.status(200).json({ 
        received: true,
        blocked: true,
        reason: 'Trial expired'
      });
    }
    
    // ============================================
    // CHECK CALL LIMITS (-1 = unlimited)
    // ============================================
    const currentCallCount = client.calls_this_month || 0;
    const callLimit = client.monthly_call_limit ?? 50;
    
    if (callLimit !== -1 && currentCallCount >= callLimit) {
      console.log(`🚫 CALL BLOCKED: ${client.business_name} reached limit`);
      
      if (currentCallCount === callLimit) {
        await sendLimitReachedEmail(client, agency, callLimit);
      }
      
      return res.status(200).json({ 
        received: true,
        blocked: true,
        reason: 'Monthly call limit reached'
      });
    }
    
    if (callLimit === -1) {
      console.log(`♾️ Unlimited plan — no call cap`);
    } else {
      console.log(`📊 Usage: ${currentCallCount}/${callLimit} calls`);
    }
    
    // ============================================
    // EXTRACT DATA & GENERATE SUMMARY
    // ============================================
    const transcript = message.transcript || '';
    const callerPhone = call.customer?.number || 'Unknown';
    
    const aiData = await generateAISummary(
      transcript,
      client.industry || 'professional_services',
      callerPhone
    );
    
    const { customerName, customerPhone, customerEmail, urgency, summary: aiSummary } = aiData;
    
    const recordingUrl = 
      message.recordingUrl ||
      message.artifact?.recordingUrl ||
      call.recordingUrl ||
      null;
    
    const durationSeconds = 
      call.duration ||
      message.duration ||
      message.call?.duration ||
      message.artifact?.duration ||
      null;
    
    if (durationSeconds) {
      console.log(`⏱️ Call duration: ${durationSeconds} seconds`);
    }
    
    // ============================================
    // TRANSFER TRACKING
    // Detect if the call was transferred and track the outcome
    // ============================================
    const endedReason = call.endedReason || message.endedReason || null;
    const { transferStatus, wasTransferred } = detectTransferStatus(endedReason, transcript);

    if (wasTransferred) {
      console.log(`📲 Call was TRANSFERRED (endedReason: ${endedReason})`);
    } else if (transferStatus === 'transfer_failed') {
      console.log(`❌ Transfer FAILED (endedReason: ${endedReason})`);
    } else {
      console.log(`📞 Call ended normally (endedReason: ${endedReason || 'unknown'})`);
    }
    
    // ============================================
    // SAVE CALL TO DATABASE
    // ============================================
    const callRecord = {
      client_id: client.id,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      ai_summary: aiSummary,
      transcript: transcript,
      recording_url: recordingUrl,
      duration_seconds: durationSeconds,
      urgency_level: urgency,
      call_status: wasTransferred ? 'transferred' : 'completed',
      ended_reason: endedReason,
      transfer_status: transferStatus,
      created_at: new Date().toISOString()
    };
    
    const { data: insertedCall, error: insertError } = await supabase
      .from('calls')
      .insert([callRecord])
      .select();
    
    if (insertError) {
      console.error('❌ Error inserting call:', insertError);
      // If the error is about missing columns, try without new fields
      if (insertError.message && (insertError.message.includes('ended_reason') || insertError.message.includes('transfer_status'))) {
        console.log('⚠️ Transfer tracking columns not yet added — saving without them');
        delete callRecord.ended_reason;
        delete callRecord.transfer_status;
        callRecord.call_status = 'completed'; // revert to safe value
        const { data: retryCall, error: retryError } = await supabase
          .from('calls')
          .insert([callRecord])
          .select();
        if (retryError) {
          console.error('❌ Retry insert also failed:', retryError);
          return res.status(500).json({ error: 'Failed to save call' });
        }
        // Use retry result
        var insertedCallFinal = retryCall;
      } else {
        return res.status(500).json({ error: 'Failed to save call' });
      }
    }
    
    const savedCall = insertedCall || insertedCallFinal;
    console.log('✅ Call saved successfully');
    
    // ============================================
    // UPSERT CONTACT (Lead Capture)
    // ============================================
    try {
      const { contact, isNew } = await upsertContactFromCall({
        clientId: client.id,
        agencyId: agency?.id,
        callId: savedCall?.[0]?.id,
        customerPhone: customerPhone,
        customerName: customerName,
        customerEmail: customerEmail,
        customerAddress: call.customer?.address || null,
        aiSummary: aiSummary,
        urgency: urgency,
        serviceRequested: call.customer?.serviceRequested || null,
      });
      
      if (contact) {
        console.log(`📇 Contact ${isNew ? 'created' : 'updated'}: ${contact.name} (${contact.phone})`);
      }
    } catch (contactErr) {
      console.warn('⚠️ Contact upsert failed (non-fatal):', contactErr.message);
    }
    
    // ============================================
    // UPDATE CALL COUNT
    // ============================================
    const newCallCount = currentCallCount + 1;
    const isFirstCall = newCallCount === 1;
    
    const updateData = { calls_this_month: newCallCount };
    if (isFirstCall) {
      updateData.first_call_received = true;
      updateData.first_call_received_at = new Date().toISOString();
      console.log('🎉 FIRST CALL for:', client.business_name);
    }
    
    await supabase
      .from('clients')
      .update(updateData)
      .eq('id', client.id);
    
    // ============================================
    // CHECK USAGE THRESHOLDS (skip for unlimited)
    // ============================================
    if (callLimit !== -1) {
      const usagePercent = (newCallCount / callLimit) * 100;
      
      if (usagePercent >= 80 && usagePercent < 100) {
        if (newCallCount === Math.floor(callLimit * 0.8)) {
          await sendUsageWarningEmail(client, agency, newCallCount, callLimit);
        }
      }
      
      if (newCallCount >= callLimit) {
        if (newCallCount === callLimit) {
          await sendLimitReachedEmail(client, agency, callLimit);
        }
      }
    }
    
    // ============================================
    // SEND NOTIFICATIONS
    // ============================================
    let smsSent = false;
    let emailSent = false;
    
    // 1. SMS — all plans get this
    if (client.owner_phone) {
      console.log('📱 Sending SMS notification...');
      smsSent = await sendCallNotificationSMS(client, agency, aiData);
      if (smsSent) {
        console.log('✅ SMS notification sent');
      } else {
        console.warn('⚠️ SMS notification failed');
      }
    }
    
    // 2. Email — only if enabled for this client's plan
    if (isFeatureEnabled(client, agency, 'email_summaries')) {
      if (client.email) {
        console.log('📧 Email summaries enabled for plan — sending email...');
        const emailResult = await sendCallSummaryEmail(client, agency, aiData, {
          duration_seconds: durationSeconds,
          transcript: transcript,
          created_at: savedCall?.[0]?.created_at || new Date().toISOString(),
        });
        emailSent = emailResult?.success || false;
        
        if (emailSent) {
          console.log('✅ Call summary email sent');
        } else {
          console.warn('⚠️ Call summary email failed:', emailResult?.error);
        }
      } else {
        console.log('📧 Email summaries enabled but client has no email on file');
      }
    } else {
      console.log('📧 Email summaries not enabled for this plan — skipping');
    }
    
    // ============================================
    // RETURN SUCCESS
    // ============================================
    return res.status(200).json({ 
      received: true,
      saved: true,
      callId: savedCall?.[0]?.id,
      smsSent: smsSent,
      emailSent: emailSent,
      firstCall: isFirstCall,
      agency: agency?.name || null,
      duration: durationSeconds,
      endedReason: endedReason,
      transferStatus: transferStatus,
      wasTransferred: wasTransferred
    });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}

module.exports = { handleVapiWebhook };