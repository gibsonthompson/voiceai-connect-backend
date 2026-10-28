// ============================================================================
// GOHIGHLEVEL (HighLevel) AUTH - OAuth Connect / Callback / Disconnect / Status
//
// Mirrors google-calendar-auth.js. Connects a client's GHL sub-account via the
// Marketplace OAuth app, stores the LOCATION token set on the client row, and
// picks a default calendar. After this, the appointment API books into GHL for
// any client whose calendar_provider is 'ghl'. Credentials (client id/secret)
// live in env (GHL_CLIENT_ID / GHL_CLIENT_SECRET); only per-client OAuth tokens
// are stored, same pattern as the Google integration.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const {
  buildAuthorizeUrl, exchangeCodeForTokens, getValidAccessToken, listCalendars,
} = require('../lib/ghl-calendar');

const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://myvoiceaiconnect.com';
const REDIRECT_URI = `${BACKEND_URL}/api/auth/ghl/callback`;

// Only ever bounce the client back to a platform host (white-label subdomain or
// the apex). Never an open redirect.
function isPlatformHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'myvoiceaiconnect.com' || h.endsWith('.myvoiceaiconnect.com');
}
function safeBase(returnTo) {
  try {
    const u = new URL(returnTo);
    if (u.protocol === 'https:' && isPlatformHost(u.host)) return `${u.protocol}//${u.host}`;
  } catch (e) { /* fall through */ }
  return FRONTEND_URL;
}

// GET /api/auth/ghl/connect?clientId=...&return=...
router.get('/connect', async (req, res) => {
  try {
    const clientId = req.query.clientId;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    if (!process.env.GHL_CLIENT_ID || !process.env.GHL_CLIENT_SECRET) {
      console.error('GHL not configured (GHL_CLIENT_ID / GHL_CLIENT_SECRET missing)');
      return res.status(500).json({ error: 'GoHighLevel is not configured' });
    }
    const { data: client } = await supabase.from('clients').select('id').eq('id', clientId).single();
    if (!client) return res.redirect(`${FRONTEND_URL}/client/settings?error=client_not_found`);

    const returnTo = req.query.return || req.headers.referer || '';
    const state = Buffer.from(JSON.stringify({ clientId, returnTo })).toString('base64url');
    return res.redirect(buildAuthorizeUrl(REDIRECT_URI, state));
  } catch (err) {
    console.error('GHL connect error:', err.message);
    return res.status(500).json({ error: 'Failed to start GoHighLevel connection' });
  }
});

// GET /api/auth/ghl/callback?code=...&state=...
router.get('/callback', async (req, res) => {
  let redirectBase = FRONTEND_URL;
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect(`${redirectBase}/client/settings?error=ghl_denied`);
    if (!code || !state) return res.redirect(`${redirectBase}/client/settings?error=ghl_failed`);

    let clientId, returnTo;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
      clientId = decoded.clientId;
      returnTo = decoded.returnTo;
    } catch (e) {
      return res.redirect(`${redirectBase}/client/settings?error=ghl_failed`);
    }
    redirectBase = safeBase(returnTo);
    if (!clientId) return res.redirect(`${redirectBase}/client/settings?error=ghl_failed`);

    let tokens;
    try {
      tokens = await exchangeCodeForTokens(code, REDIRECT_URI);
    } catch (e) {
      console.error('GHL token exchange failed:', e.message);
      return res.redirect(`${redirectBase}/client/settings?error=ghl_token_failed`);
    }

    const locationId = tokens.locationId || null;
    const expiresAt = new Date(Date.now() + (Number(tokens.expires_in) || 86400) * 1000).toISOString();

    // Pick a default calendar for the location (first active one). A picker can
    // refine this later; booking needs a calendarId to target.
    let calendarId = null;
    if (locationId && tokens.access_token) {
      try {
        const { calendars } = await listCalendars(tokens.access_token, locationId);
        const active = (calendars || []).find((c) => c.isActive !== false) || (calendars || [])[0];
        calendarId = active ? (active.id || active.calendarId) : null;
      } catch (e) { /* leave null; status will flag no-calendar */ }
    }

    const { error: updErr } = await supabase.from('clients').update({
      calendar_provider: 'ghl',
      ghl_connected: true,
      ghl_access_token: tokens.access_token,
      ghl_refresh_token: tokens.refresh_token || null,
      ghl_token_expires_at: expiresAt,
      ghl_location_id: locationId,
      ghl_company_id: tokens.companyId || null,
      ghl_calendar_id: calendarId,
      ghl_user_type: tokens.userType || 'Location',
      updated_at: new Date().toISOString(),
    }).eq('id', clientId);
    if (updErr) {
      console.error('GHL callback DB update error:', updErr.message);
      return res.redirect(`${redirectBase}/client/settings?error=ghl_db_error`);
    }

    return res.redirect(`${redirectBase}/client/settings?success=ghl_connected`);
  } catch (err) {
    console.error('GHL callback error:', err.message);
    return res.redirect(`${redirectBase}/client/settings?error=ghl_unknown`);
  }
});

