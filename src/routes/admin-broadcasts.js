// ============================================================================
// PLATFORM BROADCASTS - admin-authored, agency-wide announcements.
//
// Two delivery channels, either or both per broadcast:
//   1. Dashboard banner: shown on every agency dashboard until it expires
//      (optional timer) or the agency dismisses it. A dismissed banner does not
//      come back; the NEXT broadcast shows again (tracked by the latest
//      dismissed broadcast id on the agency row).
//   2. Mass SMS: texted to every agency owner from the platform number.
//
// adminRouter  -> mounted at /api/admin  (platform_admin only)
// agencyRouter -> mounted at /api/agency (agency dashboard access)
//
// Storage:
//   platform_broadcasts  (id, title, body, link_url, link_label,
//                         show_on_dashboard, expires_at, sms_sent,
//                         sms_recipients, created_by, created_at)
//   agencies.dismissed_broadcast_id  uuid  (the last banner they X'd off)
// ============================================================================
const express = require('express');
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

let sendAndLogSMS;
try { sendAndLogSMS = require('../lib/sms-logger').sendAndLogSMS; }
catch (e) { console.warn('⚠️ admin-broadcasts: sms-logger not available, SMS disabled:', e.message); }

// ----------------------------------------------------------------------------
// ADMIN AUTH, mirrors requireAdmin in routes/admin.js (kept local so this file
// is self-contained). If the rule changes there, change it here too.
// ----------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized as platform admin' });
    }
    req.admin = decoded;
    next();
  } catch (error) {
    console.error('Broadcast admin auth error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

const str = (v, max) => (v == null ? '' : String(v)).trim().slice(0, max || 2000);

// Build the SMS text when the admin didn't type a custom one: title, body, link.
function composeSmsBody({ title, body, link_url }) {
  const parts = [];
  if (title) parts.push(str(title, 120));
  if (body) parts.push(str(body, 400));
  if (link_url) parts.push(str(link_url, 300));
  return parts.join('\n').trim();
}

// ============================================================================
// ADMIN ROUTER
// ============================================================================
const adminRouter = express.Router();

// POST /api/admin/broadcasts  (create a broadcast + optional mass SMS)
// Body: { title, body, link_url, link_label, show_on_dashboard,
//         duration_hours, send_sms, sms_body }
adminRouter.post('/broadcasts', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const showOnDashboard = b.show_on_dashboard !== false;
    const sendSms = b.send_sms === true;

    const title = str(b.title, 140);
    const body = str(b.body, 1000);
    const linkUrl = str(b.link_url, 500);
    const linkLabel = str(b.link_label, 60);

    if (!showOnDashboard && !sendSms) {
      return res.status(400).json({ error: 'Pick at least one channel: dashboard banner or SMS.' });
    }
    if (showOnDashboard && !title && !body) {
      return res.status(400).json({ error: 'A dashboard banner needs a title or a message.' });
    }

    // Timer: duration in hours from now; 0 / blank = no expiry (shows until dismissed or removed).
    let expiresAt = null;
    const hours = Number(b.duration_hours);
    if (showOnDashboard && Number.isFinite(hours) && hours > 0) {
      expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    }

    const row = {
      title: title || null,
      body: body || null,
      link_url: linkUrl || null,
      link_label: linkLabel || null,
      show_on_dashboard: showOnDashboard,
      expires_at: expiresAt,
      sms_sent: false,
      sms_recipients: null,
      created_by: (req.admin && (req.admin.email || req.admin.sub)) || 'admin',
    };

    const { data: created, error } = await supabase
      .from('platform_broadcasts')
      .insert([row])
      .select()
      .single();

    if (error) {
      console.error('Broadcast insert failed:', error);
      return res.status(500).json({ error: 'Could not save the broadcast.' });
    }

    // Mass SMS to every agency owner, from the platform number.
    let smsResult = null;
    if (sendSms) {
      const smsText = str(b.sms_body, 1000) || composeSmsBody({ title, body, link_url: linkUrl });
      if (!smsText) {
        smsResult = { sent: 0, failed: 0, skipped: 0, note: 'No SMS text to send.' };
      } else if (!sendAndLogSMS) {
        smsResult = { sent: 0, failed: 0, skipped: 0, note: 'SMS sender unavailable.' };
      } else {
        smsResult = await sendBroadcastSms(created.id, smsText);
        await supabase
          .from('platform_broadcasts')
          .update({ sms_sent: true, sms_recipients: smsResult.sent })
          .eq('id', created.id);
        created.sms_sent = true;
        created.sms_recipients = smsResult.sent;
      }
    }

    res.json({ success: true, broadcast: created, sms: smsResult });
  } catch (e) {
    console.error('Create broadcast error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send the SMS to every agency that has a phone number. Batched so a large
// roster does not fire hundreds of requests at once. Best-effort per agency.
async function sendBroadcastSms(broadcastId, message) {
  const { data: agencies } = await supabase
    .from('agencies')
    .select('id, phone, country')
    .not('phone', 'is', null);

  const list = (agencies || []).filter(a => a.phone && String(a.phone).trim());
  let sent = 0, failed = 0;
  const skipped = (agencies || []).length - list.length;

  const BATCH = 10;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(a => sendAndLogSMS({
      phone: a.phone,
      message,
      agencyId: a.id,
      recipientType: 'agency_owner',
      messageType: 'agency_broadcast',
      metadata: { broadcastId },
    })));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== false) sent++;
      else failed++;
    }
  }
  console.log(`📣 Broadcast ${broadcastId} SMS: ${sent} sent, ${failed} failed, ${skipped} without a phone`);
  return { sent, failed, skipped };
}

