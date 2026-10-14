// ============================================================================
// src/lib/agent-presence.js
//
// DB-backed presence + availability for call-center agents (agency_staff). It is
// the source of truth the escalation router reads to answer "who can take this
// caller right now?", and the manager presence bar reads to show who is online.
//
// Why the database (not an in-memory bus like live-monitor-bus): presence has to
// be correct across every backend instance. The agent's /cc console heartbeats
// on whatever instance its request lands on, while a live call's transfer
// request lands on a different instance; only a shared store lets the call path
// see an agent who is heartbeating elsewhere. Writes are tiny and infrequent
// (one upsert per agent per ~15s), reads are one query per escalation.
//
// "Online" is derived from last_seen recency, never stored, so a closed tab or a
// crashed instance simply ages out - there is no stale "online" to clean up.
//
// Everything here is best-effort and swallows its own errors: presence must
// never throw into a live call path. A failed read returns an empty list, which
// the caller treats as "no agents available" and falls back to the existing
// owner/transfer dial.
// ============================================================================

const { supabase } = require('./supabase');

// An agent counts as online if we have heard from them within this window. The
// /cc console heartbeats every ~15s, so ~3 missed beats ages them out.
const ONLINE_WINDOW_MS = parseInt(process.env.AGENT_PRESENCE_ONLINE_MS || '', 10) || 45000;

function onlineCutoffIso() {
  return new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
}

function normStatus(s) {
  return s === 'away' ? 'away' : 'available';
}
function normDelivery(d) {
  return d === 'phone' ? 'phone' : 'browser';
}

// Upsert a heartbeat. Refreshes last_seen (liveness) and the agent's current
// status + delivery snapshot. Returns true on success, false on any error.
//
// Clearing `busy`: a heartbeat means the agent's /cc console is present and
// available, so by definition they are not tied up on a routed call - clear the
// advisory busy flag. A browser agent handling a call has left /cc for the live
// monitor and is not heartbeating, so their busy flag persists until they come
// back. This keeps busy self-healing (no stuck "on a call") without real-time
// call-state tracking.
async function heartbeat({ agencyId, memberUserId, displayName, callDelivery, agentPhone, status }) {
  if (!agencyId || !memberUserId) return false;
  try {
    const row = {
      agency_id: agencyId,
      member_user_id: memberUserId,
      busy: false,
      busy_client_id: null,
      last_seen: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (typeof displayName === 'string') row.display_name = displayName;
    if (status !== undefined) row.status = normStatus(status);
    if (callDelivery !== undefined) row.call_delivery = normDelivery(callDelivery);
    if (agentPhone !== undefined) row.agent_phone = agentPhone || null;
    const { error } = await supabase
      .from('agent_presence')
      .upsert(row, { onConflict: 'agency_id,member_user_id' });
    if (error) { console.warn('agent-presence: heartbeat upsert failed:', error.message); return false; }
    return true;
  } catch (e) {
    console.warn('agent-presence: heartbeat error:', e.message);
    return false;
  }
}

// Flip a specific agent's status (available / away) without a full heartbeat.
async function setStatus({ agencyId, memberUserId, status }) {
  if (!agencyId || !memberUserId) return false;
  try {
    const { error } = await supabase
      .from('agent_presence')
      .update({ status: normStatus(status), updated_at: new Date().toISOString() })
      .eq('agency_id', agencyId)
      .eq('member_user_id', memberUserId);
    return !error;
  } catch { return false; }
}

// Mark an agent busy/free (on a call we routed to them). busy_client_id records
// which business they are on, so the presence bar can show it.
async function setBusy({ agencyId, memberUserId, busy, busyClientId }) {
  if (!agencyId || !memberUserId) return false;
  try {
    const { error } = await supabase
      .from('agent_presence')
      .update({
        busy: !!busy,
        busy_client_id: busy ? (busyClientId || null) : null,
        updated_at: new Date().toISOString(),
      })
      .eq('agency_id', agencyId)
      .eq('member_user_id', memberUserId);
    return !error;
  } catch { return false; }
}

// Every presence row for an agency, each stamped with a derived `online` flag.
// Used by the manager presence bar. Never throws; returns [] on error.
async function listForAgency(agencyId) {
  if (!agencyId) return [];
  try {
    const { data, error } = await supabase
      .from('agent_presence')
      .select('member_user_id, display_name, status, busy, busy_client_id, call_delivery, agent_phone, last_seen')
      .eq('agency_id', agencyId);
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
      online: !!r.last_seen && Date.parse(r.last_seen) >= cutoff,
    }));
  } catch { return []; }
}

// The agents who can take THIS caller right now: online, available (not away),
// not already busy, AND assigned to this business. Assignment lives in
// team_members.assigned_client_ids (null = unrestricted). Returns a list ordered
// so browser-capable agents come first (a browser take-over is instant; a phone
// dial adds ring time), then least-recently-busy. Never throws; [] on error.
async function listAvailableForClient({ agencyId, clientId }) {
  if (!agencyId || !clientId) return [];
  try {
    // 1) Which staff are assigned to this client (active, not seat-disabled).
    const { data: members, error: mErr } = await supabase
      .from('team_members')
      .select('member_user_id, display_name, assigned_client_ids, call_delivery, agent_phone, status, seat_disabled_at')
      .eq('entity_type', 'agency')
      .eq('entity_id', agencyId);
    if (mErr || !Array.isArray(members)) return [];
    const assigned = members.filter((m) => {
      if (!m.member_user_id) return false;
      if (m.status === 'disabled' || m.seat_disabled_at) return false;
      // null assignment = unrestricted; an array must include this client.
      if (Array.isArray(m.assigned_client_ids)) return m.assigned_client_ids.includes(clientId);
      return true;
    });
    if (assigned.length === 0) return [];
    const byUser = new Map(assigned.map((m) => [m.member_user_id, m]));
    const ids = Array.from(byUser.keys());

    // 2) Of those, who is online + available (status). `busy` is advisory only
    // (it drives the presence-bar dot): a browser agent taking a call leaves the
    // /cc console for the live monitor, so they simply stop heartbeating and age
    // out of this list on their own - no stuck-busy to clean up. We still prefer
    // a non-busy agent, so busy ones sort last rather than being excluded.
    const { data: pres, error: pErr } = await supabase
      .from('agent_presence')
      .select('member_user_id, display_name, status, busy, call_delivery, agent_phone, last_seen')
      .eq('agency_id', agencyId)
      .in('member_user_id', ids)
      .eq('status', 'available')
      .gte('last_seen', onlineCutoffIso());
    if (pErr || !Array.isArray(pres)) return [];

    const out = pres.map((p) => {
      const m = byUser.get(p.member_user_id) || {};
      // Delivery + phone: trust team_members (the manager's saved setting) over
      // the presence snapshot, falling back to the snapshot then defaults.
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
    // A phone agent with no number on file cannot actually be dialed - drop them.
    const usable = out.filter((a) => a.callDelivery === 'browser' || !!a.agentPhone);
    // Free before busy, browser before phone (instant vs ring time), then by
    // lastSeen asc to spread the load a little.
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
  listForAgency,
  listAvailableForClient,
};
