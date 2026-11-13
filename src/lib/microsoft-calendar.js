// ============================================================================
// MICROSOFT 365 / OUTLOOK CALENDAR  (destination: src/lib/microsoft-calendar.js)
// ----------------------------------------------------------------------------
// Per-client Outlook / Microsoft 365 calendar integration for the receptionist,
// built on Microsoft Graph. It is the Microsoft counterpart to the Google path
// in calendar-booking.js: read busy times for availability, and create /
// update / cancel events when the AI books, reschedules, or cancels.
//
// Tokens live on the client row (microsoft_access_token / _refresh_token /
// _token_expires_at), exactly like the Google columns, and are refreshed on
// demand. Microsoft ROTATES refresh tokens on every refresh, so we persist the
// new refresh token when Graph returns one (Google does not rotate, so this is
// the one real behavioral difference to watch).
//
// One multi-tenant Entra app (MICROSOFT_CLIENT_ID / _SECRET, tenant 'common')
// serves every client: work Microsoft 365 accounts and personal Outlook
// accounts both consent into it. Nothing here is per-client at the app level.
//
// All times are handled the same way the Google path handles them: wall-clock
// times are sent to Graph with an IANA timeZone (Graph resolves them), and busy
// times are read back as absolute UTC instants (Prefer: outlook.timezone="UTC"),
// so the slot engine in calendar-booking.js compares real instants and is
// correct regardless of the server's timezone.
// ============================================================================

'use strict';

const { supabase } = require('./supabase');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_TENANT = process.env.MICROSOFT_TENANT || 'common';

// openid + email so the token response carries the account's email (shown on
// the connection card). offline_access is required for a refresh token.
// User.Read lets us read the account's email from /me. Calendars.ReadWrite is
// what booking actually needs.
const MS_SCOPES = 'openid email offline_access User.Read Calendars.ReadWrite';

