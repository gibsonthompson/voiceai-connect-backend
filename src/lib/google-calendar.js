// ============================================================================
// GOOGLE CALENDAR  (destination: src/lib/google-calendar.js)
// ----------------------------------------------------------------------------
// Connects Gibson's real Google Calendar to Jarvis alongside the HQ calendar.
// Reads events (so the briefing and a call-in reflect his actual calendar) and
// creates events (so booking by phone lands on his real calendar too).
//
// It reuses VoiceAI Connect's EXISTING Google OAuth app (same client id/secret
// the receptionist calendar uses) and the standard refresh-token flow. The
// connection is made from the HQ UI through routes/jarvis-calendar-auth.js,
// which stores the token in platform_settings under 'jarvis_google_calendar',
// the same isolated store used for jarvis_config. No hand-minted tokens, no
// per-user env vars.
//
// Fully gated on the stored connection: until the calendar is connected from
// HQ, every call returns empty/false and the line works exactly as before.
//
// All times are handled in America/New_York to match HQ (startHour is a decimal
// hour, e.g. 14.5 for 2:30pm), so merged events and conflict ranges line up
// with hq-supabase.js and hq-items.js exactly.
// ============================================================================

'use strict';

const { getPlatformSetting, setPlatformSetting } = require('./vapi');

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TZ = 'America/New_York';
const STORE_KEY = 'jarvis_google_calendar';

// Same OAuth client the receptionist calendar uses, so there is one Google app
// to maintain and its redirect URIs are already registered.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try { return await fetch(url, { ...(opts || {}), signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ── Connection + token ───────────────────────────────────────────────────────

async function getConnection() {
  try { return await getPlatformSetting(STORE_KEY); }
  catch (e) { console.warn('⚠️ Jarvis calendar read failed:', e.message); return null; }
}

async function isConnected() {
  const c = await getConnection();
  return !!(c && c.refresh_token);
}

// A valid access token from the stored connection, refreshing (and persisting
// the new token) when the cached one is within five minutes of expiry. Mirrors
// the receptionist's refreshAccessToken, but the token lives in platform_settings.
async function resolveToken(conn) {
  if (!conn || !conn.refresh_token) return null;
  const exp = new Date(conn.expires_at).getTime();
  if (conn.access_token && isFinite(exp) && exp - Date.now() > 5 * 60 * 1000) return conn.access_token;
  try {
    const res = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: conn.refresh_token,
        grant_type: 'refresh_token',
      }),
    }, 8000);
    if (!res.ok) { console.warn('⚠️ Jarvis calendar token refresh failed:', res.status); return null; }
    const t = await res.json();
    const updated = {
      ...conn,
      access_token: t.access_token,
      expires_at: new Date(Date.now() + ((t.expires_in || 3600) * 1000)).toISOString(),
    };
    try { await setPlatformSetting(STORE_KEY, updated); } catch (e) { /* non-blocking */ }
    return t.access_token;
  } catch (e) {
    console.warn('⚠️ Jarvis calendar token refresh error:', e.message);
    return null;
  }
}

// One read of the connection, returning a usable { token, calId } or null.
async function authed() {
  const conn = await getConnection();
  if (!conn || !conn.refresh_token) return null;
  const token = await resolveToken(conn);
  if (!token) return null;
  return { token, calId: conn.calendar_id || 'primary' };
}

// ── Time helpers (America/New_York) ─────────────────────────────────────────

