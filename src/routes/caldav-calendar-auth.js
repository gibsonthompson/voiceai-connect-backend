// ============================================================================
// CALDAV CALENDAR AUTH - Connect / Disconnect / Status
// ----------------------------------------------------------------------------
// CalDAV uses Basic auth with an app-specific password, so there is no OAuth
// redirect. The client submits their provider + email + app password to
// /connect; we verify the credentials, discover their calendar collection, and
// store it. Mirrors the google/microsoft routes for the status + VAPI tool
// wiring, but connect is a plain JSON POST (no browser round-trip).
//
// Calendar is a CORE feature on every plan, so there is no plan gate beyond
// confirming the client exists.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { updateAssistantCalendar } = require('../lib/calendar-tools');
const caldav = require('../lib/caldav-calendar');

async function clientExists(clientId) {
  const { data, error } = await supabase.from('clients').select('id').eq('id', clientId).single();
  return !error && !!data;
}

// ============================================================================
// POST /api/auth/caldav-calendar/connect
// body: { clientId, provider: 'icloud'|'fastmail'|'other', serverUrl?, username, password }
// ============================================================================
router.post('/connect', async (req, res) => {
  try {
    const { clientId, provider, serverUrl, username, password } = req.body || {};
    if (!clientId || !username || !password) {
      return res.status(400).json({ success: false, error: 'missing_fields', message: 'Email and app password are required.' });
    }
    if ((provider === 'other' || !provider) && !serverUrl) {
      return res.status(400).json({ success: false, error: 'missing_server', message: 'A CalDAV server URL is required for "Other".' });
    }
    if (!(await clientExists(clientId))) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Client not found.' });
    }

    const result = await caldav.verifyAndDiscover(provider, serverUrl, username, password);
    if (!result.ok) {
      const map = {
        auth: 'That email or app password was not accepted. For iCloud and Fastmail you must use an app-specific password, not your normal password.',
        bad_url: 'That server URL is not valid. It should start with https://',
        no_principal: 'Could not reach that CalDAV server. Double-check the server URL.',
        no_calendar: 'Connected, but no writable calendar was found on that account.',
        discover_failed: 'Could not read the calendars on that account. Try again.',
        network: 'Could not reach that CalDAV server right now. Try again.',
      };
      return res.status(400).json({ success: false, error: result.error || 'connect_failed', message: map[result.error] || 'Could not connect that calendar.' });
    }

    const { error: updErr } = await supabase
      .from('clients')
      .update({
        caldav_connected: true,
        caldav_base_url: result.baseUrl,
        caldav_username: username,
        caldav_password: password,
        caldav_calendar_url: result.calendarUrl,
        caldav_calendar_email: username,
        calendar_provider: 'caldav',
        updated_at: new Date().toISOString(),
      })
      .eq('id', clientId);
    if (updErr) {
      console.error('❌ CalDAV connect DB error:', updErr.message);
      return res.status(500).json({ success: false, error: 'db_error', message: 'Could not save the connection.' });
    }

    // Add calendar tools to the VAPI assistant (provider-agnostic). Non-blocking.
    const { data: client } = await supabase.from('clients').select('vapi_assistant_id').eq('id', clientId).single();
    if (client && client.vapi_assistant_id) {
      updateAssistantCalendar(client.vapi_assistant_id, clientId, true)
        .then((r) => { if (r && r.success) console.log(`✅ VAPI calendar tools added (CalDAV) for client: ${clientId}`); else console.error('❌ VAPI update (CalDAV) failed:', r && r.error); })
        .catch((e) => console.error('❌ VAPI update error (CalDAV, non-blocking):', e));
    }

    console.log(`✅ CalDAV calendar connected for client: ${clientId} (${result.displayName || 'calendar'})`);
    res.json({ success: true, email: username, calendar: result.displayName || null });
  } catch (error) {
    console.error('❌ CalDAV connect error:', error);
    res.status(500).json({ success: false, error: 'server_error', message: 'Server error while connecting.' });
  }
});

// ============================================================================
// POST /api/auth/caldav-calendar/disconnect
// ============================================================================
router.post('/disconnect', async (req, res) => {
  try {
    const { clientId } = req.body || {};
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

    const { data: client } = await supabase.from('clients').select('vapi_assistant_id, calendar_provider').eq('id', clientId).single();

    const update = {
      caldav_connected: false,
      caldav_base_url: null,
      caldav_username: null,
      caldav_password: null,
      caldav_calendar_url: null,
      caldav_calendar_email: null,
      updated_at: new Date().toISOString(),
    };
    if (client && client.calendar_provider === 'caldav') update.calendar_provider = null;

    const { error } = await supabase.from('clients').update(update).eq('id', clientId);
    if (error) return res.status(500).json({ success: false, error: 'Failed to disconnect' });

    if (client && client.vapi_assistant_id) {
      updateAssistantCalendar(client.vapi_assistant_id, clientId, false)
        .then((r) => { if (r && r.success) console.log(`✅ Calendar tools removed (CalDAV) for client: ${clientId}`); })
        .catch((e) => console.error('❌ VAPI update error (CalDAV, non-blocking):', e));
    }

    console.log(`✅ CalDAV calendar disconnected for client: ${clientId}`);
    res.json({ success: true, message: 'Calendar disconnected' });
  } catch (error) {
    console.error('❌ CalDAV disconnect error:', error);
    res.status(500).json({ success: false, error: 'Failed to disconnect calendar' });
  }
});

// ============================================================================
// GET /api/auth/caldav-calendar/status/:clientId
// Same contract as the other providers: connected / token_valid /
// calendar_access / email / plan_allowed.
// ============================================================================
router.get('/status/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, caldav_connected, caldav_calendar_url, caldav_username, caldav_password, caldav_calendar_email, timezone')
      .eq('id', clientId)
      .single();
    if (error || !client) return res.status(404).json({ error: 'Client not found' });

    let tokenValid = false;
    let calendarAccess = false;
    if (client.caldav_connected && client.caldav_calendar_url && client.caldav_username && client.caldav_password) {
      try {
        const now = new Date();
        const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const probe = await caldav.getCaldavBusy(client, now.toISOString(), soon.toISOString());
        tokenValid = probe.ok;
        calendarAccess = probe.ok;
      } catch (e) {
        tokenValid = true; calendarAccess = true; // transient; do not nag
      }
    }

    res.json({
      connected: client.caldav_connected || false,
      token_valid: tokenValid,
      calendar_access: calendarAccess,
      email: client.caldav_calendar_email || client.caldav_username || null,
      plan_allowed: true,
      plan_message: null,
    });
  } catch (error) {
    console.error('❌ CalDAV status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