const AUTHORIZE_URL = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/token`;

function isConfigured() {
  return !!(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET);
}

// Graph's calendarView, with Prefer: outlook.timezone="UTC", returns dateTimes
// WITHOUT a trailing Z (e.g. "2026-11-20T14:00:00.0000000"). Those are UTC, so
// we append Z to parse them as absolute instants. Leave anything that already
// carries a Z or a numeric offset untouched.
function graphUtcToDate(dateTimeStr) {
  if (!dateTimeStr) return new Date(NaN);
  const s = String(dateTimeStr);
  const hasZone = /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
  return new Date(hasZone ? s : `${s}Z`);
}

// ── Token exchange + refresh ────────────────────────────────────────────────

// Exchange an authorization code for tokens (called from the auth-route
// callback). Returns the parsed token payload or null.
async function exchangeCode(code, redirectUri) {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: MS_SCOPES,
      }),
    });
    if (!res.ok) {
      console.error('❌ Microsoft token exchange failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('❌ Microsoft token exchange error:', err.message);
    return null;
  }
}

// Return a valid access token for the client, refreshing (and persisting the
// rotated refresh token) when the cached one is within five minutes of expiry.
// Mirrors calendar-booking.refreshAccessToken, but for the microsoft_* columns
// and with Microsoft's refresh-token rotation handled.
async function refreshMicrosoftToken(client) {
  if (!client || !client.microsoft_refresh_token) {
    console.error('No Microsoft refresh token available');
    return null;
  }

  const expiresAt = new Date(client.microsoft_token_expires_at);
  const now = new Date();
  const bufferMs = 5 * 60 * 1000;

  if (client.microsoft_access_token && !isNaN(expiresAt.getTime()) && expiresAt.getTime() - now.getTime() > bufferMs) {
    return client.microsoft_access_token;
  }

  console.log('🔄 Refreshing Microsoft access token...');

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        refresh_token: client.microsoft_refresh_token,
        grant_type: 'refresh_token',
        scope: MS_SCOPES,
      }),
    });

    if (!res.ok) {
      console.error('Microsoft token refresh failed:', res.status, await res.text().catch(() => ''));
      return null;
    }

    const tokens = await res.json();
    const newExpiresAt = new Date(Date.now() + ((tokens.expires_in || 3600) * 1000)).toISOString();

    const update = {
      microsoft_access_token: tokens.access_token,
      microsoft_token_expires_at: newExpiresAt,
    };
    // Microsoft rotates refresh tokens: persist the new one so the next refresh
    // does not use a superseded token (which Microsoft rejects).
    if (tokens.refresh_token) update.microsoft_refresh_token = tokens.refresh_token;

    await supabase.from('clients').update(update).eq('id', client.id);

    // Keep the in-memory client object current for the rest of this request.
    client.microsoft_access_token = tokens.access_token;
    client.microsoft_token_expires_at = newExpiresAt;
    if (tokens.refresh_token) client.microsoft_refresh_token = tokens.refresh_token;

    return tokens.access_token;
  } catch (err) {
    console.error('Microsoft token refresh error:', err.message);
    return null;
  }
}

// ── Account email (for the connection card) ──────────────────────────────────

// The connected account's email. Non-blocking: null on any failure, which only
// means the card omits the email line. Personal Outlook accounts expose it as
// userPrincipalName when mail is empty, so fall back to that.
async function getUserEmail(accessToken) {
  try {
    const res = await fetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const info = await res.json();
    return info.mail || info.userPrincipalName || null;
  } catch (e) {
    return null;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

// Busy ranges in [startISO, endISO), as absolute instants, plus whether an
// all-day event covers the window (treated as "out for the day" like the Google
// path). Returns { ok, busy:[{start:Date,end:Date}], allDay:boolean }.
// ok:false means the calendar could not be read, so the caller fails safe.
async function getMicrosoftBusy(client, accessToken, startISO, endISO) {
  try {
    const url = `${GRAPH_BASE}/me/calendarView?` + new URLSearchParams({
      startDateTime: startISO,
      endDateTime: endISO,
      $select: 'subject,start,end,isAllDay,isCancelled,showAs',
      $top: '100',
    });
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // Return every event's start/end expressed in UTC so we can compare
        // absolute instants without depending on the server's timezone.
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!res.ok) {
      console.error(`Microsoft calendarView failed (HTTP ${res.status}):`, (await res.text().catch(() => '')).slice(0, 200));
      return { ok: false, busy: [], allDay: false };
    }
    const data = await res.json();
    const items = Array.isArray(data.value) ? data.value : [];

    // An all-day event almost always means the office is out (Closed, Vacation,
    // Holiday). Treat the day as unavailable rather than risk booking over it.
    const allDay = items.some((ev) => ev && ev.isAllDay === true && ev.isCancelled !== true && ev.showAs !== 'free');

    const busy = items
      .filter((ev) => ev && ev.isCancelled !== true && ev.showAs !== 'free' && ev.isAllDay !== true)
      .filter((ev) => ev.start && ev.start.dateTime && ev.end && ev.end.dateTime)
      .map((ev) => ({ start: graphUtcToDate(ev.start.dateTime), end: graphUtcToDate(ev.end.dateTime) }))
      .filter((b) => !isNaN(b.start.getTime()) && !isNaN(b.end.getTime()));

    return { ok: true, busy, allDay };
  } catch (err) {
    console.error('Microsoft calendarView error:', err.message);
    return { ok: false, busy: [], allDay: false };
  }
}

// ── Writes ─────────────────────────────────────────────────────────────────

// Create a timed event. startDateTime/endDateTime are naive wall-clock strings
// ("2026-11-20T14:00:00"); timeZone is an IANA name Graph resolves. Returns
// { ok, id, webLink } or { ok:false }.
async function createMicrosoftEvent(accessToken, { subject, description, startDateTime, endDateTime, timeZone }) {
  try {
    const res = await fetch(`${GRAPH_BASE}/me/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: subject || 'Appointment',
        body: { contentType: 'text', content: description || '' },
        start: { dateTime: startDateTime, timeZone: timeZone || 'UTC' },
        end: { dateTime: endDateTime, timeZone: timeZone || 'UTC' },
      }),
    });
    if (!res.ok) {
      console.error('❌ Microsoft create event failed:', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    const ev = await res.json();
    return { ok: true, id: ev.id, webLink: ev.webLink || null };
  } catch (err) {
    console.error('❌ Microsoft create event error:', err.message);
    return { ok: false };
  }
}

// Move an existing event to a new start/end (reschedule).
async function updateMicrosoftEvent(accessToken, eventId, { startDateTime, endDateTime, timeZone }) {
  try {
    const res = await fetch(`${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: { dateTime: startDateTime, timeZone: timeZone || 'UTC' },
        end: { dateTime: endDateTime, timeZone: timeZone || 'UTC' },
      }),
    });
    if (!res.ok) {
      console.error('❌ Microsoft update event failed:', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error('❌ Microsoft update event error:', err.message);
    return { ok: false };
  }
}

// Delete an event (cancel). A 404/410 means it is already gone, which we treat
// as success so a cancel is idempotent.
async function cancelMicrosoftEvent(accessToken, eventId) {
  try {
    const res = await fetch(`${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      console.error('❌ Microsoft cancel event failed:', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error('❌ Microsoft cancel event error:', err.message);
    return { ok: false };
  }
}

module.exports = {
  isConfigured,
  MS_SCOPES,
  AUTHORIZE_URL,
  TOKEN_URL,
  exchangeCode,
  refreshMicrosoftToken,
  getUserEmail,
  getMicrosoftBusy,
  createMicrosoftEvent,
  updateMicrosoftEvent,
  cancelMicrosoftEvent,
};
