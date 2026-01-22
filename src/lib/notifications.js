// ============================================================================
// NOTIFICATIONS - SMS (Telnyx) & Email (Resend)
// Multi-tenant aware with agency branding
// ============================================================================
const fetch = require('node-fetch');

// ============================================================================
// PHONE FORMATTING
// ============================================================================
function formatPhoneE164(phone) {
  if (!phone) return null;
  
  const digits = phone.replace(/\D/g, '');
  
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  if (phone.startsWith('+') && phone.replace(/\D/g, '').length >= 10) {
    return phone.replace(/[^\d+]/g, '');
  }
  
  return null;
}

function formatPhoneDisplay(phone) {
  if (!phone) return null;
  
  const cleaned = phone.replace(/\D/g, '');
  
  if (cleaned.length === 10) {
    return `(${cleaned.substring(0,3)}) ${cleaned.substring(3,6)}-${cleaned.substring(6)}`;
  }
  
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    const without1 = cleaned.substring(1);
    return `(${without1.substring(0,3)}) ${without1.substring(3,6)}-${without1.substring(6)}`;
  }
  
  return phone;
}

// ============================================================================
// SMS VIA TELNYX
// ============================================================================
async function sendTelnyxSMS(toPhone, message) {
  try {
    if (!process.env.TELNYX_API_KEY) {
      console.log('⚠️ TELNYX_API_KEY not configured');
      return false;
    }
    
    const formattedPhone = formatPhoneE164(toPhone);
    if (!formattedPhone) {
      console.log(`⚠️ Invalid phone: ${toPhone}`);
      return false;
    }
    
    console.log('📱 Sending SMS via Telnyx to:', formattedPhone);
    
    const response = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
      },
      body: JSON.stringify({
        from: process.env.TELNYX_SMS_FROM_NUMBER || '+15054317109',
        to: formattedPhone,
        text: message,
        messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('❌ Telnyx error:', error);
      return false;
    }
    
    console.log('✅ SMS sent successfully');
    return true;
  } catch (error) {
    console.error('❌ SMS error:', error.message);
    return false;
  }
}

// ============================================================================
// CALL NOTIFICATION SMS (Multi-tenant)
// ============================================================================
async function sendCallNotificationSMS(client, agency, callData) {
  const { customerName, customerPhone, urgency, summary } = callData;
  
  // Use agency name if available, otherwise platform name
  const brandName = agency?.name || 'VoiceAI Connect';
  
  let smsMessage = `🔔 New Call - ${client.business_name}\n`;
  smsMessage += `Customer: ${customerName}\n`;
  smsMessage += `Phone: ${customerPhone}\n`;
  
  if (urgency === 'high' || urgency === 'emergency') {
    smsMessage += `⚠️ Urgency: HIGH\n`;
  }
  
  smsMessage += `Summary: ${summary}\n`;
  smsMessage += `Powered by ${brandName}`;
  
  return sendTelnyxSMS(client.owner_phone, smsMessage);
}

// ============================================================================
// WELCOME SMS (simple confirmation - no password link)
// ============================================================================
async function sendWelcomeSMS(phone, businessName, aiPhoneNumber, agency = null) {
  const brandName = agency?.name || 'VoiceAI Connect';
  
  // Simple, compact message - no link needed
  const message = `🎉 Welcome to ${brandName}!\n` +
    `Your AI receptionist for ${businessName} is ready!\n` +
    `📞 Your AI Phone: ${formatPhoneDisplay(aiPhoneNumber)}`;
  
  return sendTelnyxSMS(phone, message);
}

