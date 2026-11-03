// ============================================================================
// src/lib/agent-presence.js
//
// DB-backed presence + availability for call-center agents. It is the source of
// truth the escalation router reads to answer "who can take this caller right
// now?", and the manager presence bar reads to show who is online.
//
// OWNER-AGNOSTIC: an agent is owned by EITHER an agency (agency_id) OR a call
// center (call_center_id). Every function accepts { agencyId } or
// { callCenterId }; exactly one is set. The row is keyed on member_user_id (one
// presence row per agent, which is the real natural key), so an agency agent and
// a call-center agent are handled by the same code with only the owner column
// and the team scope (entity_type) differing. Passing agencyId reproduces the
// original agency behavior exactly.
//
// Why the database (not an in-memory bus): presence has to be correct across
// every backend instance. The agent's console heartbeats on whatever instance
// its request lands on, while a live call's transfer request lands on a
// different instance; only a shared store lets the call path see an agent who is
// heartbeating elsewhere.
//
// "Online" is derived from last_seen recency, never stored, so a closed tab or a
// crashed instance simply ages out. Everything here is best-effort and swallows
// its own errors: presence must never throw into a live call path. A failed read
// returns an empty list, which the caller treats as "no agents available" and
// falls back to the existing owner/transfer dial.
// ============================================================================

const { supabase } = require('./supabase');

const ONLINE_WINDOW_MS = parseInt(process.env.AGENT_PRESENCE_ONLINE_MS || '', 10) || 90000;

function onlineCutoffIso() {
  return new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
}

// Resolve the owner into the pieces every query needs. Call-center wins when
// present; otherwise agency (the original behavior). `col` is the presence/offer
// owner column, `entityType` scopes team_members, `tzTable` holds the timezone.
function resolveOwner({ agencyId, callCenterId }) {
  if (callCenterId) return { col: 'call_center_id', id: callCenterId, entityType: 'call_center', tzTable: 'call_centers' };
  return { col: 'agency_id', id: agencyId, entityType: 'agency', tzTable: 'agencies' };
}

// ---- Per-agent working hours ------------------------------------------------
const DOW = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };

function hoursNowInTz(timezone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  }
  const wd = parts.find((x) => x.type === 'weekday')?.value || 'Mon';
  let H = parseInt(parts.find((x) => x.type === 'hour')?.value || '0', 10);
  if (H === 24) H = 0;
  const M = parseInt(parts.find((x) => x.type === 'minute')?.value || '0', 10);
  return { day: DOW[wd] || 'mon', minutes: H * 60 + M };
}

function parseHM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const mins = (+m[1]) * 60 + (+m[2]);
  return mins >= 0 && mins <= 1439 ? mins : null;
}

function inWindow(minutes, start, end) {
  if (start == null || end == null) return false;
  if (end <= start) return minutes >= start || minutes < end;
  return minutes >= start && minutes < end;
}

function dayWindows(d) {
  if (!d) return [];
  if (Array.isArray(d.windows)) return d.windows;
  if (d.start || d.end) return [{ start: d.start, end: d.end }];
  return [];
}

function isAgentOnSchedule(availabilityHours, timezone, nowOverride) {
  const ah = availabilityHours;
  if (!ah || typeof ah !== 'object' || ah.enabled !== true || !ah.days || typeof ah.days !== 'object') return true;
  if (ah.override === true) return true;
  const { day, minutes } = nowOverride || hoursNowInTz(timezone);
  const d = ah.days[day];
  if (!d || d.on !== true) return false;
  return dayWindows(d).some((w) => inWindow(minutes, parseHM(w && w.start), parseHM(w && w.end)));
}

function normStatus(s) { return s === 'away' ? 'away' : 'available'; }
function normDelivery(d) { return d === 'phone' ? 'phone' : 'browser'; }

