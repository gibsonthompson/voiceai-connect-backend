// ============================================================================
// NOTIFICATIONS - SMS (Telnyx) & Email (Brevo)
// Multi-tenant aware with agency branding
// UPDATED: 2026-05-10 — All SMS functions use sendAndLogSMS for centralized logging
// UPDATED: 2026-05-10 — Welcome email plan-aware (Free vs Pro/Scale)
// ============================================================================
const fetch = require('node-fetch');
const { decrypt } = require('./encryption');

const PLATFORM_OWNER_PHONE = process.env.PLATFORM_OWNER_PHONE || '+16783161454';

// Lazy require to avoid circular dependency (sms-logger imports from this file)
function _logSMS(params) {
  try { return require('./sms-logger').sendAndLogSMS(params); }
  catch { return sendTelnyxSMS(params.phone, params.message); }
}

const REFERRAL_SOURCE_LABELS = {
  'google_search': 'Google Search', 'ai_recommendation': 'AI (ChatGPT/Claude)',
  'linkedin': 'LinkedIn', 'twitter': 'Twitter/X', 'facebook_instagram': 'Facebook/IG',
  'youtube': 'YouTube', 'podcast': 'Podcast', 'friend_colleague': 'Friend/Colleague',
  'blog_article': 'Blog/Article', 'other': 'Other',
};

function getReferralSourceLabel(source) {
  return REFERRAL_SOURCE_LABELS[source] || source || null;
}

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

function formatPhoneE164(phone, countryCode = 'US') {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (phone.startsWith('+') && digits.length >= 7) return '+' + digits;
  const country = (countryCode || 'US').toUpperCase();
  const callingCode = COUNTRY_CALLING_CODES[country] || '1';
  if ((country === 'US' || country === 'CA') && digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if ((country === 'US' || country === 'CA') && digits.length === 10) return `+1${digits}`;
  if (country === 'GB' && digits.startsWith('0')) return `+${callingCode}${digits.substring(1)}`;
  if (country === 'AU' && digits.startsWith('0')) return `+${callingCode}${digits.substring(1)}`;
  if (country === 'NZ' && digits.startsWith('0')) return `+${callingCode}${digits.substring(1)}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${callingCode}${digits}`;
  if (digits.length >= 10) return `+${callingCode}${digits}`;
  return null;
}

function formatPhoneDisplay(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) return `(${cleaned.substring(0, 3)}) ${cleaned.substring(3, 6)}-${cleaned.substring(6)}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    const w = cleaned.substring(1);
    return `(${w.substring(0, 3)}) ${w.substring(3, 6)}-${w.substring(6)}`;
  }
  if (phone.startsWith('+')) return phone;
  return phone;
}

function isInternationalAgency(agency) {
  if (!agency?.country) return false;
  return !['US', 'USA', 'United States', 'us', 'usa'].includes(agency.country);
}

function parseSender(fromString) {
  const match = fromString.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: fromString };
}

// ============================================================================
// SMS VIA TELNYX (low-level transport — kept for sms-logger.js to import)
// ============================================================================
async function sendTelnyxSMS(toPhone, message) {
  try {
    if (!process.env.TELNYX_API_KEY) { console.log('⚠️ TELNYX_API_KEY not configured'); return false; }
    const formattedPhone = toPhone?.startsWith('+') ? toPhone : formatPhoneE164(toPhone, 'US');
    if (!formattedPhone) { console.log(`⚠️ Invalid phone: ${toPhone}`); return false; }
    console.log('📱 Sending SMS via Telnyx to:', formattedPhone);
    const response = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TELNYX_API_KEY}` },
      body: JSON.stringify({
        from: process.env.TELNYX_SMS_FROM_NUMBER || '+15054317109',
        to: formattedPhone, text: message,
        messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID
      })
    });
    if (!response.ok) { const error = await response.json(); console.error('❌ Telnyx error:', error); return false; }
    console.log('✅ SMS sent successfully');
    return true;
  } catch (error) { console.error('❌ SMS error:', error.message); return false; }
}

// ============================================================================
// PLATFORM NOTIFICATIONS
// ============================================================================
async function sendPlatformNotificationSMS(message) {
  return _logSMS({ phone: PLATFORM_OWNER_PHONE, message: `🔔 VoiceAI Connect\n${message}`, recipientType: 'admin', messageType: 'platform_notification' });
}

