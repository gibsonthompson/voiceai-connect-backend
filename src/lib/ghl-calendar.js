// ghl-calendar.js, GoHighLevel (HighLevel / LeadConnector) calendar adapter.
//
// This is the GHL provider behind the appointment API (calendar-booking.js). It
// books, reschedules, and cancels real appointments in a client's connected GHL
// sub-account calendar, and upserts the contact the appointment binds to. GHL's
// own native workflow triggers (Contact Created, Appointment Booked, tags) then
// fire the agency's auto-text / nurture automations, so VoiceAI feeds GHL rather
// than replacing it.
//
// Auth model: one OAuth 2.0 Marketplace app (client id/secret in env). Each
// sub-account installs it; we store that sub-account's LOCATION access+refresh
// token on the client row and refresh on demand (GHL rotates the refresh token,
// so every refresh persists the new one).
//
// Verified against official docs (marketplace.gohighlevel.com) on 2026-10-27:
//   base https://services.leadconnectorhq.com, header "Version: v3",
//   POST /oauth/token, POST /contacts/upsert, GET /calendars/{id}/free-slots,
//   POST /calendars/events/appointments, PUT /calendars/events/appointments/{id}.

const { supabase } = require('./supabase');

const GHL_BASE = process.env.GHL_API_URI || 'https://services.leadconnectorhq.com';
// GHL is mid-migrating its Version header; current endpoint docs require "v3".
// Kept as a single constant (overridable by env) so it is a one-line change if
// they move again, never buried in each call.
const GHL_VERSION = process.env.GHL_API_VERSION || 'v3';
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;

// Marketplace OAuth authorize + token endpoints.
// White-label apps must build the authorize (chooselocation) URL on the
// LeadConnector domain, not marketplace.gohighlevel.com. Using the branded
// domain for a white-label app returns "No integration found with the id"
// because the integration is registered under the LeadConnector context.
// Override with GHL_AUTH_BASE only if needed.
const GHL_AUTH_BASE = process.env.GHL_AUTH_BASE || 'https://marketplace.leadconnectorhq.com';
const TOKEN_URL = `${GHL_BASE}/oauth/token`;

// Scopes the integration needs (space-separated in the authorize URL).
// Trimmed to exactly what the code exercises: upsert a contact, list
// calendars, read free slots, and create/reschedule/cancel appointments.
// (free-slots and calendar listing are covered by calendars.readonly;
// appointment create/update/cancel by calendars/events.write.) Add more
// only when a feature actually calls for it, since widening scopes forces
// every already-connected customer to re-authorize.
const GHL_SCOPES = [
  'contacts.write',
  'calendars.readonly',
  'calendars/events.write',
].join(' ');

function assertConfigured() {
  if (!GHL_CLIENT_ID || !GHL_CLIENT_SECRET) {
    throw new Error('GHL not configured: set GHL_CLIENT_ID and GHL_CLIENT_SECRET.');
  }
}

