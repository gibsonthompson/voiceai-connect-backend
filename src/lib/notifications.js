// ============================================================================
// NOTIFICATIONS - SMS (Telnyx) & Email (Brevo)
// Multi-tenant aware with agency branding
// WITH DEMO CALL FOLLOW-UP SMS
// WITH CALL SUMMARY EMAIL (international)
// WITH INTERNATIONAL PHONE FORMATTING
// WITH SPAM BLOCKED SMS (Phase 1 — Spam Detection)
// ============================================================================
const fetch = require('node-fetch');

// Platform owner phone for important notifications
const PLATFORM_OWNER_PHONE = process.env.PLATFORM_OWNER_PHONE || '+16783161454';

// ============================================================================
// REFERRAL SOURCE LABELS (for SMS/display)
// ============================================================================
const REFERRAL_SOURCE_LABELS = {
  'google_search': 'Google Search',
  'ai_recommendation': 'AI (ChatGPT/Claude)',
  'linkedin': 'LinkedIn',
  'twitter': 'Twitter/X',
  'facebook_instagram': 'Facebook/IG',
  'youtube': 'YouTube',
  'podcast': 'Podcast',
  'friend_colleague': 'Friend/Colleague',
  'blog_article': 'Blog/Article',
  'other': 'Other',
};

function getReferralSourceLabel(source) {
  return REFERRAL_SOURCE_LABELS[source] || source || null;
}

// ============================================================================
// COUNTRY CALLING CODES (ISO 3166-1 alpha-2 → ITU calling code)
// ============================================================================
const COUNTRY_CALLING_CODES = {
  US: '1', CA: '1', GB: '44', AU: '61', NZ: '64',
  DE: '49', FR: '33', NL: '31', IT: '39', ES: '34',
  PT: '351', IE: '353', AT: '43', BE: '32', CH: '41',
  SE: '46', NO: '47', DK: '45', FI: '358', PL: '48',
  CZ: '420', HU: '36', RO: '40', BG: '359', HR: '385',
  SK: '421', SI: '386', EE: '372', LV: '371', LT: '370',
  CY: '357', MT: '356', LU: '352', GR: '30',
  JP: '81', SG: '65', HK: '852', MY: '60', TH: '66', IN: '91',
  AE: '971', BR: '55', MX: '52',
};

// ============================================================================
// PHONE FORMATTING (International)
// ============================================================================

function formatPhoneE164(phone, countryCode = 'US') {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '');

  if (phone.startsWith('+') && digits.length >= 7) {
    return '+' + digits;
  }

  const country = (countryCode || 'US').toUpperCase();
  const callingCode = COUNTRY_CALLING_CODES[country] || '1';

  if ((country === 'US' || country === 'CA') && digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  if ((country === 'US' || country === 'CA') && digits.length === 10) {
    return `+1${digits}`;
  }

  if (country === 'GB' && digits.startsWith('0')) {
    return `+${callingCode}${digits.substring(1)}`;
  }

  if (country === 'AU' && digits.startsWith('0')) {
    return `+${callingCode}${digits.substring(1)}`;
  }

  if (country === 'NZ' && digits.startsWith('0')) {
    return `+${callingCode}${digits.substring(1)}`;
  }

  if (digits.length >= 7 && digits.length <= 15) {
    return `+${callingCode}${digits}`;
  }

  if (digits.length >= 10) {
    return `+${callingCode}${digits}`;
  }

  return null;
}

function formatPhoneDisplay(phone) {
  if (!phone) return null;

  const cleaned = phone.replace(/\D/g, '');

  if (cleaned.length === 10) {
    return `(${cleaned.substring(0, 3)}) ${cleaned.substring(3, 6)}-${cleaned.substring(6)}`;
  }

  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    const without1 = cleaned.substring(1);
    return `(${without1.substring(0, 3)}) ${without1.substring(3, 6)}-${without1.substring(6)}`;
  }

  if (phone.startsWith('+')) {
    return phone;
  }

  return phone;
}

