// ============================================================================
// VAPI WEBHOOK HANDLER - Multi-Tenant Aware
// Adapted from CallBird's battle-tested webhook
// ============================================================================
const { supabase, getClientByVapiPhoneNumber } = require('../lib/supabase');
const { getPhoneNumberFromVapi } = require('../lib/vapi');
const { sendCallNotificationSMS } = require('../lib/notifications');

// ============================================================================
// AI SUMMARY GENERATION (via Claude)
// ============================================================================
async function generateAISummary(transcript, industry, callerPhone) {
  console.log('🤖 Generating AI summary...');
  
  const industryGuidance = {
    home_services: 'Focus on: the specific problem, property location, urgency level, and service needed.',
    medical: 'Focus on: appointment type, patient status, general reason (HIPAA-compliant), urgency.',
    retail: 'Focus on: products discussed, customer intent, visit plans.',
    professional_services: 'Focus on: matter type (no confidential details), client status, urgency.',
    restaurants: 'Focus on: reservation vs takeout, party size, date/time, menu items.',
    salon_spa: 'Focus on: service type, preferred provider, appointment preferences.'
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
    
    // Fallback extraction
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
// USAGE WARNING EMAILS
// ============================================================================
async function sendUsageWarningEmail(client, agency, currentCalls, limit) {
  try {
    const agencyName = agency?.name || 'Your AI Receptionist';
    
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: `${agencyName} <notifications@voiceaiconnect.com>`,
        to: [client.email],
        subject: `⚠️ ${agencyName}: 80% of Monthly Calls Used`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #F59E0B;">You're approaching your call limit</h2>
            <p>Hi ${client.owner_name || client.business_name},</p>
            <p>You've used <strong>${currentCalls} of ${limit} calls</strong> (${Math.round((currentCalls/limit)*100)}%) this month.</p>
            <p><strong>Upgrade to avoid service interruption.</strong></p>
          </div>
        `
      })
    });
    console.log('✅ Usage warning email sent');
  } catch (error) {
    console.error('❌ Usage warning email failed:', error);
  }
}

async function sendLimitReachedEmail(client, agency, limit) {
  try {
    const agencyName = agency?.name || 'Your AI Receptionist';
    
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: `${agencyName} <notifications@voiceaiconnect.com>`,
        to: [client.email],
        subject: `🚨 ${agencyName}: Monthly Call Limit Reached`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #dc2626;">You've reached your monthly call limit</h2>
            <p>Hi ${client.owner_name || client.business_name},</p>
            <p>You've used all <strong>${limit} calls</strong> included in your plan.</p>
            <p><strong>Additional calls are being limited. Upgrade now to resume full service.</strong></p>
          </div>
        `
      })
    });
    console.log('✅ Limit reached email sent');
  } catch (error) {
    console.error('❌ Limit reached email failed:', error);
  }
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
    
    // Find client by VAPI phone number (includes agency data)
    const client = await getClientByVapiPhoneNumber(phoneNumber);
    
    if (!client) {
      console.log('⚠️ No client found for phone:', phoneNumber);
      return res.status(200).json({ received: true });
    }
    
    console.log('✅ Client found:', client.business_name);
    console.log('🏢 Agency:', client.agencies?.name || 'Direct (no agency)');
    
    const agency = client.agencies; // May be null for direct clients
    
    // ============================================
    // CHECK SUBSCRIPTION STATUS
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
    // CHECK CALL LIMITS
    // ============================================
    const currentCallCount = client.calls_this_month || 0;
    const callLimit = client.monthly_call_limit || 50;
    
    if (currentCallCount >= callLimit) {
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
    
    // Extract recording URL
    const recordingUrl = 
      message.recordingUrl ||
      message.artifact?.recordingUrl ||
      call.recordingUrl ||
      null;
    
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
      urgency_level: urgency,
      call_status: 'completed',
      created_at: new Date().toISOString()
    };
    
    const { data: insertedCall, error: insertError } = await supabase
      .from('calls')
      .insert([callRecord])
      .select();
    
    if (insertError) {
      console.error('❌ Error inserting call:', insertError);
      return res.status(500).json({ error: 'Failed to save call' });
    }
    
    console.log('✅ Call saved successfully');
    
    // ============================================
    // UPDATE CALL COUNT
    // ============================================
    const newCallCount = currentCallCount + 1;
    const isFirstCall = newCallCount === 1;
    
    const updateData = { calls_this_month: newCallCount };
    if (isFirstCall) {
      updateData.first_call_received = true;
      console.log('🎉 FIRST CALL for:', client.business_name);
    }
    
    await supabase
      .from('clients')
      .update(updateData)
      .eq('id', client.id);
    
    // ============================================
    // CHECK USAGE THRESHOLDS
    // ============================================
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
    
    // ============================================
    // SEND SMS NOTIFICATION
    // ============================================
    let smsSent = false;
    
    if (client.owner_phone) {
      console.log('📱 Sending SMS notification...');
      smsSent = await sendCallNotificationSMS(client, agency, aiData);
    }
    
    // ============================================
    // RETURN SUCCESS
    // ============================================
    return res.status(200).json({ 
      received: true,
      saved: true,
      callId: insertedCall[0]?.id,
      smsSent: smsSent,
      firstCall: isFirstCall,
      agency: agency?.name || null
    });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}

module.exports = { handleVapiWebhook };
