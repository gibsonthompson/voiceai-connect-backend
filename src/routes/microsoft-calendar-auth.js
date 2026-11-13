// ============================================================================
// MICROSOFT 365 / OUTLOOK CALENDAR AUTH - OAuth Connect/Disconnect/Callback
// ----------------------------------------------------------------------------
// The Microsoft counterpart to google-calendar-auth.js. Same flow, same branded-
// origin return handling, same VAPI tool wiring; only the provider endpoints and
// the microsoft_* client columns differ.
//
// Calendar is a CORE feature on every plan, so there is no plan gate beyond
// confirming the client exists (identical to the Google route).
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { updateAssistantCalendar } = require('../lib/calendar-tools');
const mscal = require('../lib/microsoft-calendar');

const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://myvoiceaiconnect.com';

const REDIRECT_URI = `${BACKEND_URL}/api/auth/microsoft-calendar/callback`;

// Pull the connected account's email from the id_token (a JWT from Microsoft's
// token endpoint over TLS, so no signature check needed). Personal accounts put
// it in preferred_username; work accounts in email. Falls back to Graph /me via
// mscal.getUserEmail. Non-blocking: null just omits the email on the card.
function emailFromIdToken(idToken) {
  try {
    const payload = String(idToken).split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return json.email || json.preferred_username || null;
  } catch (e) {
    return null;
  }
}

async function fetchMicrosoftEmail(tokens) {
  const fromId = tokens && tokens.id_token ? emailFromIdToken(tokens.id_token) : null;
  if (fromId) return fromId;
  if (!tokens || !tokens.access_token) return null;
  return mscal.getUserEmail(tokens.access_token);
}

// ── Branded-origin return handling (identical policy to the Google route) ────
// Send the client back to the SAME origin they started on so their origin-scoped
// session (localStorage) survives. The origin is carried through OAuth state and
// validated against the agency's own hosts, so this can never be an open redirect.
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

function isPlatformHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'myvoiceaiconnect.com' || h.endsWith('.myvoiceaiconnect.com');
}

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

// Calendar is core on every plan; only confirm the client exists.
async function checkPlanAccess(clientId) {
  try {
    const { data: client, error } = await supabase
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .single();
    if (error || !client) return { allowed: false, reason: 'Client not found' };
    return { allowed: true };
  } catch (err) {
    console.error('❌ Plan check error:', err);
    return { allowed: false, reason: 'Failed to check plan access' };
  }
}