// ============================================================================
// HELPER - Determine if agency is international (non-US)
// ============================================================================
function isInternationalAgency(agency) {
  if (!agency?.country) return false;
  const usVariants = ['US', 'USA', 'United States', 'us', 'usa'];
  return !usVariants.includes(agency.country);
}

// ============================================================================
// HELPER - Parse "Name <email>" format into Brevo sender object
// ============================================================================
function parseSender(fromString) {
  const match = fromString.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: fromString };
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

    const formattedPhone = toPhone?.startsWith('+') ? toPhone : formatPhoneE164(toPhone, 'US');
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
// PLATFORM NOTIFICATION SMS (To Gibson for important events)
// ============================================================================
async function sendPlatformNotificationSMS(message) {
  return sendTelnyxSMS(PLATFORM_OWNER_PHONE, `🔔 VoiceAI Connect\n${message}`);
}

// ============================================================================
// AGENCY SMS NOTIFICATIONS
// ============================================================================

async function sendAgencySignupNotificationSMS(agency) {
  let message = `🎉 New Agency Signup!\n` +
    `Name: ${agency.name}\n` +
    `Email: ${agency.email}`;

  const referralLabel = getReferralSourceLabel(agency.referral_source);
  if (referralLabel) {
    message += `\nSource: ${referralLabel}`;
  }

  message += `\nPlan: ${agency.plan_type || 'Starter'}`;

  if (agency.country && agency.country !== 'US') {
    message += `\n🌍 Country: ${agency.country}`;
  }

  return sendPlatformNotificationSMS(message);
}

// ============================================================================
// AGENCY WELCOME SMS
// UPDATED: Accepts passwordToken param. If provided, links to /auth/set-password
// with returnTo=/onboarding so they land in the right place on any device.
// Removed inaccurate "trial has started" copy (trial starts at onboarding step 5).
// ============================================================================
async function sendAgencyWelcomeSMS(agency, passwordToken) {
  if (!agency?.phone) {
    console.log(`⚠️ Agency ${agency?.name || 'Unknown'} has no phone number — skipping welcome SMS`);
    return false;
  }

  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  const platformUrl = `https://${platformDomain}`;

  let agencyUrl;
  if (agency.slug) {
    agencyUrl = `https://${agency.slug}.${platformDomain}`;
  } else {
    agencyUrl = platformUrl;
  }

  // Build the right link — set-password if we have a token, login as fallback
  let setupLink;
  if (passwordToken) {
    const returnTo = encodeURIComponent(`/onboarding?agency=${agency.id}`);
    setupLink = `${platformUrl}/auth/set-password?token=${passwordToken}&returnTo=${returnTo}`;
  } else {
    setupLink = `${platformUrl}/agency/login`;
  }

  const message =
    `Welcome to VoiceAI Connect! 🚀\n\n` +
    `Your agency is ready:\n` +
    `${agencyUrl}\n\n` +
    `Finish setting up — takes about 5 minutes:\n` +
    `${setupLink}`;

  console.log(`📱 Sending welcome SMS to agency owner: ${agency.name} (${agency.phone})`);
  return sendTelnyxSMS(
    formatPhoneE164(agency.phone, agency.country || 'US'),
    message
  );
}

async function sendClientSignupNotificationSMS(client, agency) {
  if (!agency?.phone) {
    console.log(`⚠️ Agency ${agency?.name || 'Unknown'} has no phone number - skipping client signup SMS`);
    return false;
  }

  const message = `🔔 ${agency.name}\n` +
    `👤 New Client Signup!\n` +
    `Business: ${client.business_name}\n` +
    `Phone: ${formatPhoneDisplay(client.owner_phone || client.vapi_phone_number)}` +
    (client.country && client.country !== 'US' ? `\n🌍 ${client.country}` : '');

  console.log(`📱 Notifying agency owner (${agency.name}) of new client: ${client.business_name}`);
  return sendTelnyxSMS(agency.phone, message);
}

