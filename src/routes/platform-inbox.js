// ============================================================================
// PLATFORM SMS INBOX (admin)
// Agency owners' replies to the platform SMS number (activation/engagement
// texts) are captured into sms_log by handleAgencyReplyToPlatform (sms.js).
// This exposes them as a conversation inbox the platform admin can read and
// reply to, with the reply going back out FROM the platform number so the
// agency sees one continuous thread.
//
// Mount:  app.use('/api/admin', require('./routes/platform-inbox'));
//
// Endpoints:
//   GET  /platform-inbox                 -> conversation list (newest first)
//   GET  /platform-inbox/:agencyId       -> full thread + marks it read
//   POST /platform-inbox/:agencyId/reply -> send a reply from the platform number
// ============================================================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');
const { sendAndLogSMS } = require('../lib/sms-logger');

const PLATFORM_SMS_NUMBER = process.env.TELNYX_SMS_FROM_NUMBER || '+15054317109';

// Mirror requireAdmin (auth.js): tokens from generateToken carry role: 'platform_admin'.
function requireAdmin(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No token' }); return null; }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET);
    if (!decoded || decoded.role !== 'platform_admin') { res.status(403).json({ error: 'Forbidden' }); return null; }
    return decoded;
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
}

function directionOf(row) {
  return (row.message_type === 'agency_reply_inbound' || row.metadata?.direction === 'inbound') ? 'inbound' : 'outbound';
}

// ── Conversation list ───────────────────────────────────────────────────────
// Agencies that have replied at least once, newest activity first, with the
// latest inbound preview and an unread count (inbound since last opened).
router.get('/platform-inbox', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { data: inbound } = await supabase
      .from('sms_log')
      .select('agency_id, message_body, created_at')
      .eq('message_type', 'agency_reply_inbound')
      .not('agency_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500);

    const byAgency = new Map();
    for (const row of inbound || []) {
      if (!byAgency.has(row.agency_id)) {
        byAgency.set(row.agency_id, { lastMessage: row.message_body, lastAt: row.created_at, inboundTimes: [] });
      }
      byAgency.get(row.agency_id).inboundTimes.push(row.created_at);
    }

    const ids = [...byAgency.keys()];
    if (ids.length === 0) return res.json({ conversations: [] });

    const { data: agencies } = await supabase
      .from('agencies')
      .select('id, name, phone, platform_replies_read_at')
      .in('id', ids);
    const agMap = new Map((agencies || []).map(a => [a.id, a]));

    const conversations = ids.map((id) => {
      const c = byAgency.get(id);
      const a = agMap.get(id) || {};
      const readAt = a.platform_replies_read_at ? new Date(a.platform_replies_read_at).getTime() : 0;
      const unread = c.inboundTimes.filter((t) => new Date(t).getTime() > readAt).length;
      return {
        agencyId: id,
        agencyName: a.name || 'Unknown agency',
        phone: a.phone || null,
        lastMessage: c.lastMessage,
        lastAt: c.lastAt,
        unread,
      };
    }).sort((x, y) => new Date(y.lastAt) - new Date(x.lastAt));

    res.json({ conversations });
  } catch (err) {
    console.error('platform-inbox list error:', err.message);
    res.status(500).json({ error: 'Failed to load inbox' });
  }
});

// ── Full thread (and mark read) ─────────────────────────────────────────────
router.get('/platform-inbox/:agencyId', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { agencyId } = req.params;
    const { data: agency } = await supabase
      .from('agencies').select('id, name, phone').eq('id', agencyId).maybeSingle();
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    const { data: rows } = await supabase
      .from('sms_log')
      .select('id, message_body, message_type, metadata, created_at, delivery_status')
      .eq('agency_id', agencyId)
      .eq('recipient_type', 'agency_owner')
      .order('created_at', { ascending: true })
      .limit(500);

    const messages = (rows || []).map((r) => ({
      id: r.id,
      body: r.message_body,
      direction: directionOf(r),
      at: r.created_at,
      type: r.message_type,
      status: r.delivery_status,
    }));

    // Mark this conversation read.
    await supabase.from('agencies')
      .update({ platform_replies_read_at: new Date().toISOString() })
      .eq('id', agencyId);

    res.json({ agency: { id: agency.id, name: agency.name, phone: agency.phone }, messages });
  } catch (err) {
    console.error('platform-inbox thread error:', err.message);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

// ── Reply (sends FROM the platform number) ──────────────────────────────────
router.post('/platform-inbox/:agencyId/reply', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { agencyId } = req.params;
    const message = (req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (message.length > 1600) return res.status(400).json({ error: 'Message too long (max 1600)' });

    const { data: agency } = await supabase
      .from('agencies').select('id, name, phone').eq('id', agencyId).maybeSingle();
    if (!agency || !agency.phone) return res.status(404).json({ error: 'Agency or owner phone not found' });

    const sent = await sendAndLogSMS({
      phone: agency.phone,
      message,
      agencyId,
      recipientType: 'agency_owner',
      messageType: 'admin_reply',
      from: PLATFORM_SMS_NUMBER,
      metadata: { direction: 'outbound', admin_reply: true },
    });
    if (!sent) return res.status(500).json({ error: 'Failed to send SMS' });

    res.json({ ok: true });
  } catch (err) {
    console.error('platform-inbox reply error:', err.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

module.exports = router;