// ============================================================================
// GET /api/auth/microsoft-calendar/connect
// ============================================================================
router.get('/connect', async (req, res) => {
  try {
    const clientId = req.query.clientId;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    if (!mscal.isConfigured()) {
      console.error('❌ Microsoft Calendar credentials not configured');
      return res.status(500).json({ error: 'Microsoft Calendar not configured' });
    }

    const planCheck = await checkPlanAccess(clientId);
    if (!planCheck.allowed) {
      console.log(`🚫 Calendar access denied for client ${clientId}: ${planCheck.reason}`);
      return res.redirect(`${FRONTEND_URL}/client/settings?error=plan_upgrade_required`);
    }

    const returnTo = req.query.return || req.headers.referer || '';
    const state = Buffer.from(JSON.stringify({ clientId, returnTo })).toString('base64url');

    const authUrl = new URL(mscal.AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', process.env.MICROSOFT_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('scope', mscal.MS_SCOPES);
    // Force the consent screen so a reconnect always re-grants Calendars.ReadWrite
    // and offline_access (a refresh token), instead of silently reusing a prior
    // partial grant.
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    console.log(`📅 Microsoft Calendar OAuth initiated for client: ${clientId}`);
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error('❌ Microsoft Calendar OAuth initiation error:', error);
    res.status(500).json({ error: 'Failed to initiate calendar connection' });
  }
});

// ============================================================================
// GET /api/auth/microsoft-calendar/callback
// ============================================================================
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    let redirectBase = FRONTEND_URL;

    if (oauthError) {
      console.error('❌ OAuth error from Microsoft:', oauthError);
      return res.redirect(`${redirectBase}/client/settings?error=calendar_denied`);
    }
    if (!code || !state) {
      return res.redirect(`${redirectBase}/client/settings?error=calendar_failed`);
    }

    let clientId, returnTo;
    try {
      const stateDecoded = JSON.parse(Buffer.from(state, 'base64url').toString());
      clientId = stateDecoded.clientId;
      returnTo = stateDecoded.returnTo;
    } catch (e) {
      console.error('❌ Failed to decode state:', e);
      return res.redirect(`${redirectBase}/client/settings?error=calendar_failed`);
    }

    // Keep every redirect from here on the branded origin the client came from.
    try {
      const ru = new URL(returnTo);
      if (ru.protocol === 'https:' && isPlatformHost(ru.host)) {
        redirectBase = `${ru.protocol}//${ru.host}`;
      }
    } catch (e) { /* keep default */ }

    if (!clientId) {
      return res.redirect(`${redirectBase}/client/settings?error=calendar_failed`);
    }

    const tokens = await mscal.exchangeCode(code, REDIRECT_URI);
    if (!tokens || !tokens.access_token) {
      console.error('❌ Microsoft token exchange returned no tokens');
      return res.redirect(`${redirectBase}/client/settings?error=calendar_token_failed`);
    }

    // Granular consent: the user can grant sign-in while leaving Calendars.ReadWrite
    // unchecked. If they did, auto-booking would silently fail while the card showed
    // "connected". Reject it and send them back to reconnect. Microsoft returns the
    // granted scopes either short ("Calendars.ReadWrite") or fully-qualified
    // ("https://graph.microsoft.com/Calendars.ReadWrite"), so match case-insensitively.
    const grantedScopes = String(tokens.scope || '');
    if (!/calendars\.readwrite/i.test(grantedScopes)) {
      console.warn(`⚠️ Calendar scope not granted for client ${clientId}; not marking connected.`);
      const back = safeReturnUrl(returnTo, null);
      return res.redirect(`${back || `${redirectBase}/client/settings`}?error=calendar_scope_missing`);
    }

    // offline_access should yield a refresh token; without one, bookings would
    // stop working in an hour when the access token expires. Treat its absence as
    // a failed connect so the client re-grants instead of silently degrading.
    if (!tokens.refresh_token) {
      console.warn(`⚠️ No Microsoft refresh token for client ${clientId}; not marking connected.`);
      const back = safeReturnUrl(returnTo, null);
      return res.redirect(`${back || `${redirectBase}/client/settings`}?error=calendar_scope_missing`);
    }

    const expiresAt = new Date(Date.now() + ((tokens.expires_in || 3600) * 1000)).toISOString();
    console.log('✅ Microsoft Calendar tokens received for client:', clientId);

    const microsoftEmail = await fetchMicrosoftEmail(tokens);

    const { error: updateError } = await supabase
      .from('clients')
      .update({
        microsoft_calendar_connected: true,
        microsoft_access_token: tokens.access_token,
        microsoft_refresh_token: tokens.refresh_token,
        microsoft_token_expires_at: expiresAt,
        microsoft_calendar_email: microsoftEmail,
        // Switch routing to Microsoft. Booking/availability key off this.
        calendar_provider: 'microsoft',
        updated_at: new Date().toISOString(),
      })
      .eq('id', clientId);

    if (updateError) {
      console.error('❌ Database update error:', updateError);
      return res.redirect(`${redirectBase}/client/settings?error=calendar_db_error`);
    }

    const { data: client } = await supabase
      .from('clients')
      .select('vapi_assistant_id, agency_id, agencies(slug, marketing_domain, domain_verified)')
      .eq('id', clientId)
      .single();

    // Add calendar tools to the VAPI assistant (provider-agnostic; the tools call
    // the booking engine, which routes to Microsoft). Non-blocking.
    if (client?.vapi_assistant_id) {
      updateAssistantCalendar(client.vapi_assistant_id, clientId, true)
        .then(result => {
          if (result.success) console.log(`✅ VAPI assistant updated with calendar tools for client: ${clientId}`);
          else console.error(`❌ Failed to update VAPI assistant:`, result.error);
        })
        .catch(err => console.error('❌ VAPI update error (non-blocking):', err));
    } else {
      console.warn(`⚠️ No VAPI assistant found for client ${clientId} - calendar tools not added`);
    }

    const safeReturn = safeReturnUrl(returnTo, client?.agencies);
    if (safeReturn) {
      console.log(`✅ Microsoft Calendar connected for client: ${clientId} (returning to ${safeReturn})`);
      return res.redirect(`${safeReturn}?success=calendar_connected`);
    }

    if (client?.agencies?.slug) {
      redirectBase = `https://${client.agencies.slug}.myvoiceaiconnect.com`;
    }

    console.log(`✅ Microsoft Calendar connected for client: ${clientId}`);
    res.redirect(`${redirectBase}/client/settings?success=calendar_connected`);
  } catch (error) {
    console.error('❌ Microsoft Calendar callback error:', error);
    res.redirect(`${FRONTEND_URL}/client/settings?error=calendar_unknown`);
  }
});