// Fires when an agency ACTUALLY ACTIVATES (Free plan started via the start-trial
// route, or paid checkout completed) and is a real, committed agency. It used to
// fire in onboarding step 1 the moment a name + phone were saved, which produced
// a premature "signup" text before the agency picked a plan or set a password.
// Function name, export, and messageType ('admin_agency_signup') are kept stable
// so callers and sms_log analytics do not break. Plan line added so the owner can
// see Free vs Pro vs Scale at a glance.
async function sendAgencySignupNotificationSMS(agency) {
  const PLAN_LABELS = { free: 'Free', pro: 'Pro ($99/mo)', scale: 'Scale ($499/mo)' };
  const planLabel = PLAN_LABELS[agency.plan_type] || agency.plan_type || 'Free';
  let message = `🎉 New Agency Activated!\nName: ${agency.name}\nEmail: ${agency.email}`;
  if (agency.phone) message += `\nPhone: ${formatPhoneDisplay(agency.phone) || agency.phone}`;
  message += `\nPlan: ${planLabel}`;
  const referralLabel = getReferralSourceLabel(agency.referral_source);
  if (referralLabel) message += `\nSource: ${referralLabel}`;
  if (agency.country && agency.country !== 'US') message += `\n🌍 Country: ${agency.country}`;
  return _logSMS({ phone: PLATFORM_OWNER_PHONE, message: `🔔 VoiceAI Connect\n${message}`, agencyId: agency.id, recipientType: 'admin', messageType: 'admin_agency_signup', metadata: { agencyName: agency.name, plan: agency.plan_type || null } });
}

async function sendAgencyWelcomeSMS(agency, passwordToken) {
  if (!agency?.phone) { console.log(`⚠️ Agency ${agency?.name || 'Unknown'} has no phone — skipping welcome SMS`); return false; }
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  const platformUrl = `https://${platformDomain}`;
  let agencyUrl = agency.slug ? `https://${agency.slug}.${platformDomain}` : platformUrl;
  let setupLink;
  if (passwordToken) {
    const returnTo = encodeURIComponent(`/onboarding?agency=${agency.id}`);
    setupLink = `${platformUrl}/auth/set-password?token=${passwordToken}&returnTo=${returnTo}`;
  } else { setupLink = `${platformUrl}/agency/login`; }
  const message = `Welcome to VoiceAI Connect! 🚀\n\nYour agency is ready:\n${agencyUrl}\n\nFinish setting up — takes about 2 minutes:\n${setupLink}`;
  return _logSMS({ phone: formatPhoneE164(agency.phone, agency.country || 'US'), message, agencyId: agency.id, recipientType: 'agency_owner', messageType: 'agency_welcome' });
}

async function sendClientSignupNotificationSMS(client, agency) {
  if (!agency?.phone) { console.log(`⚠️ Agency ${agency?.name || 'Unknown'} has no phone`); return false; }
  const message = `🔔 ${agency.name}\n👤 New Client Signup!\nBusiness: ${client.business_name}\nPhone: ${formatPhoneDisplay(client.owner_phone || client.vapi_phone_number)}` +
    (client.country && client.country !== 'US' ? `\n🌍 ${client.country}` : '');
  return _logSMS({ phone: agency.phone, message, agencyId: agency.id, recipientType: 'agency_owner', messageType: 'agency_client_signup', metadata: { clientName: client.business_name } });
}

async function sendAgencyTrialEndingSMS(agency, daysLeft) {
  if (!agency.phone) return false;
  const message = `⏰ VoiceAI Connect Trial Ending\n\nHi ${agency.name}, your trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.\n\nYour card will be charged automatically. Update payment at:\nmyvoiceaiconnect.com/agency/settings/billing`;
  return _logSMS({ phone: agency.phone, message, agencyId: agency.id, recipientType: 'agency_owner', messageType: 'agency_trial_ending_stripe', metadata: { daysLeft } });
}