// The ET UTC offset for a given date, DST-correct, as "-04:00" / "-05:00".
function etOffset(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(d);
  const tzn = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT-05:00';
  const m = tzn.match(/GMT([+-]\d{2}):?(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '-05:00';
}

// Decimal ET hour (e.g. 14.5) from an RFC3339 instant.
function etHourDecimal(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(d);
  const h = parseInt((parts.find((p) => p.type === 'hour') || {}).value, 10);
  const mi = parseInt((parts.find((p) => p.type === 'minute') || {}).value, 10);
  if (!isFinite(h) || !isFinite(mi)) return null;
  return h + mi / 60;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ── Reads ─────────────────────────────────────────────────────────────────

// Events on one ET date as { title, startHour, endHour, allDay }, matching the
// HQ schedule shape so they merge straight into the briefing.
async function listEventsForDate(dateStr) {
  if (!dateStr) return [];
  try {
    const a = await authed();
    if (!a) return [];
    const off = etOffset(dateStr);
    const timeMin = encodeURIComponent(`${dateStr}T00:00:00${off}`);
    const timeMax = encodeURIComponent(`${dateStr}T23:59:59${off}`);
    const cal = encodeURIComponent(a.calId);
    const url = `${CAL_BASE}/calendars/${cal}/events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${timeMin}&timeMax=${timeMax}`;
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${a.token}` } }, 8000);
    if (!res.ok) { console.warn('⚠️ Google Calendar list failed:', res.status); return []; }
    const d = await res.json();
    const items = Array.isArray(d.items) ? d.items : [];
    return items
      .filter((e) => e.status !== 'cancelled' && e.start)
      .map((e) => {
        const allDay = !!(e.start.date && !e.start.dateTime);
        const startIso = e.start.dateTime || e.start.date;
        const endIso = e.end && (e.end.dateTime || e.end.date);
        return {
          title: e.summary || 'Busy',
          allDay,
          startHour: allDay ? null : etHourDecimal(startIso),
          endHour: allDay ? null : (endIso ? etHourDecimal(endIso) : null),
          source: 'google',
        };
      })
      .filter((e) => e.allDay || e.startHour != null);
  } catch (e) {
    console.warn('⚠️ Google Calendar list error:', e.message);
    return [];
  }
}

// Occupied [startHour, endHour] pairs for a date, for conflict detection.
// Same shape hq.getOccupiedRanges returns, so the two merge directly.
async function occupiedRangesForDate(dateStr) {
  const events = await listEventsForDate(dateStr);
  return events
    .filter((e) => !e.allDay && e.startHour != null && e.endHour != null && e.endHour > e.startHour)
    .map((e) => [e.startHour, e.endHour]);
}

// ── Write ─────────────────────────────────────────────────────────────────

// Create a timed event on the ET date. startHour/durationHours are decimal
// hours (2:30pm = 14.5). Returns { ok, htmlLink } or { ok:false }.
async function createEvent({ title, dateStr, startHour, durationHours }) {
  try {
    const a = await authed();
    if (!a) return { ok: false, skipped: true };
    const off = etOffset(dateStr);
    const dur = (isFinite(durationHours) && durationHours > 0) ? durationHours : 1;
    const sH = Math.floor(startHour);
    const sM = Math.round((startHour - sH) * 60);
    const endDec = startHour + dur;
    const eH = Math.floor(endDec);
    const eM = Math.round((endDec - eH) * 60);
    const startRfc = `${dateStr}T${pad(sH)}:${pad(sM)}:00${off}`;
    const endRfc = `${dateStr}T${pad(eH)}:${pad(eM)}:00${off}`;
    const cal = encodeURIComponent(a.calId);
    const res = await fetchWithTimeout(`${CAL_BASE}/calendars/${cal}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: title,
        start: { dateTime: startRfc, timeZone: TZ },
        end: { dateTime: endRfc, timeZone: TZ },
      }),
    }, 8000);
    if (!res.ok) { console.warn('⚠️ Google Calendar create failed:', res.status); return { ok: false }; }
    const d = await res.json();
    return { ok: true, htmlLink: d.htmlLink || null };
  } catch (e) {
    console.warn('⚠️ Google Calendar create error:', e.message);
    return { ok: false };
  }
}

module.exports = { isConnected, listEventsForDate, occupiedRangesForDate, createEvent };