// GET /api/admin/broadcasts  (recent broadcasts, history)
adminRouter.get('/broadcasts', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('platform_broadcasts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: 'Could not load broadcasts.' });
    res.json({ success: true, broadcasts: data || [] });
  } catch (e) {
    console.error('List broadcasts error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/broadcasts/:id  (remove a broadcast, pulls the banner now)
adminRouter.delete('/broadcasts/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('platform_broadcasts').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Could not remove the broadcast.' });
    res.json({ success: true });
  } catch (e) {
    console.error('Delete broadcast error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// AGENCY ROUTER
// ============================================================================
const agencyRouter = express.Router();

// GET /api/agency/:agencyId/broadcast  (the banner this agency should see now,
// or null. The latest non-expired dashboard broadcast, unless this agency has
// already dismissed it.
agencyRouter.get('/:agencyId/broadcast', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const nowIso = new Date().toISOString();

    const { data: rows } = await supabase
      .from('platform_broadcasts')
      .select('id, title, body, link_url, link_label, expires_at, created_at')
      .eq('show_on_dashboard', true)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('created_at', { ascending: false })
      .limit(1);

    const latest = rows && rows[0];
    if (!latest) return res.json({ success: true, broadcast: null });

    const { data: agency } = await supabase
      .from('agencies')
      .select('dismissed_broadcast_id')
      .eq('id', agencyId)
      .single();

    if (agency && agency.dismissed_broadcast_id === latest.id) {
      return res.json({ success: true, broadcast: null });
    }
    res.json({ success: true, broadcast: latest });
  } catch (e) {
    console.error('Get active broadcast error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/agency/:agencyId/broadcast/dismiss  { id }
agencyRouter.post('/:agencyId/broadcast/dismiss', requireAgencyAccess('dashboard'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase
      .from('agencies')
      .update({ dismissed_broadcast_id: id })
      .eq('id', agencyId);
    if (error) return res.status(500).json({ error: 'Could not dismiss.' });
    res.json({ success: true });
  } catch (e) {
    console.error('Dismiss broadcast error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { adminRouter, agencyRouter };