// POST /api/auth/ghl/disconnect  { clientId }
router.post('/disconnect', async (req, res) => {
  try {
    const { clientId } = req.body || {};
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    const { data: client } = await supabase.from('clients').select('calendar_provider').eq('id', clientId).single();
    const updates = {
      ghl_connected: false,
      ghl_access_token: null,
      ghl_refresh_token: null,
      ghl_token_expires_at: null,
      ghl_location_id: null,
      ghl_company_id: null,
      ghl_calendar_id: null,
      ghl_user_type: null,
      updated_at: new Date().toISOString(),
    };
    // Only clear the provider if GHL was the selected one, so we don't stomp a
    // client who also has Google set.
    if (client && client.calendar_provider === 'ghl') updates.calendar_provider = null;
    const { error } = await supabase.from('clients').update(updates).eq('id', clientId);
    if (error) return res.status(500).json({ error: 'Failed to disconnect' });
    return res.json({ success: true, message: 'GoHighLevel disconnected' });
  } catch (err) {
    console.error('GHL disconnect error:', err.message);
    return res.status(500).json({ error: 'Failed to disconnect GoHighLevel' });
  }
});

// GET /api/auth/ghl/status/:clientId
router.get('/status/:clientId', async (req, res) => {
  try {
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, calendar_provider, ghl_connected, ghl_access_token, ghl_refresh_token, ghl_token_expires_at, ghl_location_id, ghl_calendar_id')
      .eq('id', req.params.clientId).single();
    if (error || !client) return res.status(404).json({ error: 'Client not found' });

    let tokenValid = false;
    let calendars = [];
    if (client.ghl_connected && client.ghl_refresh_token) {
      try {
        const token = await getValidAccessToken(client);
        tokenValid = !!token;
        if (token && client.ghl_location_id) {
          const r = await listCalendars(token, client.ghl_location_id);
          calendars = (r.calendars || []).map((c) => ({ id: c.id || c.calendarId, name: c.name || null }));
        }
      } catch (e) { tokenValid = true; /* transient, do not nag */ }
    }

    return res.json({
      connected: client.ghl_connected || false,
      provider: client.calendar_provider || null,
      token_valid: tokenValid,
      location_id: client.ghl_location_id || null,
      calendar_id: client.ghl_calendar_id || null,
      calendars,
      needs_calendar: !!(client.ghl_connected && !client.ghl_calendar_id),
    });
  } catch (err) {
    console.error('GHL status error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/auth/ghl/calendar  { clientId, calendarId }  (set which GHL calendar to book into).
router.patch('/calendar', async (req, res) => {
  try {
    const { clientId, calendarId } = req.body || {};
    if (!clientId || !calendarId) return res.status(400).json({ error: 'clientId and calendarId are required' });
    const { data: client } = await supabase.from('clients').select('id, ghl_connected').eq('id', clientId).single();
    if (!client || !client.ghl_connected) return res.status(404).json({ error: 'No connected GoHighLevel account for this client' });
    const { error } = await supabase.from('clients').update({ ghl_calendar_id: calendarId, updated_at: new Date().toISOString() }).eq('id', clientId);
    if (error) return res.status(500).json({ error: 'Failed to set calendar' });
    return res.json({ success: true, calendar_id: calendarId });
  } catch (err) {
    console.error('GHL set-calendar error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
