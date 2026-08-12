// ============================================================================
// NOTIFICATIONS - SMS (Telnyx) & Email (Brevo)
// Multi-tenant aware with agency branding
// UPDATED: 2026-05-10, All SMS functions use sendAndLogSMS for centralized logging
// UPDATED: 2026-05-10, Welcome email plan-aware (Free vs Pro/Scale)
// UPDATED: 2026-08-12, Removed client-facing emails for white-label integrity:
//          sendClientWelcomeEmail and sendCallSummaryEmail are gone (every
//          client touchpoint is now agency-branded SMS). sendEmail,
//          parseSender, and the agency-facing sendAgencyWelcomeEmail remain.
// ============================================================================
const fetch = require('node-fetch');
const { decrypt } = require('./encryption');
const { renderBrandedEmail } = require('./email-layout');

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
// SMS VIA TELNYX (low-level transport, kept for sms-logger.js to import)
// ============================================================================
async function sendTelnyxSMS(toPhone, message) {
  try {
    if (!process.env.TELNYX_API_KEY) { console.log('⚠️ TELNYX_API_KEY not configured'); return false; }
    // Normalize the destination to clean E.164 by DIGIT COUNT, ignoring whatever
    // formatting the number was stored with: parentheses, spaces, dashes, and
    // invisible unicode direction marks (U+202A/U+202C) that come from numbers
    // pasted out of a contacts app. Critically, a stray leading "+" on a
    // national-format number is NOT trusted as a country code. A value like
    // "+(908) 940-1491" is 10 digits and must become +19089401491, not
    // +9089401491, so we decide by digit count here rather than passing a
    // "+"-prefixed value straight through (the old bug that let malformed
    // numbers reach Telnyx and silently fail to deliver).
    const digits = (toPhone || '').replace(/\D/g, '');
    let formattedPhone = null;
    if (digits.length === 10) formattedPhone = `+1${digits}`;
    else if (digits.length === 11 && digits.startsWith('1')) formattedPhone = `+${digits}`;
    else if (digits.length >= 11 && digits.length <= 15) formattedPhone = `+${digits}`;
    if (!formattedPhone) { console.log(`⚠️ Invalid phone (need 10-15 digits): ${toPhone}`); return false; }
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
  if (!agency?.phone) { console.log(`⚠️ Agency ${agency?.name || 'Unknown'} has no phone, skipping welcome SMS`); return false; }
  const platformDomain = process.env.PLATFORM_DOMAIN || 'myvoiceaiconnect.com';
  const platformUrl = `https://${platformDomain}`;
  let agencyUrl = agency.slug ? `https://${agency.slug}.${platformDomain}` : platformUrl;
  let setupLink;
  if (passwordToken) {
    const returnTo = encodeURIComponent(`/onboarding?agency=${agency.id}`);
    setupLink = `${platformUrl}/auth/set-password?token=${passwordToken}&returnTo=${returnTo}`;
  } else { setupLink = `${platformUrl}/agency/login`; }
  const message = `Welcome to VoiceAI Connect! 🚀\n\nYour agency is ready:\n${agencyUrl}\n\nFinish setting up, takes about 2 minutes:\n${setupLink}`;
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
    lines.push(`✅ 24/7 coverage, never miss a call`);
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
  const message = `🚫 Spam Blocked, ${client.business_name}\n\nYour AI receptionist detected and blocked a spam call.\n\nCaller: ${callerDisplay}\nType: ${spamReason || 'Robocall / telemarketer'}\n\nNo action needed, this call was not counted against your limit.`;
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

// ============================================================================
// WELCOME EMAILS, Plan-aware messaging
// ============================================================================
// Getting-started email. NO password link: agencies set their password
// in-browser (the set-password token is delivered in the signup RESPONSE BODY,
// not by email). The second arg is accepted but unused so agency-signup.js does
// not need to change. No plan/trial copy: this fires at signup before a plan is
// chosen, which is exactly why the old "14-day trial / no card" line was wrong.
async function sendAgencyWelcomeEmail(agency, _passwordTokenUnused) {
  const loginUrl = `${process.env.FRONTEND_URL || 'https://myvoiceaiconnect.com'}/agency/login`;
  const agencyUrl = `https://${agency.slug}.myvoiceaiconnect.com`;

  const bodyHtml =
    `<p style="margin:0 0 18px;">Hi ${agency.name}, your agency workspace is live. Here is where it lives and what to do next.</p>` +
    `<div style="padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">` +
    `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;margin:0 0 4px;">Your agency URL</div>` +
    `<div style="font-size:16px;font-weight:700;color:#0f172a;word-break:break-all;">${agencyUrl}</div>` +
    `</div>` +
    `<p style="margin:22px 0 8px;font-weight:700;color:#0f172a;">What to do next</p>` +
    `<ol style="margin:0;padding-left:20px;color:#334155;">` +
    `<li style="margin:0 0 6px;">Finish your branding and pricing in the dashboard</li>` +
    `<li style="margin:0 0 6px;">Connect Stripe so client payments land in your account</li>` +
    `<li style="margin:0;">Share your signup link and onboard your first client</li>` +
    `</ol>`;

  return sendEmail({
    from: 'VoiceAI Connect <onboarding@myvoiceaiconnect.com>',
    to: agency.email,
    subject: 'Your VoiceAI Connect agency is live',
    html: renderBrandedEmail({
      preheader: 'Your agency workspace is live. Here is what to do next.',
      heading: 'Your agency is live',
      bodyHtml,
      cta: { label: 'Log in to your dashboard', url: loginUrl },
    }),
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
async function sendViaAgencyTwilio(agency, toPhone, message, fromOverride = null) {
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

    // fromOverride forces From = a specific number, used by two-way replies where
    // the reply MUST come from the client's own SMS-capable number (a mobile).
    // resolveAgencySmsSender's alphanumeric fallback is one-way and cannot carry
    // a reply, so it is bypassed here. When null, resolve the best sender as before.
    const sender = fromOverride
      ? { From: fromOverride }
      : await resolveAgencySmsSender(agency, accountSid, authHeader);
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
  sendEmail, sendAgencyWelcomeEmail,
  getReferralSourceLabel
};