async function sendAgencyTrialEndingSMS(agency, daysLeft) {
  if (!agency.phone) {
    console.log(`⚠️ Agency ${agency.name} has no phone number`);
    return false;
  }

  const message = `⏰ VoiceAI Connect Trial Ending\n\n` +
    `Hi ${agency.name}, your trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.\n\n` +
    `Your card will be charged automatically. Update payment at:\n` +
    `myvoiceaiconnect.com/agency/settings/billing`;

  return sendTelnyxSMS(agency.phone, message);
}

async function sendAgencyPaymentFailedSMS(agency) {
  if (!agency.phone) {
    console.log(`⚠️ Agency ${agency.name} has no phone number`);
    return false;
  }

  const message = `🚨 Payment Failed - VoiceAI Connect\n\n` +
    `Hi ${agency.name}, your payment failed.\n\n` +
    `Update your payment method to avoid service interruption:\n` +
    `myvoiceaiconnect.com/agency/settings/billing`;

  return sendTelnyxSMS(agency.phone, message);
}

async function sendAgencySubscriptionCanceledSMS(agency) {
  if (!agency.phone) {
    console.log(`⚠️ Agency ${agency.name} has no phone number`);
    return false;
  }

  const message = `❌ Subscription Canceled - VoiceAI Connect\n\n` +
    `Hi ${agency.name}, your subscription has been canceled.\n\n` +
    `Your agency and all client AI assistants are now suspended.\n\n` +
    `Reactivate at: myvoiceaiconnect.com/agency/settings/billing`;

  return sendTelnyxSMS(agency.phone, message);
}

async function sendAgencyPaymentSucceededSMS(agency) {
  if (!agency.phone) {
    console.log(`⚠️ Agency ${agency.name} has no phone number`);
    return false;
  }

  const message = `✅ Payment Successful - VoiceAI Connect\n\n` +
    `Hi ${agency.name}, your payment was processed successfully!\n\n` +
    `Your agency is now active. Thank you!`;

  return sendTelnyxSMS(agency.phone, message);
}

// ============================================================================
// DEMO CALL FOLLOW-UP SMS
// ============================================================================
async function sendDemoCallFollowUpSMS(callerPhone, agency) {
  if (!callerPhone || callerPhone === 'Unknown') {
    console.log('⚠️ No caller phone for demo follow-up SMS');
    return false;
  }

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

  const message =
    `Thanks for trying ${agencyName}'s AI receptionist demo! 🎉\n\n` +
    `Ready to get one for your business? Start your free trial:\n` +
    `${signupUrl}\n\n` +
    `Setup takes under 10 minutes. No credit card required.`;

  console.log(`📱 Sending demo follow-up SMS to ${callerPhone} for agency: ${agencyName}`);
  return sendTelnyxSMS(callerPhone, message);
}

// ============================================================================
// CLIENT SMS NOTIFICATIONS
// ============================================================================