async function sendAgencyPaymentFailedSMS(agency) {
  if (!agency.phone) return false;
  const message = `🚨 Payment Failed - VoiceAI Connect\n\nHi ${agency.name}, your payment failed.\n\nUpdate your payment method:\nmyvoiceaiconnect.com/agency/settings/billing`;
  return _logSMS({ phone: agency.phone, message, agencyId: agency.id, recipientType: 'agency_owner', messageType: 'agency_payment_failed' });
}

async function sendAgencySubscriptionCanceledSMS(agency) {
  if (!agency.phone) return false;
  const message = `❌ Subscription Canceled - VoiceAI Connect\n\nHi ${agency.name}, your subscription has been canceled.\n\nYour agency and all client AI assistants are now suspended.\n\nReactivate at: myvoiceaiconnect.com/agency/settings/billing`;
  return _logSMS({ phone: agency.phone, message, agencyId: agency.id, recipientType: 'agency_owner', messageType: 'agency_subscription_canceled' });
}

async function sendAgencyPaymentSucceededSMS(agency) {
  if (!agency.phone) return false;
  const message = `✅ Payment Successful - VoiceAI Connect\n\nHi ${agency.name}, your payment was processed successfully!\n\nYour agency is now active. Thank you!`;
  return _logSMS({ phone: agency.phone, message, agencyId: agency.id, recipientType: 'agency_owner', messageType: 'agency_payment_succeeded' });
}

// ============================================================================
// DEMO CALL FOLLOW-UP SMS
// NOTE: handleDemoCall in vapi-webhook.js now inlines this and uses sendAndLogSMS.
//       This function remains as a fallback export.
// ============================================================================
async function sendDemoCallFollowUpSMS(callerPhone, agency, callerBusinessName, businessType, serviceDiscussed) {
  if (!callerPhone || callerPhone === 'Unknown') { console.log('⚠️ No caller phone for demo follow-up SMS'); return false; }
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  let signupUrl;
  if (agency.marketing_domain && agency.domain_verified) signupUrl = `https://${agency.marketing_domain}/signup`;
  else if (agency.slug) signupUrl = `https://${agency.slug}.${platformDomain}/signup`;
  else signupUrl = `https://${platformDomain}/signup`;

  const agencyName = agency.name || 'our';
  const nameNote = callerBusinessName ? ` for ${callerBusinessName}` : '';
  const lines = [`Thanks for trying ${agencyName}'s AI receptionist demo${nameNote}! 🎉`, ''];
  if (serviceDiscussed || callerBusinessName) {
    lines.push(`Here's what we showed you:`);
    if (serviceDiscussed) lines.push(`✅ ${serviceDiscussed}`);
    lines.push(`✅ Instant text summaries after every call`);
    lines.push(`✅ 24/7 coverage — never miss a call`);
    lines.push('');
  }
  lines.push(`Ready to get one${callerBusinessName ? ` for ${callerBusinessName}` : ' for your business'}? Start free, no credit card needed:`);
  lines.push(signupUrl);

  console.log(`📱 Sending demo follow-up SMS to ${callerPhone} for agency: ${agencyName}`);
  return _logSMS({ phone: callerPhone, message: lines.join('\n'), agencyId: agency.id, recipientType: 'prospect', messageType: 'demo_followup', metadata: { businessName: callerBusinessName, businessType } });
}

// ============================================================================
// CLIENT SMS NOTIFICATIONS
// ============================================================================
async function sendCallNotificationSMS(client, agency, callData) {
  const { customerName, customerPhone, urgency, summary } = callData;
  const brandName = agency?.name || 'VoiceAI Connect';
  let smsMessage = `🔔 New Call - ${client.business_name}\nCustomer: ${customerName}\nPhone: ${customerPhone}\n`;
  if (urgency === 'high' || urgency === 'emergency') smsMessage += `⚠️ Urgency: HIGH\n`;
  smsMessage += `Summary: ${summary}\nPowered by ${brandName}`;
  return _logSMS({ phone: client.owner_phone, message: smsMessage, agencyId: agency?.id, recipientType: 'client_owner', messageType: 'client_call_notification', metadata: { clientName: client.business_name, customerName, urgency } });
}

