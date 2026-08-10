// ============================================================================
// TWO-WAY SMS ROUTES
// Handles inbound SMS from Telnyx webhook, outbound SMS from dashboard,
// and conversation CRUD for the Messages tab.
// UPDATED: 2026-06-16 - Per-tab Page Access enforcement. requirePermissionIfAuthed('messages')
//          on the dashboard-facing routes so a client_staff member without the
//          Messages toggle gets a 403, not just a hidden nav link. Owners and
//          untokened callers pass through. The Telnyx inbound webhook
//          (handleTelnyxSMSWebhook) is intentionally NOT gated - it is Telnyx
//          calling in, not a dashboard user.
// UPDATED: 2026-06-19 - Two-way SMS made functional:
//          (1) outbound /send now passes messaging_profile_id (without it the
//              client number is not authorized to send, so replies never left);
//          (2) findOrCreateConversation reads client_contacts (was a non-existent
//              'contacts' table, so caller names never populated);
//          (3) owner inbound-notify now uses sendTelnyxSMS (it was reading
//              TELNYX_SMS_FROM / SMS_FROM_NUMBER which do not exist, so the
//              platform number was always undefined and the notify silently
//              no-oped);
//          (4) delivery-status webhook maps Telnyx delivery_failed/sending_failed
//              to the UI's 'failed' so failed sends actually show as failed;
//          (5) findClientByPhone LIKE fallback bounded with limit(1).maybeSingle().
// UPDATED: 2026-08-06 - notifyOwnerOfInboundSMS now routes through sendAndLogSMS
//          with the client's agency_id instead of raw sendTelnyxSMS, so a non-US
//          (e.g. UK) owner alert goes out on the agency's own Twilio rather than
//          the platform Telnyx US number that UK carriers block. US clients fall
//          through to platform Telnyx inside sendAndLogSMS, unchanged. The notify
//          is now also written to sms_log. NOTE: outbound /send and the inbound
//          webhook are still Telnyx-only (two-way UK texting is the separate
//          Lane 2 build: a UK mobile number + /webhook/twilio-sms).
// UPDATED: 2026-08-07 - Lane 2 shipped. Added handleTwilioSMSWebhook (non-US
//          inbound over the agency's own Twilio) and made /send transport-aware:
//          a non-US BYOT client's reply goes out on the agency's Twilio FROM the
//          client's own mobile. US clients keep the Telnyx /send path unchanged.
// ============================================================================
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { requirePermissionIfAuthed } = require('./auth');
const { sendAndLogSMS } = require('../lib/sms-logger');
const { isInternationalAgency, agencyHasByotCreds, sendViaAgencyTwilio } = require('../lib/notifications');

const crypto = require('crypto');

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
// Optional. The base64 Ed25519 public key from Telnyx (Portal -> Account ->
// Public Key). When set, inbound webhooks are signature-verified and forged
// POSTs are rejected. When unset, verification is skipped (fail-open) so the
// feature keeps working until you wire the key in.
const TELNYX_PUBLIC_KEY = process.env.TELNYX_PUBLIC_KEY;

// Standard SPKI DER prefix for a raw 32-byte Ed25519 public key. Telnyx hands
// out the raw key base64-encoded, so we wrap it to build a Node KeyObject.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ============================================================================
// HELPER: Verify a Telnyx webhook Ed25519 signature.
// Returns true (valid), false (present key but bad/missing signature), or
// null (no key configured -> caller should skip verification).
// ============================================================================
function verifyTelnyxSignature(rawBody, signatureB64, timestamp) {
  if (!TELNYX_PUBLIC_KEY) return null;
  if (!signatureB64 || !timestamp || rawBody == null) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(TELNYX_PUBLIC_KEY, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    const signed = Buffer.from(`${timestamp}|${rawBody}`, 'utf8');
    return crypto.verify(null, signed, key, Buffer.from(signatureB64, 'base64'));
  } catch (err) {
    console.warn('Telnyx signature verify error:', err.message);
    return false;
  }
}

// ============================================================================
// HELPER: Get raw body + parsed body regardless of how the route is mounted.
// If server.js mounts this route with express.raw, req.body is a Buffer and we
// get the raw bytes needed for signature verification. If it is still on the
// global express.json (raw unavailable), req.body is already an object and we
// proceed without verification. Either way the handler works.
// ============================================================================
function getRawAndBody(req) {
  if (Buffer.isBuffer(req.body)) {
    const raw = req.body.toString('utf8');
    let parsed = {};
    try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
    return { raw, body: parsed };
  }
  return { raw: null, body: req.body || {} };
}