async function sendCallNotificationSMS(client, agency, callData) {
  const { customerName, customerPhone, urgency, summary } = callData;

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

async function sendWelcomeSMS(phone, businessName, aiPhoneNumber, agency = null) {
  const brandName = agency?.name || 'VoiceAI Connect';

  const message = `🎉 Welcome to ${brandName}!\n` +
    `Your AI receptionist for ${businessName} is ready!\n` +
    `📞 Your AI Phone: ${formatPhoneDisplay(aiPhoneNumber)}`;

  return sendTelnyxSMS(phone, message);
}

async function sendClientTrialExpiredSMS(client, agency) {
  const brandName = agency?.name || 'AI Receptionist';

  let upgradeUrl;
  if (agency?.marketing_domain && agency?.domain_verified) {
    upgradeUrl = `${agency.marketing_domain}/client/upgrade`;
  } else if (agency?.slug) {
    upgradeUrl = `${agency.slug}.myvoiceaiconnect.com/client/upgrade`;
  } else {
    upgradeUrl = `myvoiceaiconnect.com/client/upgrade`;
  }

  const message = `⚠️ ${brandName} Trial Ended\n\n` +
    `Hi ${client.owner_name || client.business_name}, your 7-day trial has ended.\n\n` +
    `Your AI receptionist is no longer answering calls.\n\n` +
    `Reactivate now: ${upgradeUrl}`;

  return sendTelnyxSMS(client.owner_phone, message);
}

async function sendClientPaymentFailedSMS(client, agency) {
  const brandName = agency?.name || 'AI Receptionist';

  const message = `🚨 ${brandName} Payment Failed\n\n` +
    `Hi ${client.owner_name || client.business_name}, your payment failed.\n\n` +
    `Update your payment method to keep your AI receptionist active.`;

  return sendTelnyxSMS(client.owner_phone, message);
}

async function sendClientSubscriptionActivatedSMS(client, agency, plan) {
  const brandName = agency?.name || 'AI Receptionist';

  const message = `✅ ${brandName} Subscription Active!\n\n` +
    `Hi ${client.owner_name || client.business_name}, your ${plan || 'Starter'} plan is now active!\n\n` +
    `Your AI receptionist is answering calls 24/7 at:\n` +
    `📞 ${formatPhoneDisplay(client.vapi_phone_number)}`;

  return sendTelnyxSMS(client.owner_phone, message);
}

// ============================================================================
// SPAM BLOCKED SMS (Phase 1 — Spam Detection)
// ============================================================================
async function sendSpamBlockedSMS(client, agency, callerPhone, spamReason) {
  if (!client.owner_phone) return false;

  const businessName = client.business_name || 'your business';
  const callerDisplay = formatPhoneDisplay(callerPhone) || callerPhone || 'Unknown';
  
  const message = 
    `🚫 Spam Blocked — ${businessName}\n\n` +
    `Your AI receptionist detected and blocked a spam call.\n\n` +
    `Caller: ${callerDisplay}\n` +
    `Type: ${spamReason || 'Robocall / telemarketer'}\n\n` +
    `No action needed — this call was not counted against your limit.`;

  try {
    return await sendTelnyxSMS(client.owner_phone, message);
  } catch (error) {
    console.error('❌ Spam blocked SMS error:', error.message);
    return false;
  }
}

// ============================================================================
// EMAIL VIA BREVO
// ============================================================================
async function sendEmail(emailData) {
  try {
    if (!process.env.BREVO_API_KEY) {
      console.log('⚠️ BREVO_API_KEY not configured');
      return { success: false };
    }

    console.log(`📧 Sending email to ${emailData.to}...`);

    const sender = parseSender(emailData.from || 'VoiceAI Connect <notifications@myvoiceaiconnect.com>');
    const recipients = (Array.isArray(emailData.to) ? emailData.to : [emailData.to]).map(email => ({ email }));

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        sender,
        to: recipients,
        subject: emailData.subject,
        htmlContent: emailData.html
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Email error:', error);
      return { success: false, error };
    }

    const result = await response.json();
    console.log('✅ Email sent:', result.messageId);
    return { success: true, data: result };
  } catch (error) {
    console.error('❌ Email error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// CALL SUMMARY EMAIL (for international clients where SMS doesn't work)
// ============================================================================
async function sendCallSummaryEmail(client, agency, callData, callRecord) {
  if (!client.email) {
    console.log('⚠️ No client email for call summary — skipping');
    return { success: false, reason: 'no_email' };
  }

  const agencyName = agency?.name || 'Your AI Receptionist';
  const agencyLogo = agency?.logo_url || null;
  const primaryColor = agency?.primary_color || '#2563eb';
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';

  let baseUrl;
  if (agency?.marketing_domain && agency?.domain_verified) {
    baseUrl = `https://${agency.marketing_domain}`;
  } else if (agency?.slug) {
    baseUrl = `https://${agency.slug}.${platformDomain}`;
  } else {
    baseUrl = `https://${platformDomain}`;
  }

  const { customerName, customerPhone, customerEmail, urgency, summary } = callData;

  const duration = callRecord?.duration_seconds;
  const durationDisplay = duration
    ? `${Math.floor(duration / 60)}m ${duration % 60}s`
    : 'N/A';

  const urgencyColors = {
    emergency: { bg: '#fef2f2', text: '#dc2626', border: '#fecaca', label: '🚨 Emergency' },
    high:      { bg: '#fef2f2', text: '#dc2626', border: '#fecaca', label: '⚠️ High' },
    medium:    { bg: '#fffbeb', text: '#d97706', border: '#fde68a', label: 'Medium' },
    routine:   { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0', label: 'Routine' },
  };
  const urg = urgencyColors[urgency] || urgencyColors.routine;

  const transcript = callRecord?.transcript || '';
  const transcriptPreview = transcript.length > 500
    ? transcript.substring(0, 500) + '...'
    : transcript;

  const fromEmail = agency?.support_email
    ? `${agencyName} <${agency.support_email}>`
    : `${agencyName} <notifications@myvoiceaiconnect.com>`;

  const callTime = callRecord?.created_at
    ? new Date(callRecord.created_at).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : new Date().toLocaleString('en-US');

  return sendEmail({
    from: fromEmail,
    to: client.email,
    subject: `New Call${urgency === 'high' || urgency === 'emergency' ? ' ⚠️ URGENT' : ''} — ${customerName || 'Unknown Caller'} | ${client.business_name}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          
          <div style="background-color: #ffffff; border-radius: 12px 12px 0 0; padding: 24px; text-align: center; border-bottom: 3px solid ${primaryColor};">
            ${agencyLogo ? `<img src="${agencyLogo}" alt="${agencyName}" style="max-height: 40px; margin-bottom: 12px;">` : ''}
            <h2 style="margin: 0; font-size: 18px; color: #111;">New Call Summary</h2>
            <p style="margin: 4px 0 0; font-size: 13px; color: #666;">${callTime}</p>
          </div>

          <div style="background-color: #ffffff; padding: 24px;">
            
            ${(urgency === 'high' || urgency === 'emergency') ? `
            <div style="background-color: ${urg.bg}; border: 1px solid ${urg.border}; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px;">
              <p style="margin: 0; font-size: 14px; font-weight: 600; color: ${urg.text};">${urg.label} Priority — Follow up immediately</p>
            </div>
            ` : ''}

            <div style="background-color: #f9fafb; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 6px 0; font-size: 13px; color: #666; width: 100px;">Caller</td>
                  <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #111;">${customerName || 'Unknown'}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; font-size: 13px; color: #666;">Phone</td>
                  <td style="padding: 6px 0; font-size: 14px; color: #111;">
                    <a href="tel:${customerPhone}" style="color: ${primaryColor}; text-decoration: none;">${formatPhoneDisplay(customerPhone) || customerPhone || 'Unknown'}</a>
                  </td>
                </tr>
                ${customerEmail ? `
                <tr>
                  <td style="padding: 6px 0; font-size: 13px; color: #666;">Email</td>
                  <td style="padding: 6px 0; font-size: 14px; color: #111;">
                    <a href="mailto:${customerEmail}" style="color: ${primaryColor}; text-decoration: none;">${customerEmail}</a>
                  </td>
                </tr>
                ` : ''}
                <tr>
                  <td style="padding: 6px 0; font-size: 13px; color: #666;">Duration</td>
                  <td style="padding: 6px 0; font-size: 14px; color: #111;">${durationDisplay}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; font-size: 13px; color: #666;">Urgency</td>
                  <td style="padding: 6px 0;">
                    <span style="display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 12px; background-color: ${urg.bg}; color: ${urg.text}; border: 1px solid ${urg.border};">${urg.label}</span>
                  </td>
                </tr>
              </table>
            </div>

            <div style="margin-bottom: 20px;">
              <h3 style="font-size: 14px; color: #111; margin: 0 0 8px;">Summary</h3>
              <p style="font-size: 14px; color: #444; margin: 0; line-height: 1.6;">${summary || 'No summary available.'}</p>
            </div>

            ${transcriptPreview ? `
            <div style="margin-bottom: 20px;">
              <h3 style="font-size: 14px; color: #111; margin: 0 0 8px;">Transcript Preview</h3>
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 14px; font-size: 13px; color: #555; line-height: 1.7; white-space: pre-wrap; word-wrap: break-word; max-height: 200px; overflow: hidden;">${transcriptPreview}</div>
            </div>
            ` : ''}

            <div style="text-align: center; margin: 24px 0 8px;">
              <a href="${baseUrl}/client/dashboard" 
                 style="display: inline-block; background-color: ${primaryColor}; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
                View Full Call Details →
              </a>
            </div>
          </div>

          <div style="background-color: #ffffff; border-radius: 0 0 12px 12px; padding: 16px 24px; border-top: 1px solid #e5e7eb; text-align: center;">
            <p style="margin: 0; font-size: 12px; color: #999;">
              ${client.business_name} — Powered by ${agencyName}
            </p>
            <p style="margin: 4px 0 0; font-size: 11px; color: #bbb;">
              You're receiving this because a call was handled by your AI receptionist.
            </p>
          </div>

        </div>
      </body>
      </html>
    `
  });
}

// ============================================================================
// CLIENT WELCOME EMAIL (Multi-tenant)
// ============================================================================
async function sendClientWelcomeEmail(client, agency, tempPassword, passwordToken) {
  const agencyName = agency?.name || 'VoiceAI Connect';
  const agencyLogo = agency?.logo_url || 'https://voiceaiconnect.com/logo.png';
  const primaryColor = agency?.primary_color || '#2563eb';
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';

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
    : `${agencyName} <onboarding@myvoiceaiconnect.com>`;

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
            Questions? Reply to this email or contact us at ${agency?.support_email || 'support@myvoiceaiconnect.com'}
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
    from: 'VoiceAI Connect <onboarding@myvoiceaiconnect.com>',
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
          
          <p>Your <strong>14-day free trial</strong> starts when you finish setup. No credit card required.</p>
          
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
  // Phone formatting
  formatPhoneE164,
  formatPhoneDisplay,

  // Country codes
  COUNTRY_CALLING_CODES,

  // International detection
  isInternationalAgency,

  // Base SMS
  sendTelnyxSMS,

  // Platform notifications (to Gibson)
  sendPlatformNotificationSMS,
  sendAgencySignupNotificationSMS,

  // Agency owner welcome SMS
  sendAgencyWelcomeSMS,

  // Agency owner notifications
  sendClientSignupNotificationSMS,

  // Agency SMS
  sendAgencyTrialEndingSMS,
  sendAgencyPaymentFailedSMS,
  sendAgencySubscriptionCanceledSMS,
  sendAgencyPaymentSucceededSMS,

  // Demo call follow-up
  sendDemoCallFollowUpSMS,

  // Client SMS
  sendCallNotificationSMS,
  sendWelcomeSMS,
  sendClientTrialExpiredSMS,
  sendClientPaymentFailedSMS,
  sendClientSubscriptionActivatedSMS,
  sendSpamBlockedSMS,

  // Email
  sendEmail,
  sendCallSummaryEmail,
  sendClientWelcomeEmail,
  sendAgencyWelcomeEmail,

  // Helpers
  getReferralSourceLabel
};