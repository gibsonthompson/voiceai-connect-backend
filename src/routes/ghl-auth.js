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
// Neutral, white-label-safe OAuth path (no brand name in the customer-visible
// redirect URI). The Marketplace app's registered redirect URL must match this
// exactly: <BACKEND_URL>/api/auth/crm-calendar/callback.
const REDIRECT_URI = `${BACKEND_URL}/api/auth/crm-calendar/callback`;

// After OAuth, send the client back to the SAME origin/page they started on so
// their origin-scoped session (localStorage) survives and they are not logged
// out. The initiating page passes its origin+path as ?return=, we carry it
// through the OAuth state and validate it here before trusting it, so this can
// never become an open redirect. Mirrors google-calendar-auth.js.
function allowedReturnHosts(agency) {
  const hosts = new Set(['myvoiceaiconnect.com', 'www.myvoiceaiconnect.com']);
  if (agency && agency.slug) hosts.add(`${agency.slug}.myvoiceaiconnect.com`);
  if (agency && agency.marketing_domain) {
    const md = String(agency.marketing_domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    const bare = md.replace(/^www\./, '');
    if (bare) { hosts.add(bare); hosts.add(`www.${bare}`); }
  }
  return hosts;
}
// True for any subdomain of the platform domain (we provision every agency
// slug), so returning the client to one can never be an open redirect.
function isPlatformHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'myvoiceaiconnect.com' || h.endsWith('.myvoiceaiconnect.com');
}
// Host-only base for error fallbacks: keep the client on the branded origin they
// came from (a platform subdomain), never the bare apex. Never an open redirect.
function safeBase(returnTo) {
  try {
    const u = new URL(returnTo);
    if (u.protocol === 'https:' && isPlatformHost(u.host)) return `${u.protocol}//${u.host}`;
  } catch (e) { /* fall through */ }
  return FRONTEND_URL;
}
// Full origin+path return for the success redirect, constrained to client / cc
// pages on a trusted host. Returns null when the return value cannot be trusted,
// so the caller falls back to the settings page on the branded origin.
function safeReturnUrl(returnTo, agency) {
  if (!returnTo) return null;
  let u;
  try { u = new URL(returnTo); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.host.toLowerCase();
  if (!isPlatformHost(host) && !allowedReturnHosts(agency).has(host)) return null;
  const path = (u.pathname && (u.pathname.startsWith('/client') || u.pathname.startsWith('/cc'))) ? u.pathname : '/client/ai-agent';
  return `${u.protocol}//${u.host}${path}`;
}

// GET /api/auth/crm-calendar/connect?clientId=...&return=...
router.get('/connect', async (req, res) => {
  try {
    const clientId = req.query.clientId;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    if (!process.env.GHL_CLIENT_ID || !process.env.GHL_CLIENT_SECRET) {
      console.error('GHL not configured (GHL_CLIENT_ID / GHL_CLIENT_SECRET missing)');
      return res.status(500).json({ error: 'Calendar sync is not configured' });
    }
    const { data: client } = await supabase.from('clients').select('id').eq('id', clientId).single();
    if (!client) return res.redirect(`${FRONTEND_URL}/client/settings?error=client_not_found`);

    const returnTo = req.query.return || req.headers.referer || '';
    const state = Buffer.from(JSON.stringify({ clientId, returnTo })).toString('base64url');
    return res.redirect(buildAuthorizeUrl(REDIRECT_URI, state));
  } catch (err) {
    console.error('GHL connect error:', err.message);
    return res.status(500).json({ error: 'Failed to start the calendar connection' });
  }
});

// GET /api/auth/crm-calendar/callback?code=...&state=...
router.get('/callback', async (req, res) => {
  let redirectBase = FRONTEND_URL;
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect(`${redirectBase}/client/settings?error=crm_denied`);
    if (!code || !state) return res.redirect(`${redirectBase}/client/settings?error=crm_failed`);

    let clientId, returnTo;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
      clientId = decoded.clientId;
      returnTo = decoded.returnTo;
    } catch (e) {
      return res.redirect(`${redirectBase}/client/settings?error=crm_failed`);
    }
    redirectBase = safeBase(returnTo);
    if (!clientId) return res.redirect(`${redirectBase}/client/settings?error=crm_failed`);

    let tokens;
    try {
      tokens = await exchangeCodeForTokens(code, REDIRECT_URI);
    } catch (e) {
      console.error('GHL token exchange failed:', e.message);
      return res.redirect(`${redirectBase}/client/settings?error=crm_token_failed`);
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
      ghl_user_id: tokens.userId || null,
      updated_at: new Date().toISOString(),
    }).eq('id', clientId);
    if (updErr) {
      console.error('GHL callback DB update error:', updErr.message);
      return res.redirect(`${redirectBase}/client/settings?error=crm_db_error`);
    }

    // Return the client to the EXACT origin/page they started on (mirrors the
    // Google flow) so their origin-scoped session survives; fall back to the
    // settings page on the branded origin if the return value is untrusted.
    let agency = null;
    try {
      const { data: c2 } = await supabase
        .from('clients')
        .select('agency_id, agencies(slug, marketing_domain, domain_verified)')
        .eq('id', clientId).single();
      agency = c2 ? c2.agencies : null;
    } catch (e) { /* non-fatal: fall back to redirectBase */ }
    const safeReturn = safeReturnUrl(returnTo, agency);
    return res.redirect(`${safeReturn || `${redirectBase}/client/settings`}?success=crm_connected`);
  } catch (err) {
    console.error('GHL callback error:', err.message);
    return res.redirect(`${redirectBase}/client/settings?error=crm_unknown`);
  }
});

// POST /api/auth/crm-calendar/disconnect  { clientId }
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
      ghl_user_id: null,
      updated_at: new Date().toISOString(),
    };
    // Only clear the provider if GHL was the selected one, so we don't stomp a
    // client who also has Google set.
    if (client && client.calendar_provider === 'ghl') updates.calendar_provider = null;
    const { error } = await supabase.from('clients').update(updates).eq('id', clientId);
    if (error) return res.status(500).json({ error: 'Failed to disconnect' });
    return res.json({ success: true, message: 'Calendar disconnected' });
  } catch (err) {
    console.error('GHL disconnect error:', err.message);
    return res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// GET /api/auth/crm-calendar/status/:clientId
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

// PATCH /api/auth/crm-calendar/calendar  { clientId, calendarId }  (set which calendar to book into).
router.patch('/calendar', async (req, res) => {
  try {
    const { clientId, calendarId } = req.body || {};
    if (!clientId || !calendarId) return res.status(400).json({ error: 'clientId and calendarId are required' });
    const { data: client } = await supabase.from('clients').select('id, ghl_connected').eq('id', clientId).single();
    if (!client || !client.ghl_connected) return res.status(404).json({ error: 'No connected calendar account for this client' });
    const { error } = await supabase.from('clients').update({ ghl_calendar_id: calendarId, updated_at: new Date().toISOString() }).eq('id', clientId);
    if (error) return res.status(500).json({ error: 'Failed to set calendar' });
    return res.json({ success: true, calendar_id: calendarId });
  } catch (err) {
    console.error('GHL set-calendar error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