// ============================================================================
// HELPER: Normalize phone number to E.164
// ============================================================================
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (phone.startsWith('+')) return phone;
  return `+${digits}`;
}

// ============================================================================
// HELPER: Map a Telnyx message status to the UI's vocabulary
// UI knows: queued | sent | delivered | failed | received. Telnyx emits a
// wider set (delivery_failed, sending_failed, etc.), so collapse them here.
// ============================================================================
function mapTelnyxStatus(s) {
  switch ((s || '').toLowerCase()) {
    case 'delivered':
      return 'delivered';
    case 'sent':
    case 'sending':
    case 'queued':
      return 'sent';
    case 'delivery_failed':
    case 'sending_failed':
    case 'failed':
      return 'failed';
    default:
      return s || 'sent';
  }
}

// ============================================================================
// HELPER: Find client by their VAPI/Telnyx phone number
// ============================================================================
async function findClientByPhone(phoneNumber) {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return null;

  // Try exact match first
  const { data, error } = await supabase
    .from('clients')
    .select('id, business_name, owner_phone, agency_id, hipaa_mode, vapi_phone_number')
    .eq('vapi_phone_number', normalized)
    .single();

  if (!error && data) return data;

  // Try without +1 prefix. Bounded with limit(1).maybeSingle() so a LIKE that
  // matches more than one row returns the first instead of erroring.
  const without1 = normalized.startsWith('+1') ? normalized.slice(2) : normalized;
  const { data: d2 } = await supabase
    .from('clients')
    .select('id, business_name, owner_phone, agency_id, hipaa_mode, vapi_phone_number')
    .like('vapi_phone_number', `%${without1}`)
    .limit(1)
    .maybeSingle();

  return d2 || null;
}

