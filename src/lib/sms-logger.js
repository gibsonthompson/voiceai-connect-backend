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
// ============================================================================

const { supabase } = require('./supabase');
const { sendTelnyxSMS, formatPhoneE164 } = require('./notifications');

/**
 * Send an SMS via Telnyx and log it to the sms_log table.
 * Returns true if SMS was sent successfully, false otherwise.
 */
async function sendAndLogSMS({ phone, message, agencyId, recipientType, messageType, metadata }) {
  const formattedPhone = formatPhoneE164(phone);
  if (!formattedPhone) {
    console.warn(`⚠️ SMS Logger: Invalid phone number: ${phone}`);
    // Log the failure
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
