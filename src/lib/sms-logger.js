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
const { sendTelnyxSMS, formatPhoneE164 } = require('./notifications');

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

  const formattedPhone = formatPhoneE164(phone);
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

  try {
    // sendTelnyxSMS returns true/false — we can't get the message ID from current implementation
    // If you update sendTelnyxSMS to return the response, we can capture the ID
    sent = await sendTelnyxSMS(formattedPhone, message);
  } catch (err) {
    console.error(`❌ SMS Logger: Telnyx send failed for ${messageType}:`, err.message);
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
    metadata,
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