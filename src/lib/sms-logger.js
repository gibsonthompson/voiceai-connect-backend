// ============================================================================
// SMS LOGGER — Wraps sendTelnyxSMS with automatic logging to sms_log table
//
// Usage:
//   const { sendAndLogSMS } = require('../lib/sms-logger');
//   await sendAndLogSMS({
//     phone: '+15551234567',
//     message: 'Hello world',
//     agencyId: 'uuid-here',           // optional
//     recipientType: 'agency_owner',    // agency_owner | client_owner | prospect | admin
//     messageType: 'activation_sms_1', // descriptive key for filtering
//     metadata: { step: 1 },           // optional extra context
//   });
//
// CREATED: 2026-05-09
// UPDATED: 2026-05-20 — Early bail on undefined/null/empty phone to prevent
//          "Invalid phone number: undefined" log spam from callers with wrong
//          param names or missing data.
// ============================================================================

const { supabase } = require('./supabase');
const {
  sendTelnyxSMS,
  formatPhoneE164,
  isInternationalAgency,
  agencyHasByotCreds,
  sendViaAgencyTwilio,
} = require('./notifications');

/**
 * Send an SMS via Telnyx and log it to the sms_log table.
 * Returns true if SMS was sent successfully, false otherwise.
 */
async function sendAndLogSMS({ phone, message, agencyId, recipientType, messageType, metadata }) {
  // ── Early bail: phone must be a non-empty string ────────────────────
  // Catches callers passing undefined (e.g. wrong param name like "to" instead
  // of "phone") before we hit formatPhoneE164 and log a noisy warning.
  if (!phone || typeof phone !== 'string' || phone.trim().length === 0) {
    console.warn(`⚠️ SMS Logger: Skipped — no phone provided for ${messageType || 'unknown'} (got: ${typeof phone === 'string' ? `"${phone}"` : String(phone)})`);
    await logSMS({
      agencyId,
      phone: 'missing',
      recipientType,
      messageType,
      message,
      telnyxMessageId: null,
      status: 'skipped',
      metadata: { ...metadata, error: 'No phone number provided' },
    });
    return false;
  }

  // ── Resolve the agency (if any) to decide the transport ─────────────
  // A non-US agency with BYOT connected must send its agency-scoped SMS from
  // its OWN Twilio, not the platform Telnyx US number (which does not deliver
  // reliably internationally). Admin/platform texts (recipientType 'admin')
  // always stay on platform Telnyx. On a lookup failure we fall back to the
  // platform sender, which is the pre-existing behavior for every SMS.
  let agency = null;
  if (agencyId) {
    try {
      const { data } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
      agency = data || null;
    } catch (err) {
      console.warn(`⚠️ SMS Logger: agency lookup failed for ${agencyId}, using platform sender:`, err.message);
    }
  }

  const useAgencyTwilio = !!(agency
    && recipientType !== 'admin'
    && isInternationalAgency(agency)
    && agencyHasByotCreds(agency));

  // Format for the agency's country when known (e.g. a GB 0-prefixed number),
  // otherwise US as before.
  const formattedPhone = formatPhoneE164(phone, (agency && agency.country) || 'US');
  if (!formattedPhone) {
    console.warn(`⚠️ SMS Logger: Invalid phone number: ${phone} (for ${messageType || 'unknown'})`);
    await logSMS({
      agencyId,
      phone: phone || 'invalid',
      recipientType,
      messageType,
      message,
      telnyxMessageId: null,
      status: 'failed',
      metadata: { ...metadata, error: 'Invalid phone number' },
    });
    return false;
  }

  let sent = false;
  let telnyxMessageId = null;
  let sendMeta = { ...(metadata || {}) };

  if (useAgencyTwilio) {
    try {
      const result = await sendViaAgencyTwilio(agency, formattedPhone, message);
      sent = result.sent;
      sendMeta = { ...sendMeta, sms_provider: 'agency_twilio', sms_from: result.from || null, twilio_sid: result.sid || null };
      if (!sent) {
        // Do NOT fall back to the platform Telnyx number for a non-US agency.
        // That would reintroduce the exact international deliverability problem
        // this path exists to fix. Surface the failure instead.
        sendMeta.sms_error = result.error || 'agency_twilio_failed';
        if (result.code) sendMeta.sms_error_code = result.code;
        console.error(`❌ SMS Logger: agency Twilio send failed for ${messageType} (${agency.name}); not falling back to platform. Reason: ${result.error}`);
      }
    } catch (err) {
      console.error(`❌ SMS Logger: agency Twilio send threw for ${messageType}:`, err.message);
      sendMeta = { ...sendMeta, sms_provider: 'agency_twilio', sms_error: err.message };
    }
  } else {
    try {
      // sendTelnyxSMS returns true/false — we can't get the message ID from current implementation
      // If you update sendTelnyxSMS to return the response, we can capture the ID
      sent = await sendTelnyxSMS(formattedPhone, message);
    } catch (err) {
      console.error(`❌ SMS Logger: Telnyx send failed for ${messageType}:`, err.message);
    }
    sendMeta = { ...sendMeta, sms_provider: 'platform_telnyx' };
  }

  // Log regardless of outcome
  await logSMS({
    agencyId,
    phone: formattedPhone,
    recipientType,
    messageType,
    message,
    telnyxMessageId,
    status: sent ? 'sent' : 'failed',
    metadata: sendMeta,
  });

  return sent;
}

/**
 * Insert a row into sms_log. Never throws — failures are swallowed with a warning.
 */
async function logSMS({ agencyId, phone, recipientType, messageType, message, telnyxMessageId, status, metadata }) {
  try {
    await supabase.from('sms_log').insert({
      agency_id: agencyId || null,
      recipient_phone: phone,
      recipient_type: recipientType || 'unknown',
      message_type: messageType || 'unknown',
      message_body: message,
      telnyx_message_id: telnyxMessageId || null,
      delivery_status: status || 'sent',
      metadata: metadata || null,
    });
  } catch (err) {
    console.warn('⚠️ SMS log insert failed:', err.message);
  }
}

module.exports = { sendAndLogSMS, logSMS };