// ============================================================================
// POST /api/auth/microsoft-calendar/disconnect
// ============================================================================
router.post('/disconnect', async (req, res) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const { data: client } = await supabase
      .from('clients')
      .select('vapi_assistant_id, calendar_provider')
      .eq('id', clientId)
      .single();

    // Microsoft Graph has no simple token-revoke endpoint (a user removes app
    // consent from their account's app permissions). Dropping the stored tokens
    // severs our access, and prompt=consent on the next connect re-grants cleanly.
    const update = {
      microsoft_calendar_connected: false,
      microsoft_access_token: null,
      microsoft_refresh_token: null,
      microsoft_token_expires_at: null,
      microsoft_calendar_email: null,
      updated_at: new Date().toISOString(),
    };
    // Only clear the routing flag if Microsoft was the selected provider, so we
    // never stomp a client who had switched to another calendar.
    if (client && client.calendar_provider === 'microsoft') update.calendar_provider = null;

    const { error: updateError } = await supabase
      .from('clients')
      .update(update)
      .eq('id', clientId);

    if (updateError) {
      console.error('❌ DB update error:', updateError);
      return res.status(500).json({ error: 'Failed to disconnect' });
    }

    if (client?.vapi_assistant_id) {
      updateAssistantCalendar(client.vapi_assistant_id, clientId, false)
        .then(result => { if (result.success) console.log(`✅ Calendar tools removed from VAPI assistant for client: ${clientId}`); })
        .catch(err => console.error('❌ VAPI update error (non-blocking):', err));
    }

    console.log(`✅ Microsoft Calendar disconnected for client: ${clientId}`);
    res.json({ success: true, message: 'Calendar disconnected' });
  } catch (error) {
    console.error('❌ Microsoft Calendar disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

// ============================================================================
// GET /api/auth/microsoft-calendar/status/:clientId
// Same contract as the Google status route: connected / token_valid /
// calendar_access / email / plan_allowed.
// ============================================================================
router.get('/status/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('id, microsoft_calendar_connected, microsoft_access_token, microsoft_refresh_token, microsoft_token_expires_at, microsoft_calendar_email')
      .eq('id', clientId)
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client not found' });

    const planCheck = await checkPlanAccess(clientId);

    // A healthy connection means a usable refresh token. Access tokens expire
    // hourly by design and the booking path mints fresh ones on demand, so we
    // confirm the refresh token works rather than checking access-token freshness.
    let tokenValid = false;
    let calendarAccess = false;
    if (client.microsoft_calendar_connected && client.microsoft_refresh_token) {
      try {
        const freshToken = await mscal.refreshMicrosoftToken(client);
        tokenValid = !!freshToken;
        if (freshToken) {
          try {
            const now = new Date();
            const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const probe = await fetch(
              'https://graph.microsoft.com/v1.0/me/calendarView?' + new URLSearchParams({
                startDateTime: now.toISOString(),
                endDateTime: soon.toISOString(),
                $top: '1',
              }),
              { headers: { Authorization: `Bearer ${freshToken}`, Prefer: 'outlook.timezone="UTC"' } }
            );
            calendarAccess = probe.ok;
          } catch (e) { calendarAccess = false; }
        }
      } catch (e) {
        console.warn(`Calendar status: live token check failed for ${clientId}, treating connection as valid (refresh token present):`, e.message);
        tokenValid = true;
        calendarAccess = true;
      }
    }

    res.json({
      connected: client.microsoft_calendar_connected || false,
      token_valid: tokenValid,
      calendar_access: calendarAccess,
      email: client.microsoft_calendar_email || null,
      plan_allowed: planCheck.allowed,
      plan_message: planCheck.allowed ? null : planCheck.reason,
    });
  } catch (error) {
    console.error('❌ Microsoft Calendar status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