async function sendWelcomeSMS(phone, businessName, aiPhoneNumber, agency) {
  const brandName = agency?.name || 'VoiceAI Connect';
  const message = `🎉 Welcome to ${brandName}!\nYour AI receptionist for ${businessName} is ready!\n📞 Your AI Phone: ${formatPhoneDisplay(aiPhoneNumber)}`;
  return _logSMS({ phone, message, agencyId: agency?.id, recipientType: 'client_owner', messageType: 'client_welcome', metadata: { businessName } });
}

async function sendClientTrialExpiredSMS(client, agency) {
  const brandName = agency?.name || 'AI Receptionist';
  let upgradeUrl = agency?.marketing_domain && agency?.domain_verified ? `${agency.marketing_domain}/client/upgrade` : agency?.slug ? `${agency.slug}.myvoiceaiconnect.com/client/upgrade` : `myvoiceaiconnect.com/client/upgrade`;
  const message = `⚠️ ${brandName} Trial Ended\n\nHi ${client.owner_name || client.business_name}, your 7-day trial has ended.\n\nYour AI receptionist is no longer answering calls.\n\nReactivate now: ${upgradeUrl}`;
  return _logSMS({ phone: client.owner_phone, message, agencyId: agency?.id, recipientType: 'client_owner', messageType: 'client_trial_expired', metadata: { clientName: client.business_name } });
}

async function sendClientPaymentFailedSMS(client, agency) {
  const brandName = agency?.name || 'AI Receptionist';
  const message = `🚨 ${brandName} Payment Failed\n\nHi ${client.owner_name || client.business_name}, your payment failed.\n\nUpdate your payment method to keep your AI receptionist active.`;
  return _logSMS({ phone: client.owner_phone, message, agencyId: agency?.id, recipientType: 'client_owner', messageType: 'client_payment_failed', metadata: { clientName: client.business_name } });
}

async function sendClientSubscriptionActivatedSMS(client, agency, plan) {
  const brandName = agency?.name || 'AI Receptionist';
  const message = `✅ ${brandName} Subscription Active!\n\nHi ${client.owner_name || client.business_name}, your ${plan || 'Starter'} plan is now active!\n\nYour AI receptionist is answering calls 24/7 at:\n📞 ${formatPhoneDisplay(client.vapi_phone_number)}`;
  return _logSMS({ phone: client.owner_phone, message, agencyId: agency?.id, recipientType: 'client_owner', messageType: 'client_subscription_activated', metadata: { clientName: client.business_name, plan } });
}

async function sendSpamBlockedSMS(client, agency, callerPhone, spamReason) {
  if (!client.owner_phone) return false;
  const callerDisplay = formatPhoneDisplay(callerPhone) || callerPhone || 'Unknown';
  const message = `🚫 Spam Blocked — ${client.business_name}\n\nYour AI receptionist detected and blocked a spam call.\n\nCaller: ${callerDisplay}\nType: ${spamReason || 'Robocall / telemarketer'}\n\nNo action needed — this call was not counted against your limit.`;
  return _logSMS({ phone: client.owner_phone, message, agencyId: agency?.id, recipientType: 'client_owner', messageType: 'client_spam_blocked', metadata: { clientName: client.business_name, callerPhone } });
}

// ============================================================================
// EMAIL VIA BREVO
// ============================================================================
async function sendEmail(emailData) {
  try {
    if (!process.env.BREVO_API_KEY) { console.log('⚠️ BREVO_API_KEY not configured'); return { success: false }; }
    const sender = parseSender(emailData.from || 'VoiceAI Connect <notifications@myvoiceaiconnect.com>');
    const recipients = (Array.isArray(emailData.to) ? emailData.to : [emailData.to]).map(email => ({ email }));
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({ sender, to: recipients, subject: emailData.subject, htmlContent: emailData.html })
    });
    if (!response.ok) { const error = await response.text(); console.error('❌ Email error:', error); return { success: false, error }; }
    const result = await response.json();
    console.log('✅ Email sent:', result.messageId);
    return { success: true, data: result };
  } catch (error) { console.error('❌ Email error:', error); return { success: false, error: error.message }; }
}