// ============================================================================
// EMAIL VIA RESEND
// ============================================================================
async function sendEmail(emailData) {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.log('⚠️ RESEND_API_KEY not configured');
      return { success: false };
    }
    
    console.log(`📧 Sending email to ${emailData.to}...`);
    
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: emailData.from || 'VoiceAI Connect <notifications@voiceaiconnect.com>',
        to: Array.isArray(emailData.to) ? emailData.to : [emailData.to],
        subject: emailData.subject,
        html: emailData.html
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Email error:', error);
      return { success: false, error };
    }

    const result = await response.json();
    console.log('✅ Email sent:', result.id);
    return { success: true, data: result };
  } catch (error) {
    console.error('❌ Email error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// CLIENT WELCOME EMAIL (Multi-tenant)
// ============================================================================
async function sendClientWelcomeEmail(client, agency, tempPassword, passwordToken) {
  const agencyName = agency?.name || 'VoiceAI Connect';
  const agencyLogo = agency?.logo_url || 'https://voiceaiconnect.com/logo.png';
  const primaryColor = agency?.primary_color || '#2563eb';
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  
  // Build the URL based on agency's domain
  let baseUrl;
  if (agency?.marketing_domain && agency?.domain_verified) {
    baseUrl = `https://${agency.marketing_domain}`;
  } else if (agency?.slug) {
    baseUrl = `https://${agency.slug}.${platformDomain}`;
  } else {
    baseUrl = `https://${platformDomain}`;
  }
  
  const fromEmail = agency?.support_email 
    ? `${agencyName} <${agency.support_email}>`
    : `${agencyName} <onboarding@voiceaiconnect.com>`;
  
  return sendEmail({
    from: fromEmail,
    to: client.email,
    subject: `Welcome to ${agencyName} - Your AI Receptionist is Ready!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f9f9f9;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff;">
          ${agency?.logo_url ? `
            <div style="text-align: center; margin-bottom: 30px;">
              <img src="${agencyLogo}" alt="${agencyName}" style="max-height: 60px;">
            </div>
          ` : ''}
          
          <h1 style="color: ${primaryColor}; font-size: 24px;">Welcome, ${client.owner_name || client.business_name}! 🎉</h1>
          
          <p>Your AI receptionist for <strong>${client.business_name}</strong> is ready to start answering calls.</p>
          
          <div style="background-color: #f0f4ff; border-left: 4px solid ${primaryColor}; padding: 20px; margin: 20px 0;">
            <p style="margin: 0 0 10px 0;"><strong>Your AI Phone Number:</strong></p>
            <p style="font-size: 24px; font-weight: bold; color: ${primaryColor}; margin: 0;">${formatPhoneDisplay(client.vapi_phone_number)}</p>
          </div>
          
          <p><strong>Next Steps:</strong></p>
          <ol>
            <li>Set your password to access your dashboard</li>
            <li>Forward your business line to your new AI number</li>
            <li>Start receiving call summaries instantly!</li>
          </ol>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${baseUrl}/auth/set-password?token=${passwordToken}" 
               style="display: inline-block; background-color: ${primaryColor}; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">
              Set Your Password →
            </a>
          </div>
          
          <p>Your <strong>7-day free trial</strong> has started. No credit card required.</p>
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          
          <p style="color: #666; font-size: 14px;">
            Questions? Reply to this email or contact us at ${agency?.support_email || 'support@voiceaiconnect.com'}
          </p>
          
          <p style="color: #999; font-size: 12px;">
            © ${new Date().getFullYear()} ${agencyName}
          </p>
        </div>
      </body>
      </html>
    `
  });
}

// ============================================================================
// AGENCY WELCOME EMAIL
// ============================================================================
async function sendAgencyWelcomeEmail(agency, passwordToken) {
  const dashboardUrl = process.env.FRONTEND_URL || 'https://myvoiceaiconnect.com';
  
  return sendEmail({
    from: 'VoiceAI Connect <onboarding@voiceaiconnect.com>',
    to: agency.email,
    subject: 'Welcome to VoiceAI Connect - Start Your AI Agency!',
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff;">
          
          <h1 style="color: #2563eb;">Welcome to VoiceAI Connect! 🚀</h1>
          
          <p>Hi ${agency.name},</p>
          
          <p>Your white-label AI agency platform is ready. You can now start reselling AI receptionists under your own brand.</p>
          
          <div style="background-color: #f0f4ff; border-left: 4px solid #2563eb; padding: 20px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Your agency URL:</strong></p>
            <p style="font-size: 18px; color: #2563eb; margin: 5px 0;">
              https://${agency.slug}.myvoiceaiconnect.com
            </p>
          </div>
          
          <p><strong>What to do next:</strong></p>
          <ol>
            <li>Set your password and access your dashboard</li>
            <li>Upload your logo and customize your branding</li>
            <li>Set your pricing (what you'll charge clients)</li>
            <li>Connect your Stripe account to receive payments</li>
            <li>Share your signup link and start acquiring clients!</li>
          </ol>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${dashboardUrl}/auth/set-password?token=${passwordToken}" 
               style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">
              Set Password & Get Started →
            </a>
          </div>
          
          <p>Your <strong>14-day free trial</strong> has started. No credit card required.</p>
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          
          <p style="color: #666; font-size: 14px;">
            Need help? Reply to this email or visit our docs at docs.voiceaiconnect.com
          </p>
        </div>
      </body>
      </html>
    `
  });
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  formatPhoneE164,
  formatPhoneDisplay,
  sendTelnyxSMS,
  sendCallNotificationSMS,
  sendWelcomeSMS,
  sendEmail,
  sendClientWelcomeEmail,
  sendAgencyWelcomeEmail
};