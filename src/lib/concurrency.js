// ============================================================================
// CONCURRENCY CONTROL PLANE - active-call registry + reservation gate
// Destination: src/lib/concurrency.js
//
// Tracks every in-flight call in the active_calls table so the live floor and
// fleet-capacity views can read real counts, and enforces a per-account
// (agency) simultaneous-call limit at admission time.
//
// The reservation is atomic and self-healing: try_reserve_line() takes a
// per-agency advisory lock, sweeps stale rows, counts live rows, and inserts
// in one transaction (see the SQL migration active_calls-setup.sql for the
// table + function).
//
// Design notes:
//  - A row is ALWAYS recorded for an admitted call, even for accounts with no
//    limit (concurrent_lines NULL), so dashboard counts are complete.
//  - The gate FAILS OPEN: if the registry is unreachable the caller is admitted,
//    never blocked by our own infrastructure failing.
//  - Heartbeat (touchLine) is refreshed by the webhook on transcript/status
//    events; release (releaseLine) runs on the end-of-call report. A missed end
//    event self-heals because try_reserve_line sweeps rows whose last_seen is
//    older than STALE_SECONDS.
// ============================================================================
const { supabase } = require('./supabase');

// Longest a call can plausibly run. A row older than this with no heartbeat is
// treated as dead and swept, so a dropped end-of-call event cannot permanently
// hold a line. Override with CONCURRENCY_STALE_SECONDS.
const STALE_SECONDS = parseInt(process.env.CONCURRENCY_STALE_SECONDS || '', 10) || 1800; // 30 min

// Reserve a line for a call. Returns { admitted, active, limit }.
//  - limit null  -> unlimited; always admitted, still recorded.
//  - admitted false -> the account is at its simultaneous-call limit.
async function reserveLine({ agencyId, clientId, vapiCallId, limit }) {
  if (!vapiCallId) return { admitted: true, active: null, limit: null };
  const { data, error } = await supabase.rpc('try_reserve_line', {
    p_agency: agencyId || null,
    p_client: clientId || null,
    p_call: String(vapiCallId),
    p_limit: (limit == null ? null : Number(limit)),
    p_stale: STALE_SECONDS,
  });
  if (error) throw new Error(error.message);
  // A table-returning function comes back as an array of rows.
  const row = Array.isArray(data) ? data[0] : data;
  return {
    admitted: row ? row.admitted !== false : true,
    active: row ? row.active : null,
    limit: row ? row.lim : (limit == null ? null : Number(limit)),
  };
}

// Release a line when the call ends. Safe to call more than once.
async function releaseLine(vapiCallId) {
  if (!vapiCallId) return;
  const { error } = await supabase
    .from('active_calls')
    .delete()
    .eq('vapi_call_id', String(vapiCallId));
  if (error) throw new Error(error.message);
}

// Heartbeat: refresh last_seen so a live call is never swept as stale.
async function touchLine(vapiCallId) {
  if (!vapiCallId) return;
  const { error } = await supabase
    .from('active_calls')
    .update({ last_seen: new Date().toISOString() })
    .eq('vapi_call_id', String(vapiCallId));
  if (error) throw new Error(error.message);
}

// Live active-call count for an agency (excluding stale rows) plus its limit.
// For the live floor and fleet-capacity views.
async function getAgencyCapacity(agencyId, limit) {
  const since = new Date(Date.now() - STALE_SECONDS * 1000).toISOString();
  const { count, error } = await supabase
    .from('active_calls')
    .select('vapi_call_id', { count: 'exact', head: true })
    .eq('agency_id', agencyId)
    .gt('last_seen', since);
  if (error) throw new Error(error.message);
  return { active: count || 0, limit: (limit == null ? null : Number(limit)) };
}

module.exports = { reserveLine, releaseLine, touchLine, getAgencyCapacity, STALE_SECONDS };