// Upsert a heartbeat. Refreshes last_seen + the agent's status/delivery snapshot.
// Keyed on member_user_id (the natural key). Sets the owner column (agency_id OR
// call_center_id) so a new row is stamped to the right owner. Returns true/false.
async function heartbeat({ agencyId, callCenterId, memberUserId, displayName, callDelivery, agentPhone, status }) {
  if ((!agencyId && !callCenterId) || !memberUserId) return false;
  const { col, id } = resolveOwner({ agencyId, callCenterId });
  try {
    const row = {
      member_user_id: memberUserId,
      [col]: id,
      busy: false,
      busy_client_id: null,
      last_seen: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (typeof displayName === 'string') row.display_name = displayName;
    if (status !== undefined) row.status = normStatus(status);
    if (callDelivery !== undefined) row.call_delivery = normDelivery(callDelivery);
    if (agentPhone !== undefined) row.agent_phone = agentPhone || null;

    // A NEW session starts when the agent was offline (no row, or last_seen gone
    // stale past the online window). Stamp online_since + reset the per-session
    // counter; on a continuing session omit both so the upsert keeps them.
    try {
      const { data: prev } = await supabase
        .from('agent_presence').select('last_seen')
        .eq('member_user_id', memberUserId).maybeSingle();
      const wasOffline = !prev || !prev.last_seen || (Date.now() - Date.parse(prev.last_seen) >= ONLINE_WINDOW_MS);
      if (wasOffline) { row.online_since = new Date().toISOString(); row.session_calls = 0; }
    } catch (e) { /* non-fatal; skip the session stamp */ }

    const { error } = await supabase
      .from('agent_presence')
      .upsert(row, { onConflict: 'member_user_id' });
    if (error) { console.warn('agent-presence: heartbeat upsert failed:', error.message); return false; }
    return true;
  } catch (e) {
    console.warn('agent-presence: heartbeat error:', e.message);
    return false;
  }
}

// Flip status (available / away). Keyed on member_user_id.
async function setStatus({ agencyId, callCenterId, memberUserId, status }) {
  if (!memberUserId) return false;
  try {
    const { error } = await supabase
      .from('agent_presence')
      .update({ status: normStatus(status), updated_at: new Date().toISOString() })
      .eq('member_user_id', memberUserId);
    return !error;
  } catch { return false; }
}

// Mark an agent busy/free on a routed call. Keyed on member_user_id.
async function setBusy({ agencyId, callCenterId, memberUserId, busy, busyClientId }) {
  if (!memberUserId) return false;
  try {
    const { error } = await supabase
      .from('agent_presence')
      .update({
        busy: !!busy,
        busy_client_id: busy ? (busyClientId || null) : null,
        updated_at: new Date().toISOString(),
      })
      .eq('member_user_id', memberUserId);
    return !error;
  } catch { return false; }
}

// Count one more call answered this session. Keyed on member_user_id.
async function incrementSessionCalls({ agencyId, callCenterId, memberUserId }) {
  if (!memberUserId) return false;
  try {
    const { data } = await supabase
      .from('agent_presence').select('session_calls')
      .eq('member_user_id', memberUserId).maybeSingle();
    const next = ((data && data.session_calls) || 0) + 1;
    const { error } = await supabase
      .from('agent_presence').update({ session_calls: next, updated_at: new Date().toISOString() })
      .eq('member_user_id', memberUserId);
    return !error;
  } catch { return false; }
}

// Every presence row for an OWNER (agency or call center), each stamped with a
// derived `online` flag. Used by the manager presence bar.
async function listForOwner({ agencyId, callCenterId }) {
  const { col, id } = resolveOwner({ agencyId, callCenterId });
  if (!id) return [];
  try {
    const { data, error } = await supabase
      .from('agent_presence')
      .select('member_user_id, display_name, status, busy, busy_client_id, call_delivery, agent_phone, last_seen, online_since, session_calls')
      .eq(col, id);
    if (error || !Array.isArray(data)) return [];
    const cutoff = Date.now() - ONLINE_WINDOW_MS;
    return data.map((r) => ({
      memberUserId: r.member_user_id,
      displayName: r.display_name || null,
      status: r.status || 'available',
      busy: !!r.busy,
      busyClientId: r.busy_client_id || null,
      callDelivery: r.call_delivery || 'browser',
      agentPhone: r.agent_phone || null,
      lastSeen: r.last_seen,
      onlineSince: r.online_since || null,
      sessionCalls: r.session_calls || 0,
      online: !!r.last_seen && Date.parse(r.last_seen) >= cutoff,
    }));
  } catch { return []; }
}

// Backwards-compatible agency alias (positional agencyId), kept for the existing
// agency manager presence route.
async function listForAgency(agencyId) {
  return listForOwner({ agencyId });
}

// The agents who can take THIS caller right now: online, available, not busy, AND
// assigned to this business. Owner-aware (agency or call center). Returns a list
// ordered browser-first then least-recently-busy. Never throws; [] on error.
async function listAvailableForClient({ agencyId, callCenterId, clientId }) {
  const { col, id, entityType, tzTable } = resolveOwner({ agencyId, callCenterId });
  if (!id || !clientId) return [];
  try {
    const { data: members, error: mErr } = await supabase
      .from('team_members')
      .select('member_user_id, display_name, assigned_client_ids, call_delivery, agent_phone, status, seat_disabled_at, availability_hours')
      .eq('entity_type', entityType)
      .eq('entity_id', id);
    if (mErr || !Array.isArray(members)) return [];
    const assigned = members.filter((m) => {
      if (!m.member_user_id) return false;
      if (m.status === 'disabled' || m.seat_disabled_at) return false;
      if (Array.isArray(m.assigned_client_ids)) return m.assigned_client_ids.includes(clientId);
      return true;
    });
    if (assigned.length === 0) return [];
    const byUser = new Map(assigned.map((m) => [m.member_user_id, m]));
    const ids = Array.from(byUser.keys());

    const { data: pres, error: pErr } = await supabase
      .from('agent_presence')
      .select('member_user_id, display_name, status, busy, call_delivery, agent_phone, last_seen')
      .eq(col, id)
      .in('member_user_id', ids)
      .eq('status', 'available')
      .gte('last_seen', onlineCutoffIso());
    if (pErr || !Array.isArray(pres)) return [];

    let tz = 'America/New_York';
    try { const { data: own } = await supabase.from(tzTable).select('timezone').eq('id', id).single(); if (own && own.timezone) tz = own.timezone; } catch (e) {}
    const nowTz = hoursNowInTz(tz);
    const presOnSchedule = pres.filter((p) => isAgentOnSchedule((byUser.get(p.member_user_id) || {}).availability_hours, tz, nowTz));

    const out = presOnSchedule.map((p) => {
      const m = byUser.get(p.member_user_id) || {};
      const callDelivery = normDelivery(m.call_delivery || p.call_delivery);
      const agentPhone = m.agent_phone || p.agent_phone || null;
      return {
        memberUserId: p.member_user_id,
        displayName: m.display_name || p.display_name || null,
        callDelivery,
        agentPhone,
        busy: !!p.busy,
        lastSeen: p.last_seen,
      };
    });
    const usable = out.filter((a) => a.callDelivery === 'browser' || !!a.agentPhone);
    usable.sort((a, b) => {
      if (a.busy !== b.busy) return a.busy ? 1 : -1;
      if (a.callDelivery !== b.callDelivery) return a.callDelivery === 'browser' ? -1 : 1;
      return Date.parse(a.lastSeen || 0) - Date.parse(b.lastSeen || 0);
    });
    return usable;
  } catch (e) {
    console.warn('agent-presence: listAvailableForClient error:', e.message);
    return [];
  }
}

module.exports = {
  ONLINE_WINDOW_MS,
  heartbeat,
  setStatus,
  setBusy,
  incrementSessionCalls,
  listForOwner,
  listForAgency,
  listAvailableForClient,
  isAgentOnSchedule,
  hoursNowInTz,
};