// ============================================================================
// HELPER: Find or create conversation thread
// ============================================================================
async function findOrCreateConversation(clientId, callerPhone, callerName) {
  const normalized = normalizePhone(callerPhone);

  // Check for existing conversation
  const { data: existing } = await supabase
    .from('sms_conversations')
    .select('*')
    .eq('client_id', clientId)
    .eq('caller_phone', normalized)
    .single();

  if (existing) return existing;

  // Try to get caller name from contacts (client_contacts is the real table)
  let name = callerName || null;
  if (!name) {
    const { data: contact } = await supabase
      .from('client_contacts')
      .select('name')
      .eq('client_id', clientId)
      .eq('phone', normalized)
      .single();
    if (contact?.name && contact.name !== 'Unknown') name = contact.name;
  }

  // Create new conversation
  const { data: created, error } = await supabase
    .from('sms_conversations')
    .insert({
      client_id: clientId,
      caller_phone: normalized,
      caller_name: name,
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to create conversation:', error.message);
    // Race condition: another request may have created it
    const { data: retry } = await supabase
      .from('sms_conversations')
      .select('*')
      .eq('client_id', clientId)
      .eq('caller_phone', normalized)
      .single();
    return retry;
  }

  return created;
}

// ============================================================================
// HELPER: Send SMS notification to business owner about new inbound text
// Routes through sendAndLogSMS with the client's agency so a non-US (e.g. UK)
// owner alert is sent from the agency's OWN Twilio, not the platform Telnyx US
// number that UK carriers block. US agencies (and clients with no agency) fall
// through to platform Telnyx inside sendAndLogSMS, so US behavior is unchanged.
// It also logs the notify to sms_log like every other send. client.agency_id is
// selected by findClientByPhone, the only caller, so it is always available.
// ============================================================================
async function notifyOwnerOfInboundSMS(client, callerPhone, messageContent) {
  if (!client.owner_phone) return;

  try {
    const preview = messageContent.length > 100
      ? messageContent.substring(0, 100) + '...'
      : messageContent;

    const formatted = (callerPhone || '').replace(/(\+1)(\d{3})(\d{3})(\d{4})/, '($2) $3-$4');

    await sendAndLogSMS({
      phone: client.owner_phone,
      message: `💬 New text from ${formatted}:\n"${preview}"\n\nReply from your dashboard.`,
      agencyId: client.agency_id,
      recipientType: 'client_owner',
      messageType: 'client_inbound_sms_notify',
      metadata: { clientId: client.id, callerPhone },
    });
  } catch (err) {
    console.warn('Failed to notify owner of inbound SMS:', err.message);
  }
}

// ============================================================================
// POST /api/sms/send - Business owner sends a text to a caller
// ----------------------------------------------------------------------------
// Transport is chosen by the client's agency:
//   - Non-US agency with BYOT connected -> send on the agency's OWN Twilio,
//     FROM the client's own SMS-capable number (a mobile). The platform Telnyx
//     US number is blocked by non-US carriers, and the alphanumeric fallback is
//     one-way, so the reply must come from the client's real number.
//   - Everyone else (US) -> platform Telnyx, exactly as before. Unchanged.
// ============================================================================
router.post('/send', requirePermissionIfAuthed('messages'), async (req, res) => {
  try {
    const { client_id, to, message, conversation_id } = req.body;

    if (!client_id || !to || !message) {
      return res.status(400).json({ error: 'client_id, to, and message are required' });
    }

    if (message.length > 1600) {
      return res.status(400).json({ error: 'Message too long (max 1600 characters)' });
    }

    // Get client + its agency. The agency decides the transport (see header).
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, vapi_phone_number, business_name, hipaa_mode, agency_id, agencies!clients_agency_id_fkey(*)')
      .eq('id', client_id)
      .single();

    if (clientError || !client || !client.vapi_phone_number) {
      return res.status(404).json({ error: 'Client not found or no phone number assigned' });
    }

    const agency = client.agencies || null;
    const fromNumber = normalizePhone(client.vapi_phone_number);
    const toNumber = normalizePhone(to);

    if (!fromNumber || !toNumber) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    // A non-US BYOT agency's client replies over the agency's own Twilio; US
    // clients (and any agency without BYOT) stay on platform Telnyx.
    const useAgencyTwilio = !!(agency && isInternationalAgency(agency) && agencyHasByotCreds(agency));

    let providerMessageId = null;

    if (useAgencyTwilio) {
      // Reply via the agency's own Twilio, FROM the client's own SMS-capable
      // number. fromOverride is required here: resolveAgencySmsSender's
      // alphanumeric fallback is one-way and cannot carry a reply, so we force
      // From = the client's mobile.
      const result = await sendViaAgencyTwilio(agency, toNumber, message, fromNumber);
      if (!result.sent) {
        console.error(`Agency Twilio reply failed for ${client.business_name}:`, result.error);
        return res.status(500).json({ error: 'Failed to send SMS', details: result.error || 'agency_twilio_failed' });
      }
      providerMessageId = result.sid || null;
      console.log(`SMS reply sent via agency Twilio from ${fromNumber} to ${toNumber} (${providerMessageId || 'no-sid'})`);
    } else {
      // Platform Telnyx path (US), unchanged.
      // messaging_profile_id is REQUIRED: the client number must be on the
      // profile (and its 10DLC campaign) to be authorized to send.
      const telnyxResponse = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TELNYX_API_KEY}`,
        },
        body: JSON.stringify({
          from: fromNumber,
          to: toNumber,
          text: message,
          messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
        }),
      });

      const telnyxData = await telnyxResponse.json();

      if (!telnyxResponse.ok) {
        console.error('Telnyx send failed:', JSON.stringify(telnyxData));
        return res.status(500).json({ error: 'Failed to send SMS', details: telnyxData.errors?.[0]?.detail || 'Unknown error' });
      }

      providerMessageId = telnyxData.data?.id || null;
      console.log(`SMS sent via Telnyx from ${fromNumber} to ${toNumber} (${providerMessageId})`);
    }

    // Find or create conversation
    const conversation = await findOrCreateConversation(client_id, toNumber);
    if (!conversation) {
      return res.status(500).json({ error: 'Failed to create conversation thread' });
    }

    // Save the message. providerMessageId (Telnyx id or Twilio SID) is stored in
    // the existing telnyx_message_id column regardless of transport.
    const { data: savedMessage, error: msgError } = await supabase
      .from('sms_messages')
      .insert({
        conversation_id: conversation.id,
        client_id: client_id,
        direction: 'outbound',
        content: message,
        sender_phone: fromNumber,
        recipient_phone: toNumber,
        telnyx_message_id: providerMessageId,
        status: 'sent',
      })
      .select()
      .single();

    if (msgError) {
      console.error('Failed to save outbound message:', msgError.message);
    }

    // Update conversation metadata
    await supabase
      .from('sms_conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: message.substring(0, 100),
        last_direction: 'outbound',
      })
      .eq('id', conversation.id);

    res.json({
      success: true,
      message: savedMessage,
      conversation_id: conversation.id,
      telnyx_message_id: providerMessageId,
    });

  } catch (error) {
    console.error('SMS send error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/sms/conversations/:clientId - List all conversations for a client
// ============================================================================
router.get('/conversations/:clientId', requirePermissionIfAuthed('messages'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { archived } = req.query;

    const query = supabase
      .from('sms_conversations')
      .select('*')
      .eq('client_id', clientId)
      .eq('is_archived', archived === 'true')
      .order('last_message_at', { ascending: false });

    const { data, error } = await query;

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, conversations: data || [] });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/sms/conversations/:clientId/:conversationId - Get messages in thread
// ============================================================================
router.get('/conversations/:clientId/:conversationId', requirePermissionIfAuthed('messages'), async (req, res) => {
  try {
    const { clientId, conversationId } = req.params;
    const { limit = 50, before } = req.query;

    // Verify conversation belongs to client
    const { data: conv, error: convError } = await supabase
      .from('sms_conversations')
      .select('*')
      .eq('id', conversationId)
      .eq('client_id', clientId)
      .single();

    if (convError || !conv) return res.status(404).json({ error: 'Conversation not found' });

    let query = supabase
      .from('sms_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: false })
      .limit(parseInt(limit));

    if (before) {
      query = query.lt('sent_at', before);
    }

    const { data: messages, error } = await query;

    if (error) return res.status(400).json({ error: error.message });

    res.json({
      success: true,
      conversation: conv,
      messages: (messages || []).reverse(), // Return in chronological order
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/sms/conversations/:clientId/:conversationId/read - Mark read
// clientId in the path + scoped update so a staff member with the messages
// permission cannot mark another client's thread by guessing a UUID.
// ============================================================================
router.put('/conversations/:clientId/:conversationId/read', requirePermissionIfAuthed('messages'), async (req, res) => {
  try {
    const { clientId, conversationId } = req.params;

    const { error } = await supabase
      .from('sms_conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId)
      .eq('client_id', clientId);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking conversation as read:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/sms/conversations/:clientId/:conversationId/archive - Toggle archive
// clientId in the path + scoped update for the same cross-tenant reason as read.
// ============================================================================
router.put('/conversations/:clientId/:conversationId/archive', requirePermissionIfAuthed('messages'), async (req, res) => {
  try {
    const { clientId, conversationId } = req.params;
    const { archived } = req.body;

    const { error } = await supabase
      .from('sms_conversations')
      .update({ is_archived: archived === true })
      .eq('id', conversationId)
      .eq('client_id', clientId);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (error) {
    console.error('Error archiving conversation:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/sms/unread/:clientId - Get total unread count for badge
// ============================================================================
router.get('/unread/:clientId', requirePermissionIfAuthed('messages'), async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data, error } = await supabase
      .from('sms_conversations')
      .select('unread_count')
      .eq('client_id', clientId)
      .eq('is_archived', false)
      .gt('unread_count', 0);

    if (error) return res.status(400).json({ error: error.message });

    const total = (data || []).reduce((sum, c) => sum + (c.unread_count || 0), 0);

    res.json({ success: true, unread: total });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

// ============================================================================
// TELNYX INBOUND SMS WEBHOOK HANDLER
// Mount this at POST /webhook/telnyx-sms in server.js
// Telnyx sends webhooks for inbound messages to the messaging profile URL
// NOT gated - this is Telnyx calling in, no user token involved.
// ============================================================================
module.exports.handleTelnyxSMSWebhook = async function handleTelnyxSMSWebhook(req, res) {
  try {
    const { raw, body } = getRawAndBody(req);

    // Verify the Telnyx signature when a public key is configured AND we have
    // the raw bytes (route mounted with express.raw). A configured key with a
    // bad or missing signature is rejected; no key means we skip (fail-open).
    if (TELNYX_PUBLIC_KEY && raw !== null) {
      const valid = verifyTelnyxSignature(
        raw,
        req.headers['telnyx-signature-ed25519'],
        req.headers['telnyx-timestamp']
      );
      if (valid === false) {
        console.warn('Telnyx webhook signature invalid - rejecting');
        return res.status(401).json({ error: 'invalid signature' });
      }
    }

    const event = body?.data;

    if (!event) {
      return res.status(200).json({ received: true });
    }

    const eventType = event.event_type || body?.event_type;

    // Handle delivery status updates
    if (eventType === 'message.finalized' || eventType === 'message.sent' || eventType === 'message.delivered') {
      const telnyxMessageId = event.payload?.id;
      const rawStatus = event.payload?.to?.[0]?.status || 'delivered';
      const status = mapTelnyxStatus(rawStatus);

      if (telnyxMessageId) {
        const update = { status };
        if (status === 'failed') {
          update.error_message = event.payload?.errors?.[0]?.detail
            || event.payload?.to?.[0]?.status
            || 'delivery failed';
        }
        await supabase
          .from('sms_messages')
          .update(update)
          .eq('telnyx_message_id', telnyxMessageId);
      }

      return res.status(200).json({ received: true });
    }

    // Handle inbound messages
    if (eventType !== 'message.received') {
      return res.status(200).json({ received: true, ignored: true });
    }

    const payload = event.payload;
    const callerPhone = normalizePhone(payload.from?.phone_number);
    const clientPhone = normalizePhone(payload.to?.[0]?.phone_number || payload.to);
    const messageText = payload.text || '';

    if (!callerPhone || !clientPhone || !messageText.trim()) {
      console.log('Inbound SMS missing required fields');
      return res.status(200).json({ received: true, skipped: true });
    }

    console.log(`Inbound SMS: ${callerPhone} -> ${clientPhone}: "${messageText.substring(0, 50)}..."`);

    // Find which client owns this phone number
    const client = await findClientByPhone(clientPhone);

    if (!client) {
      console.warn(`No client found for number ${clientPhone} - ignoring inbound SMS`);
      return res.status(200).json({ received: true, noClient: true });
    }

    // Find or create conversation
    const conversation = await findOrCreateConversation(client.id, callerPhone);

    if (!conversation) {
      console.error('Failed to find/create conversation for inbound SMS');
      return res.status(200).json({ received: true, error: 'conversation_failed' });
    }

    // Save the inbound message
    const { error: msgError } = await supabase
      .from('sms_messages')
      .insert({
        conversation_id: conversation.id,
        client_id: client.id,
        direction: 'inbound',
        content: messageText,
        sender_phone: callerPhone,
        recipient_phone: clientPhone,
        telnyx_message_id: payload.id || null,
        status: 'received',
      });

    if (msgError) {
      console.error('Failed to save inbound message:', msgError.message);
    }

    // Update conversation metadata
    await supabase
      .from('sms_conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: messageText.substring(0, 100),
        last_direction: 'inbound',
        unread_count: (conversation.unread_count || 0) + 1,
      })
      .eq('id', conversation.id);

    // Notify business owner
    await notifyOwnerOfInboundSMS(client, callerPhone, messageText);

    console.log(`Inbound SMS saved for client ${client.business_name}`);

    return res.status(200).json({ received: true, saved: true, conversationId: conversation.id });

  } catch (error) {
    console.error('Telnyx SMS webhook error:', error);
    return res.status(200).json({ received: true, error: error.message });
  }
};

// ============================================================================
// TWILIO INBOUND SMS WEBHOOK HANDLER (Lane 2 - non-US two-way texting)
// ----------------------------------------------------------------------------
// Mount at POST /webhook/twilio-sms in server.js with express.urlencoded.
// Twilio posts application/x-www-form-urlencoded with From, To, Body, MessageSid.
// This is the INBOUND half of two-way texting for non-US clients whose AI number
// is a MOBILE number on the agency's own Twilio (see routes/byot.js smsCapable +
// routes/client-signup.js provisioning). US clients are unaffected: their inbound
// arrives on handleTelnyxSMSWebhook above, which is untouched.
//
// Signature validation is intentionally SKIPPED (fail-open), mirroring the
// Telnyx handler: BYOT stores only Twilio SK API keys, not the account Auth
// Token that signs Twilio webhooks, so there is no secret here to verify with.
//
// HIPAA: for a hipaa_mode client we never store the message body. The thread is
// still created and the owner is still alerted (with no PHI in the alert), but
// the content is redacted at rest.
//
// STOP/HELP/START: Twilio enforces carrier opt-out and the compliance auto-reply
// at the account level, so we do not send anything and do not notify the owner
// for a control keyword. We just return empty TwiML.
// ============================================================================

// Carrier control words. Lowercased, exact-match against a trimmed single word.
const SMS_STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const SMS_HELP_KEYWORDS = new Set(['help', 'info']);
const SMS_START_KEYWORDS = new Set(['start', 'yes', 'unstop']);

function classifyControlKeyword(bodyText) {
  const t = (bodyText || '').trim().toLowerCase();
  if (SMS_STOP_KEYWORDS.has(t)) return 'stop';
  if (SMS_HELP_KEYWORDS.has(t)) return 'help';
  if (SMS_START_KEYWORDS.has(t)) return 'start';
  return null;
}

// Empty TwiML so Twilio does not auto-reply on our behalf. Always 200.
function emptyTwiml(res) {
  res.set('Content-Type', 'text/xml');
  return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

module.exports.handleTwilioSMSWebhook = async function handleTwilioSMSWebhook(req, res) {
  try {
    // server.js mounts this route with express.urlencoded, so req.body is a
    // plain object of Twilio's form fields.
    const body = req.body || {};
    const callerPhone = normalizePhone(body.From);
    const clientPhone = normalizePhone(body.To);
    const messageText = (body.Body || '').toString();
    const messageSid = body.MessageSid || body.SmsSid || null;

    if (!callerPhone || !clientPhone) {
      console.log('Twilio inbound SMS missing From/To');
      return emptyTwiml(res);
    }

    // Find which client owns this number
    const client = await findClientByPhone(clientPhone);
    if (!client) {
      console.warn(`No client found for Twilio number ${clientPhone} - ignoring inbound SMS`);
      return emptyTwiml(res);
    }

    // Carrier control words (STOP/HELP/START). Twilio handles the compliance
    // reply and the opt-out list itself at the account level, so we neither
    // send anything nor notify the owner. Just acknowledge with empty TwiML.
    const control = classifyControlKeyword(messageText);
    if (control) {
      console.log(`Twilio inbound control keyword '${control}' from ${callerPhone} for ${client.business_name} - not stored, owner not notified`);
      return emptyTwiml(res);
    }

    if (!messageText.trim()) {
      return emptyTwiml(res);
    }

    console.log(`Twilio inbound SMS: ${callerPhone} -> ${clientPhone} (${client.business_name})`);

    // Find or create the conversation thread
    const conversation = await findOrCreateConversation(client.id, callerPhone);
    if (!conversation) {
      console.error('Failed to find/create conversation for Twilio inbound SMS');
      return emptyTwiml(res);
    }

    // HIPAA mode: never store the message body. The conversation still threads
    // and the owner is still alerted, but the content is redacted at rest and
    // the alert carries no PHI.
    const hipaa = client.hipaa_mode === true;
    const storedContent = hipaa ? '[Message hidden - HIPAA mode]' : messageText;

    const { error: msgError } = await supabase
      .from('sms_messages')
      .insert({
        conversation_id: conversation.id,
        client_id: client.id,
        direction: 'inbound',
        content: storedContent,
        sender_phone: callerPhone,
        recipient_phone: clientPhone,
        telnyx_message_id: messageSid, // reuse the existing provider-message-id column
        status: 'received',
      });
    if (msgError) console.error('Failed to save Twilio inbound message:', msgError.message);

    // Update conversation metadata
    await supabase
      .from('sms_conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: (hipaa ? 'New message' : messageText).substring(0, 100),
        last_direction: 'inbound',
        unread_count: (conversation.unread_count || 0) + 1,
      })
      .eq('id', conversation.id);

    // Notify the owner. notifyOwnerOfInboundSMS routes via the agency's own
    // Twilio for non-US owners (see sms-logger.js), so the alert is deliverable.
    // For a HIPAA client we pass a generic line so no PHI leaves in the alert.
    await notifyOwnerOfInboundSMS(
      client,
      callerPhone,
      hipaa ? 'You received a new text (hidden for HIPAA).' : messageText
    );

    console.log(`Twilio inbound SMS saved for client ${client.business_name}`);
    return emptyTwiml(res);

  } catch (error) {
    console.error('Twilio SMS webhook error:', error);
    // Still return empty TwiML so Twilio does not treat it as a failure and retry-storm.
    return emptyTwiml(res);
  }
};