// Build the Marketplace authorize URL the client is redirected to. redirectUri
// must exactly match the one registered on the Marketplace app.
function buildAuthorizeUrl(redirectUri, state) {
  assertConfigured();
  const u = new URL(`${GHL_AUTH_BASE}/oauth/chooselocation`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', GHL_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', GHL_SCOPES);
  // A DRAFT (unpublished) marketplace app has no default published version for
  // chooselocation to resolve, so the bare authorize URL returns "No integration
  // found with the id". Passing the draft version id (as version_id) makes it
  // resolve. Set GHL_VERSION_ID while the app is in draft; remove it once the
  // app is approved and the published version resolves on its own.
  if (process.env.GHL_VERSION_ID) u.searchParams.set('version_id', process.env.GHL_VERSION_ID);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

// Exchange the one-time auth code for a LOCATION (sub-account) token set.
// Returns { access_token, refresh_token, expires_in, locationId, companyId, userType }.
async function exchangeCodeForTokens(code, redirectUri) {
  assertConfigured();
  const body = new URLSearchParams({
    client_id: GHL_CLIENT_ID,
    client_secret: GHL_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    user_type: 'Location',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GHL token exchange failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// Refresh a client's access token when it is near expiry. GHL rotates the
// refresh token, so the new one is persisted every time. Returns a valid access
// token, or null when the connection can no longer be refreshed (revoked).
async function getValidAccessToken(client) {
  if (!client || !client.ghl_access_token) return null;
  const expiresAt = client.ghl_token_expires_at ? new Date(client.ghl_token_expires_at).getTime() : 0;
  const bufferMs = 5 * 60 * 1000;
  if (expiresAt && expiresAt - Date.now() > bufferMs) {
    return client.ghl_access_token;
  }
  if (!client.ghl_refresh_token) return null;
  try {
    assertConfigured();
    const body = new URLSearchParams({
      client_id: GHL_CLIENT_ID,
      client_secret: GHL_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: client.ghl_refresh_token,
      user_type: 'Location',
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!res.ok) {
      console.error('GHL token refresh failed:', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return null;
    }
    const t = await res.json();
    const newExpiry = new Date(Date.now() + (Number(t.expires_in) || 86400) * 1000).toISOString();
    // Persist the rotated tokens, and update the in-memory client so the caller
    // uses the fresh token in this same request.
    await supabase.from('clients').update({
      ghl_access_token: t.access_token,
      ghl_refresh_token: t.refresh_token || client.ghl_refresh_token,
      ghl_token_expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    }).eq('id', client.id);
    client.ghl_access_token = t.access_token;
    client.ghl_refresh_token = t.refresh_token || client.ghl_refresh_token;
    client.ghl_token_expires_at = newExpiry;
    return t.access_token;
  } catch (err) {
    console.error('GHL token refresh error:', err.message);
    return null;
  }
}

async function ghlFetch(token, method, path, { query, body } = {}) {
  const u = new URL(`${GHL_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) { if (v !== undefined && v !== null) u.searchParams.set(k, String(v)); }
  const res = await fetch(u.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_VERSION,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

// Upsert a contact (dedupes by email/phone) and return its id. An appointment
// must bind to a contactId, so this runs first.
async function upsertContact(token, locationId, { name, firstName, lastName, phone, email }) {
  const payload = { locationId };
  if (name) payload.name = name;
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;
  if (phone) payload.phone = phone;
  if (email) payload.email = email;
  const r = await ghlFetch(token, 'POST', '/contacts/upsert', { body: payload });
  if (!r.ok) return { ok: false, status: r.status, error: (r.text || '').slice(0, 300) };
  const id = (r.json && (r.json.contact?.id || r.json.id)) || null;
  return { ok: !!id, id };
}

// List a location's calendars (used to pick a default at connect time).
async function listCalendars(token, locationId) {
  const r = await ghlFetch(token, 'GET', '/calendars/', { query: { locationId } });
  if (!r.ok) return { ok: false, status: r.status, calendars: [] };
  const calendars = (r.json && (r.json.calendars || r.json.data)) || [];
  return { ok: true, calendars };
}

// Get free slots for a calendar between two instants. GHL wants epoch millis and
// a <= 31-day range. Returns an array of ISO slot start strings.
async function getFreeSlots(token, calendarId, startMs, endMs, { timezone, durationMinutes } = {}) {
  const query = { startDate: Math.floor(startMs), endDate: Math.floor(endMs) };
  if (timezone) query.timezone = timezone;
  if (durationMinutes) query.duration = durationMinutes;
  const r = await ghlFetch(token, 'GET', `/calendars/${encodeURIComponent(calendarId)}/free-slots`, { query });
  if (!r.ok) return { ok: false, status: r.status, slots: [], error: (r.text || '').slice(0, 300) };
  // Response is keyed by date (YYYY-MM-DD) -> { slots: [ISO,...] }, with some
  // non-date keys (traceId). Also tolerate a top-level slots array.
  const out = [];
  const j = r.json || {};
  if (Array.isArray(j.slots)) out.push(...j.slots);
  for (const [k, v] of Object.entries(j)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v && Array.isArray(v.slots)) out.push(...v.slots);
  }
  return { ok: true, slots: out };
}

// Create a real appointment. startTime/endTime are ISO 8601 strings.
async function createAppointment(token, { calendarId, locationId, contactId, startTime, endTime, title, assignedUserId, address, appointmentStatus }) {
  const body = { calendarId, locationId, contactId, startTime };
  if (endTime) body.endTime = endTime;
  if (title) body.title = title;
  if (assignedUserId) body.assignedUserId = assignedUserId;
  if (address) body.address = address;
  if (appointmentStatus) body.appointmentStatus = appointmentStatus;
  const r = await ghlFetch(token, 'POST', '/calendars/events/appointments', { body });
  if (!r.ok) {
    return { ok: false, status: r.status, error: (r.text || '').slice(0, 300) };
  }
  const id = (r.json && (r.json.id || r.json.event?.id || r.json.appointment?.id)) || null;
  return { ok: !!id, id, raw: r.json };
}

// Reschedule: PUT the appointment with a new start/end.
async function updateAppointment(token, eventId, { startTime, endTime }) {
  const body = {};
  if (startTime) body.startTime = startTime;
  if (endTime) body.endTime = endTime;
  const r = await ghlFetch(token, 'PUT', `/calendars/events/appointments/${encodeURIComponent(eventId)}`, { body });
  if (!r.ok) return { ok: false, status: r.status, error: (r.text || '').slice(0, 300) };
  return { ok: true, raw: r.json };
}

// Cancel: GHL has no cancel endpoint; set appointmentStatus to cancelled.
async function cancelAppointment(token, eventId) {
  const r = await ghlFetch(token, 'PUT', `/calendars/events/appointments/${encodeURIComponent(eventId)}`, { body: { appointmentStatus: 'cancelled' } });
  if (!r.ok) return { ok: false, status: r.status, error: (r.text || '').slice(0, 300) };
  return { ok: true, raw: r.json };
}

module.exports = {
  GHL_SCOPES,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  upsertContact,
  listCalendars,
  getFreeSlots,
  createAppointment,
  updateAppointment,
  cancelAppointment,
};
