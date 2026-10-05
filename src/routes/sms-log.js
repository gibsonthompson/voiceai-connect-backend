// ============================================================================
// ADMIN SMS LOG ENDPOINT
// GET /api/admin/sms-log
// Query params: agency_id, type, recipient_type, from, to, limit, offset
//
// Add to admin.js routes or mount separately.
// Usage: app.use('/api/admin', smsLogRoutes);
//
// CREATED: 2026-05-09
// UPDATED: 2026-08-03 - Fixed admin auth check. The token minted by
//          generateToken (auth.js) carries role: 'platform_admin', NOT
//          type: 'admin'. The old `decoded.type !== 'admin'` check was always
//          true for a valid admin token, so every request 403'd ("Failed to
//          fetch SMS logs"). Now matches requireAdmin: role === 'platform_admin'.
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { sendAndLogSMS } = require('../lib/sms-logger');
// Same platform send-number the agency reply inbox uses.
const PLATFORM_SMS_NUMBER = process.env.TELNYX_SMS_FROM_NUMBER || '+15054317109';

router.get('/sms-log', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });

    // Verify admin. Tokens from generateToken carry { role: 'platform_admin' }
    // in camelCase; this mirrors requireAdmin (decoded.role === 'platform_admin').
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET);
    if (!decoded || decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const {
      agency_id,
      type,
      recipient_type,
      from: fromDate,
      to: toDate,
      limit = 50,
      offset = 0,
    } = req.query;

    // Build query
    let query = supabase
      .from('sms_log')
      .select(`
        id,
        agency_id,
        recipient_phone,
        recipient_type,
        message_type,
        message_body,
        delivery_status,
        metadata,
        created_at
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    // Apply filters
    if (agency_id) {
      query = query.eq('agency_id', agency_id);
    }
    if (type) {
      query = query.eq('message_type', type);
    }
    if (recipient_type) {
      query = query.eq('recipient_type', recipient_type);
    }
    if (fromDate) {
      query = query.gte('created_at', new Date(fromDate).toISOString());
    }
    if (toDate) {
      query = query.lte('created_at', new Date(toDate).toISOString());
    }

    const { data: logs, error, count } = await query;

    if (error) {
      console.error('❌ SMS log query error:', error);
      return res.status(500).json({ error: 'Failed to fetch SMS logs' });
    }

    // Fetch agency names for the logs that have agency_id
    const agencyIds = [...new Set((logs || []).filter(l => l.agency_id).map(l => l.agency_id))];
    let agencyMap = {};

    if (agencyIds.length > 0) {
      const { data: agencies } = await supabase
        .from('agencies')
        .select('id, name')
        .in('id', agencyIds);

      if (agencies) {
        agencyMap = Object.fromEntries(agencies.map(a => [a.id, a.name]));
      }
    }

    // Enrich logs with agency name
    const enrichedLogs = (logs || []).map(log => ({
      ...log,
      agency_name: log.agency_id ? (agencyMap[log.agency_id] || 'Unknown') : null,
    }));

    // Get distinct message types for filter dropdown
    const { data: types } = await supabase
      .from('sms_log')
      .select('message_type')
      .limit(100);

    const distinctTypes = [...new Set((types || []).map(t => t.message_type))].sort();

    res.json({
      success: true,
      logs: enrichedLogs,
      total: count || 0,
      limit: parseInt(limit),
      offset: parseInt(offset),
      types: distinctTypes,
    });

  } catch (error) {
    console.error('❌ SMS log error:', error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/admin/sms-log/thread?phone=E164
// Full conversation with one number, both directions, so admin can see the
// context a reply was responding to. Outbound messages store the person as
// recipient_phone; their inbound replies store it as metadata.from.
// ============================================================================
router.get('/sms-log/thread', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET);
    if (!decoded || decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    // Two explicit, scoped queries, merged. Outbound messages store the person
    // as recipient_phone; their inbound replies store it as metadata.from. The
    // earlier single .or() with a JSON path silently matched nothing and
    // returned the whole table, this is reliable and actually filters.
    const FIELDS = 'id, agency_id, recipient_phone, recipient_type, message_type, message_body, delivery_status, metadata, created_at';
    const [outRes, inRes] = await Promise.all([
      supabase.from('sms_log').select(FIELDS).eq('recipient_phone', phone).order('created_at', { ascending: true }).limit(300),
      supabase.from('sms_log').select(FIELDS).eq('metadata->>from', phone).order('created_at', { ascending: true }).limit(300),
    ]);
    if (outRes.error) throw outRes.error;
    if (inRes.error) console.warn('sms-log thread inbound query warning:', inRes.error.message);
    const byId = new Map();
    for (const r of [...(outRes.data || []), ...(inRes.data || [])]) byId.set(r.id, r);
    const data = [...byId.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    let agencyName = null;
    const agencyId = (data || []).map(r => r.agency_id).find(Boolean);
    if (agencyId) {
      const { data: ag } = await supabase.from('agencies').select('name').eq('id', agencyId).maybeSingle();
      agencyName = ag?.name || null;
    }

    const messages = (data || []).map(r => ({
      id: r.id,
      body: r.message_body,
      type: r.message_type,
      direction: (r.metadata?.direction === 'inbound' || String(r.message_type || '').includes('inbound')) ? 'inbound' : 'outbound',
      status: r.delivery_status,
      created_at: r.created_at,
    }));

    res.json({ phone, agency_name: agencyName, messages });
  } catch (err) {
    console.error('sms-log thread error:', err.message);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

// ============================================================================
// POST /api/admin/sms-log/thread/reply  body { phone, message }
// Send a reply to a number from the platform line, logged outbound so it shows
// up in that number's thread. Lets admin answer a reply directly from Messaging
// instead of texting from a phone.
// ============================================================================
router.post('/sms-log/thread/reply', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET);
    if (!decoded || decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const phone = String((req.body && req.body.phone) || '').trim();
    const message = String((req.body && req.body.message) || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (message.length > 1600) return res.status(400).json({ error: 'Message too long (max 1600)' });

    // Best-effort: carry the agency this number belongs to onto the log row.
    let agencyId = null;
    try {
      const { data } = await supabase
        .from('sms_log').select('agency_id')
        .eq('recipient_phone', phone).not('agency_id', 'is', null).limit(1);
      agencyId = (data && data[0] && data[0].agency_id) || null;
    } catch (e) { /* non-blocking */ }

    const sent = await sendAndLogSMS({
      phone,
      message,
      agencyId,
      recipientType: 'agency_owner',
      messageType: 'admin_reply',
      from: PLATFORM_SMS_NUMBER,
      metadata: { direction: 'outbound', admin_reply: true },
    });
    if (!sent) return res.status(500).json({ error: 'Failed to send SMS' });

    res.json({
      ok: true,
      message: { id: `tmp-${Date.now()}`, body: message, direction: 'outbound', type: 'admin_reply', status: 'sent', created_at: new Date().toISOString() },
    });
  } catch (err) {
    console.error('sms-log thread reply error:', err.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// GET /api/admin/sms-log/conversations
// The SMS log grouped by contact, for the messaging UI's left pane. A contact's
// phone is recipient_phone on outbound rows and metadata.from on inbound rows
// (same split as /thread). Returns the latest message per contact, newest first.
router.get('/sms-log/conversations', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET);
    if (!decoded || decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const FIELDS = 'id, agency_id, recipient_phone, recipient_type, message_type, message_body, delivery_status, metadata, created_at';
    const { data, error } = await supabase
      .from('sms_log')
      .select(FIELDS)
      .order('created_at', { ascending: false })
      .limit(3000);
    if (error) return res.status(500).json({ error: error.message });

    const convos = new Map();
    for (const r of data || []) {
      const inbound = (r.metadata?.direction === 'inbound' || String(r.message_type || '').includes('inbound'));
      if (r.recipient_type === 'admin') continue; // platform alerts/notifications belong in Alerts, not the messaging inbox
      const phone = inbound ? (r.metadata?.from || null) : (r.recipient_phone || null);
      if (!phone) continue;
      const existing = convos.get(phone);
      if (!existing) {
        // First row seen for this phone is the latest (rows are desc by created_at).
        convos.set(phone, {
          phone,
          agency_id: r.agency_id || null,
          last_body: r.message_body || '',
          last_at: r.created_at,
          last_direction: inbound ? 'inbound' : 'outbound',
          count: 1,
        });
      } else {
        existing.count += 1;
        if (!existing.agency_id && r.agency_id) existing.agency_id = r.agency_id;
      }
    }

    const agencyIds = [...new Set([...convos.values()].map(c => c.agency_id).filter(Boolean))];
    let agencyMap = {};
    if (agencyIds.length) {
      const { data: ags } = await supabase.from('agencies').select('id, name').in('id', agencyIds);
      agencyMap = Object.fromEntries((ags || []).map(a => [a.id, a.name]));
    }

    const conversations = [...convos.values()]
      .map(c => ({ ...c, agency_name: c.agency_id ? (agencyMap[c.agency_id] || null) : null }))
      .sort((a, b) => new Date(b.last_at) - new Date(a.last_at));

    res.json({ conversations });
  } catch (err) {
    console.error('sms-log conversations error:', err.message);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

module.exports = router;