async function sendCallSummaryEmail(client, agency, callData, callRecord) {
  if (!client.email) return { success: false, reason: 'no_email' };
  const agencyName = agency?.name || 'Your AI Receptionist';
  const agencyLogo = agency?.logo_url || null;
  const primaryColor = agency?.primary_color || '#2563eb';
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  let baseUrl = agency?.marketing_domain && agency?.domain_verified ? `https://${agency.marketing_domain}` : agency?.slug ? `https://${agency.slug}.${platformDomain}` : `https://${platformDomain}`;
  const { customerName, customerPhone, customerEmail, urgency, summary } = callData;
  const duration = callRecord?.duration_seconds;
  const durationDisplay = duration ? `${Math.floor(duration / 60)}m ${duration % 60}s` : 'N/A';
  const urgencyColors = { emergency: { bg: '#fef2f2', text: '#dc2626', border: '#fecaca', label: '🚨 Emergency' }, high: { bg: '#fef2f2', text: '#dc2626', border: '#fecaca', label: '⚠️ High' }, medium: { bg: '#fffbeb', text: '#d97706', border: '#fde68a', label: 'Medium' }, routine: { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0', label: 'Routine' } };
  const urg = urgencyColors[urgency] || urgencyColors.routine;
  const transcript = callRecord?.transcript || '';
  const transcriptPreview = transcript.length > 500 ? transcript.substring(0, 500) + '...' : transcript;
  const fromEmail = agency?.support_email ? `${agencyName} <${agency.support_email}>` : `${agencyName} <notifications@myvoiceaiconnect.com>`;
  const callTime = callRecord?.created_at ? new Date(callRecord.created_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : new Date().toLocaleString('en-US');

  return sendEmail({
    from: fromEmail, to: client.email,
    subject: `New Call${urgency === 'high' || urgency === 'emergency' ? ' ⚠️ URGENT' : ''} — ${customerName || 'Unknown Caller'} | ${client.business_name}`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5;"><div style="max-width: 600px; margin: 0 auto; padding: 20px;"><div style="background-color: #ffffff; border-radius: 12px 12px 0 0; padding: 24px; text-align: center; border-bottom: 3px solid ${primaryColor};">${agencyLogo ? `<img src="${agencyLogo}" alt="${agencyName}" style="max-height: 40px; margin-bottom: 12px;">` : ''}<h2 style="margin: 0; font-size: 18px; color: #111;">New Call Summary</h2><p style="margin: 4px 0 0; font-size: 13px; color: #666;">${callTime}</p></div><div style="background-color: #ffffff; padding: 24px;">${(urgency === 'high' || urgency === 'emergency') ? `<div style="background-color: ${urg.bg}; border: 1px solid ${urg.border}; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px;"><p style="margin: 0; font-size: 14px; font-weight: 600; color: ${urg.text};">${urg.label} Priority — Follow up immediately</p></div>` : ''}<div style="background-color: #f9fafb; border-radius: 8px; padding: 16px; margin-bottom: 20px;"><table style="width: 100%; border-collapse: collapse;"><tr><td style="padding: 6px 0; font-size: 13px; color: #666; width: 100px;">Caller</td><td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #111;">${customerName || 'Unknown'}</td></tr><tr><td style="padding: 6px 0; font-size: 13px; color: #666;">Phone</td><td style="padding: 6px 0; font-size: 14px; color: #111;"><a href="tel:${customerPhone}" style="color: ${primaryColor}; text-decoration: none;">${formatPhoneDisplay(customerPhone) || customerPhone || 'Unknown'}</a></td></tr>${customerEmail ? `<tr><td style="padding: 6px 0; font-size: 13px; color: #666;">Email</td><td style="padding: 6px 0; font-size: 14px; color: #111;"><a href="mailto:${customerEmail}" style="color: ${primaryColor}; text-decoration: none;">${customerEmail}</a></td></tr>` : ''}<tr><td style="padding: 6px 0; font-size: 13px; color: #666;">Duration</td><td style="padding: 6px 0; font-size: 14px; color: #111;">${durationDisplay}</td></tr><tr><td style="padding: 6px 0; font-size: 13px; color: #666;">Urgency</td><td style="padding: 6px 0;"><span style="display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 12px; background-color: ${urg.bg}; color: ${urg.text}; border: 1px solid ${urg.border};">${urg.label}</span></td></tr></table></div><div style="margin-bottom: 20px;"><h3 style="font-size: 14px; color: #111; margin: 0 0 8px;">Summary</h3><p style="font-size: 14px; color: #444; margin: 0; line-height: 1.6;">${summary || 'No summary available.'}</p></div>${transcriptPreview ? `<div style="margin-bottom: 20px;"><h3 style="font-size: 14px; color: #111; margin: 0 0 8px;">Transcript Preview</h3><div style="background-color: #f9fafb; border-radius: 8px; padding: 14px; font-size: 13px; color: #555; line-height: 1.7; white-space: pre-wrap; word-wrap: break-word; max-height: 200px; overflow: hidden;">${transcriptPreview}</div></div>` : ''}<div style="text-align: center; margin: 24px 0 8px;"><a href="${baseUrl}/client/dashboard" style="display: inline-block; background-color: ${primaryColor}; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">View Full Call Details →</a></div></div><div style="background-color: #ffffff; border-radius: 0 0 12px 12px; padding: 16px 24px; border-top: 1px solid #e5e7eb; text-align: center;"><p style="margin: 0; font-size: 12px; color: #999;">${client.business_name} — Powered by ${agencyName}</p><p style="margin: 4px 0 0; font-size: 11px; color: #bbb;">You're receiving this because a call was handled by your AI receptionist.</p></div></div></body></html>`
  });
}

// ============================================================================
// WELCOME EMAILS — Plan-aware messaging
// ============================================================================
async function sendClientWelcomeEmail(client, agency, tempPassword, passwordToken) {
  const agencyName = agency?.name || 'VoiceAI Connect';
  const agencyLogo = agency?.logo_url || 'https://voiceaiconnect.com/logo.png';
  const primaryColor = agency?.primary_color || '#2563eb';
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  let baseUrl = agency?.marketing_domain && agency?.domain_verified ? `https://${agency.marketing_domain}` : agency?.slug ? `https://${agency.slug}.${platformDomain}` : `https://${platformDomain}`;
  const fromEmail = agency?.support_email ? `${agencyName} <${agency.support_email}>` : `${agencyName} <onboarding@myvoiceaiconnect.com>`;

  return sendEmail({
    from: fromEmail, to: client.email,
    subject: `Welcome to ${agencyName} - Your AI Receptionist is Ready!`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f9f9f9;"><div style="max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff;">${agency?.logo_url ? `<div style="text-align: center; margin-bottom: 30px;"><img src="${agencyLogo}" alt="${agencyName}" style="max-height: 60px;"></div>` : ''}<h1 style="color: ${primaryColor}; font-size: 24px;">Welcome, ${client.owner_name || client.business_name}! 🎉</h1><p>Your AI receptionist for <strong>${client.business_name}</strong> is ready to start answering calls.</p><div style="background-color: #f0f4ff; border-left: 4px solid ${primaryColor}; padding: 20px; margin: 20px 0;"><p style="margin: 0 0 10px 0;"><strong>Your AI Phone Number:</strong></p><p style="font-size: 24px; font-weight: bold; color: ${primaryColor}; margin: 0;">${formatPhoneDisplay(client.vapi_phone_number)}</p></div><p><strong>Next Steps:</strong></p><ol><li>Set your password to access your dashboard</li><li>Forward your business line to your new AI number</li><li>Start receiving call summaries instantly!</li></ol><div style="text-align: center; margin: 30px 0;"><a href="${baseUrl}/auth/set-password?token=${passwordToken}" style="display: inline-block; background-color: ${primaryColor}; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">Set Your Password →</a></div><p>Your <strong>7-day free trial</strong> has started. No credit card required.</p><hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;"><p style="color: #666; font-size: 14px;">Questions? Reply to this email or contact us at ${agency?.support_email || 'support@myvoiceaiconnect.com'}</p><p style="color: #999; font-size: 12px;">© ${new Date().getFullYear()} ${agencyName}</p></div></body></html>`
  });
}

async function sendAgencyWelcomeEmail(agency, passwordToken) {
  const dashboardUrl = process.env.FRONTEND_URL || 'https://myvoiceaiconnect.com';
  const isFree = !agency.plan_type || agency.plan_type === 'free' || agency.plan_type === 'starter';

  const trialLine = isFree
    ? `<p>Your <strong>free account</strong> is active. Add a payment method when you're ready to onboard your first client.</p>`
    : `<p>Your <strong>14-day free trial</strong> starts when you finish setup. No credit card required.</p>`;

  return sendEmail({
    from: 'VoiceAI Connect <onboarding@myvoiceaiconnect.com>', to: agency.email,
    subject: 'Welcome to VoiceAI Connect - Start Your AI Agency!',
    html: `<!DOCTYPE html><html><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0;"><div style="max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff;"><h1 style="color: #2563eb;">Welcome to VoiceAI Connect! 🚀</h1><p>Hi ${agency.name},</p><p>Your AI agency platform is ready.</p><div style="background-color: #f0f4ff; border-left: 4px solid #2563eb; padding: 20px; margin: 20px 0;"><p style="margin: 0;"><strong>Your agency URL:</strong></p><p style="font-size: 18px; color: #2563eb; margin: 5px 0;">https://${agency.slug}.myvoiceaiconnect.com</p></div><p><strong>What to do next:</strong></p><ol><li>Set your password and access your dashboard</li><li>Upload your logo and customize your branding</li><li>Set your pricing</li><li>Connect your Stripe account</li><li>Share your signup link!</li></ol><div style="text-align: center; margin: 30px 0;"><a href="${dashboardUrl}/auth/set-password?token=${passwordToken}" style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">Set Password & Get Started →</a></div>${trialLine}<hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;"><p style="color: #666; font-size: 14px;">Need help? Reply to this email.</p></div></body></html>`
  });
}

// ============================================================================
// AGENCY-OWNED TWILIO SMS (BYOT senders for non-US agencies)
// ----------------------------------------------------------------------------
// Non-US agencies with BYOT connected must send agency-scoped SMS (demo
// follow-ups, demo sample summaries, client call notifications, lifecycle
// texts) from their OWN Twilio, not the platform Telnyx US number, which does
// not deliver reliably internationally. sms-logger.js routes those sends here.
//
// From resolution, in priority order:
//   1. agency.twilio_messaging_service_sid  -> MessagingServiceSid (most robust;
//      a Twilio Messaging Service can hold an alphanumeric Sender ID and fall
//      back to a long code automatically). Reading a missing column is a safe
//      undefined, so no migration is required for this to be skipped.
//   2. agency.demo_phone_number, if that number is SMS-capable on the agency's
//      Twilio  -> From = the demo number. This is Gibson's "the demo number is
//      the SMS sender" model, used wherever the carrier allows it (e.g. CA).
//   3. else  -> From = an alphanumeric Sender ID derived from the agency name
//      (one-way; UK geographic/Local numbers are voice-first and not valid SMS
//      senders, so this is the UK path). Alphanumeric is not deliverable to US
//      or Canada destinations, but a non-US agency's recipients are in-country.
//
// A failed agency-Twilio send is surfaced, NOT silently retried on the platform
// Telnyx number (that would reintroduce the international deliverability
// problem). See sms-logger.js.
// ============================================================================

function agencyHasByotCreds(agency) {
  return !!(agency
    && agency.byot_enabled
    && agency.twilio_account_sid
    && agency.twilio_api_key_encrypted
    && agency.twilio_api_secret_encrypted);
}

// Twilio alphanumeric Sender ID rules: max 11 chars, letters/digits/space only,
// at least one letter. Derive from the agency name, then slug, then a neutral
// generic. Never leak the platform brand.
function sanitizeAlphanumericSenderId(agency) {
  const candidates = [agency && agency.name, agency && agency.slug, 'Notify'];
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c).replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 11).trim();
    if (s && /[A-Za-z]/.test(s)) return s;
  }
  return 'Notify';
}

