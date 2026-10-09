// ============================================================================
// JARVIS CALENDAR AUTH  (destination: src/routes/jarvis-calendar-auth.js)
// ----------------------------------------------------------------------------
// Connects Gibson's personal Google Calendar to the Jarvis line from the HQ UI,
// reusing VoiceAI Connect's EXISTING Google OAuth app (same client id/secret as
// the receptionist calendar). The token is stored in platform_settings under
// 'jarvis_google_calendar', the isolated store lib/google-calendar.js reads.
//
// Isolated from the receptionist calendar flow on purpose (own routes, own
// store, own redirect URI), the same way the rest of Jarvis is kept separate.
//
// Mount in server.js beside the other Jarvis routes:
//   app.use('/api/auth/jarvis-calendar', require('./routes/jarvis-calendar-auth'));
//
// One Google Console change: add this redirect URI to the existing OAuth
// client's authorized redirect URIs:
//   ${BACKEND_URL}/api/auth/jarvis-calendar/callback
//
// Env (names only):
//   GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CLIENT_ID       (reused)
//   GOOGLE_CALENDAR_CLIENT_SECRET / GOOGLE_CLIENT_SECRET (reused)
//   BACKEND_URL           this backend's public URL (for the redirect URI)
//   JARVIS_HQ_URL         HQ settings page to return to after connecting
//   JARVIS_CALENDAR_TOKEN shared secret HQ passes to gate connect/disconnect
//   JARVIS_GOOGLE_EMAIL   optional: only this Google account may be linked
// ============================================================================

'use strict';

const express = require('express');
const router = express.Router();
const { getPlatformSetting, setPlatformSetting } = require('../lib/vapi');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://urchin-app-bqb4i.ondigitalocean.app';
const HQ_URL = process.env.JARVIS_HQ_URL || '';
const STORE_KEY = 'jarvis_google_calendar';
const CONNECT_TOKEN = process.env.JARVIS_CALENDAR_TOKEN || null;
const ALLOWED_EMAIL = (process.env.JARVIS_GOOGLE_EMAIL || '').trim().toLowerCase() || null;

// openid + email so the token response carries the connected account's email,
// then calendar.events for read + create. Matches the receptionist's scopes.
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events';
const REDIRECT_URI = `${BACKEND_URL}/api/auth/jarvis-calendar/callback`;

// Decode the connected account's email from the id_token (came straight from
// Google over TLS), falling back to the userinfo endpoint. Non-blocking.
function emailFromIdToken(idToken) {
  try {
    const payload = String(idToken).split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).email || null;
  } catch (e) { return null; }
}
async function fetchGoogleEmail(tokens) {
  const fromId = tokens && tokens.id_token ? emailFromIdToken(tokens.id_token) : null;
  if (fromId) return fromId;
  if (!tokens || !tokens.access_token) return null;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!r.ok) return null;
    return (await r.json()).email || null;
  } catch (e) { return null; }
}

// Only return to an https HQ URL. Falls back to the configured HQ_URL.
function safeReturn(returnTo) {
  const candidate = returnTo || HQ_URL;
  try {
    const u = new URL(candidate);
    if (u.protocol === 'https:') return `${u.protocol}//${u.host}${u.pathname}`;
  } catch (e) { /* fall through */ }
  return HQ_URL || null;
}

function tokenOk(req) {
  if (!CONNECT_TOKEN) return true; // gate disabled until the secret is set
  const t = req.query.token || (req.body && req.body.token);
  return t === CONNECT_TOKEN;
}

// ── GET /connect : start the OAuth flow (linked from HQ) ─────────────────────
router.get('/connect', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(500).send('Google Calendar is not configured.');
  if (!tokenOk(req)) return res.status(403).send('Forbidden');
  const returnTo = safeReturn(req.query.return) || '';
  const state = Buffer.from(JSON.stringify({ j: 1, returnTo })).toString('base64url');
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // force a refresh_token every time
  authUrl.searchParams.set('state', state);
  res.redirect(authUrl.toString());
});

// ── GET /callback : exchange the code, store the token ───────────────────────
router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  let returnTo = HQ_URL;
  try {
    const s = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString());
    if (s && s.returnTo) returnTo = s.returnTo;
  } catch (e) { /* keep default */ }
  const back = (q) => {
    if (!returnTo) return res.status(200).send(q.includes('connected') ? 'Calendar connected. You can close this tab.' : `Calendar: ${q}`);
    return res.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}${q}`);
  };

  if (oauthError) return back('calendar=denied');
  if (!code) return back('calendar=failed');

  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
      }),
    });
    if (!tr.ok) { console.error('❌ Jarvis calendar token exchange failed:', await tr.text()); return back('calendar=token_failed'); }
    const tokens = await tr.json();

    const email = await fetchGoogleEmail(tokens);
    if (ALLOWED_EMAIL && (!email || email.toLowerCase() !== ALLOWED_EMAIL)) {
      console.warn(`🚫 Jarvis calendar: account ${email || 'unknown'} is not the allowed account`);
      return back('calendar=wrong_account');
    }

    const existing = await getPlatformSetting(STORE_KEY).catch(() => null);
    const refresh = tokens.refresh_token || (existing && existing.refresh_token) || null;
    if (!refresh) return back('calendar=no_refresh'); // consent did not return offline access

    await setPlatformSetting(STORE_KEY, {
      access_token: tokens.access_token,
      refresh_token: refresh,
      expires_at: new Date(Date.now() + ((tokens.expires_in || 3600) * 1000)).toISOString(),
      email: email || (existing && existing.email) || null,
      calendar_id: (existing && existing.calendar_id) || 'primary',
      connected_at: new Date().toISOString(),
    });
    console.log(`✅ Jarvis Google Calendar connected (${email || 'email unknown'})`);
    return back('calendar=connected');
  } catch (e) {
    console.error('❌ Jarvis calendar callback error:', e.message);
    return back('calendar=error');
  }
});

// ── GET /status : what HQ renders the card from ──────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const c = await getPlatformSetting(STORE_KEY).catch(() => null);
    res.json({ connected: !!(c && c.refresh_token), email: (c && c.email) || null });
  } catch (e) {
    res.json({ connected: false, email: null });
  }
});

// ── POST /disconnect : revoke + clear ────────────────────────────────────────
router.post('/disconnect', async (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const c = await getPlatformSetting(STORE_KEY).catch(() => null);
    if (c && c.access_token) {
      try { await fetch(`https://oauth2.googleapis.com/revoke?token=${c.access_token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); }
      catch (e) { /* best effort */ }
    }
    await setPlatformSetting(STORE_KEY, { connected: false });
    console.log('✅ Jarvis Google Calendar disconnected');
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Jarvis calendar disconnect error:', e.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

module.exports = router;