// Cache SMS-capability of a number so we do not query Twilio on every send.
// Numbers do not change capability, so a long TTL is safe.
const _smsCapableCache = new Map(); // key `${accountSid}:${e164}` -> { capable, at }
const _SMS_CAP_TTL_MS = 6 * 60 * 60 * 1000;

async function isNumberSmsCapable(accountSid, authHeader, e164) {
  if (!accountSid || !e164) return false;
  const key = `${accountSid}:${e164}`;
  const cached = _smsCapableCache.get(key);
  if (cached && (Date.now() - cached.at) < _SMS_CAP_TTL_MS) return cached.capable;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`,
      { headers: { 'Authorization': `Basic ${authHeader}` } }
    );
    if (!res.ok) { _smsCapableCache.set(key, { capable: false, at: Date.now() }); return false; }
    const record = ((await res.json()).incoming_phone_numbers || [])[0];
    const capable = !!(record && record.capabilities && record.capabilities.sms);
    _smsCapableCache.set(key, { capable, at: Date.now() });
    return capable;
  } catch (err) {
    console.error('❌ isNumberSmsCapable lookup failed:', err.message);
    _smsCapableCache.set(key, { capable: false, at: Date.now() });
    return false;
  }
}

// Returns the Twilio Messages API sender params: { MessagingServiceSid } or
// { From }. Never throws.
async function resolveAgencySmsSender(agency, accountSid, authHeader) {
  if (agency && agency.twilio_messaging_service_sid) {
    return { MessagingServiceSid: agency.twilio_messaging_service_sid };
  }
  if (agency && agency.demo_phone_number) {
    const capable = await isNumberSmsCapable(accountSid, authHeader, agency.demo_phone_number);
    if (capable) return { From: agency.demo_phone_number };
  }
  return { From: sanitizeAlphanumericSenderId(agency) };
}

// Send one SMS via the agency's own Twilio account.
// Returns { sent, from, sid, error, code }. Never throws.
async function sendViaAgencyTwilio(agency, toPhone, message) {
  try {
    if (!agencyHasByotCreds(agency)) {
      return { sent: false, from: null, error: 'no_twilio_credentials' };
    }
    let apiKey, apiSecret;
    try {
      apiKey = decrypt(agency.twilio_api_key_encrypted);
      apiSecret = decrypt(agency.twilio_api_secret_encrypted);
    } catch (e) {
      console.error('❌ Agency Twilio SMS: failed to decrypt credentials:', e.message);
      return { sent: false, from: null, error: 'decrypt_failed' };
    }
    const accountSid = agency.twilio_account_sid;
    const authHeader = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

    const sender = await resolveAgencySmsSender(agency, accountSid, authHeader);
    const senderLabel = sender.MessagingServiceSid
      ? `MessagingService ${sender.MessagingServiceSid}`
      : `From ${sender.From}`;

    console.log(`📤 Agency Twilio SMS to ${toPhone} via ${senderLabel} (${agency.name})`);

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ To: toPhone, Body: message, ...sender }).toString()
      }
    );

    const fromLabel = sender.From || sender.MessagingServiceSid || null;

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`❌ Agency Twilio SMS failed (HTTP ${res.status}) code=${err.code || 'n/a'}: ${err.message || 'unknown'}`);
      return { sent: false, from: fromLabel, error: err.message || `http_${res.status}`, code: err.code || null };
    }

    const data = await res.json().catch(() => ({}));
    console.log(`✅ Agency Twilio SMS sent (sid ${data.sid || 'n/a'})`);
    return { sent: true, from: fromLabel, sid: data.sid || null, error: null };
  } catch (e) {
    console.error('❌ Agency Twilio SMS exception:', e.message);
    return { sent: false, from: null, error: e.message };
  }
}

module.exports = {
  formatPhoneE164, formatPhoneDisplay, COUNTRY_CALLING_CODES, isInternationalAgency,
  agencyHasByotCreds, sendViaAgencyTwilio, resolveAgencySmsSender, sanitizeAlphanumericSenderId,
  sendTelnyxSMS, sendPlatformNotificationSMS, sendAgencySignupNotificationSMS,
  sendAgencyWelcomeSMS, sendClientSignupNotificationSMS,
  sendAgencyTrialEndingSMS, sendAgencyPaymentFailedSMS,
  sendAgencySubscriptionCanceledSMS, sendAgencyPaymentSucceededSMS,
  sendDemoCallFollowUpSMS, sendCallNotificationSMS, sendWelcomeSMS,
  sendClientTrialExpiredSMS, sendClientPaymentFailedSMS,
  sendClientSubscriptionActivatedSMS, sendSpamBlockedSMS,
  sendEmail, sendCallSummaryEmail, sendClientWelcomeEmail, sendAgencyWelcomeEmail,
  getReferralSourceLabel
};