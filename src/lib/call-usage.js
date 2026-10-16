// ============================================================================
// CALL USAGE, the single source of truth for "calls this month"
// ----------------------------------------------------------------------------
// There used to be two definitions of a client's monthly call count:
//   1. the client dashboard counted rows in the calls table for the calendar
//      month (accurate), and
//   2. everything else (agency dashboard, agency clients list, agency inbox
//      facts, admin, the call-limit gate) read the denormalized
//      clients.calls_this_month counter, which drifted badly (a client with 58
//      real calls showed 2).
// That split is why the same client read 58 in one place and 2 in another, and
// because the limit gate trusted the counter, the monthly cap was not really
// being enforced.
//
// This module computes the count live from the calls table, over one shared
// window (the current calendar month), so client / agency / admin / the gate
// all agree. The calls table is the source of truth; the counter is now only a
// best-effort cache that self-heals on the next call (the webhook increments it
// off this same live number).
// ============================================================================

const { supabase } = require('./supabase');

// Start of the current calendar month, in the server's timezone (UTC in
// production), matching the client dashboard's long-standing definition.
function monthStartISO(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString();
}

// Live count of calls for ONE client since `since` (defaults to month start).
// Uses a HEAD count so no rows are transferred.
async function callsThisMonthForClient(clientId, since = monthStartISO()) {
  if (!clientId) return 0;
  try {
    const { count, error } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .gte('created_at', since);
    if (error) throw error;
    return count || 0;
  } catch (e) {
    console.warn('callsThisMonthForClient failed:', e.message);
    return 0;
  }
}

// Live counts for MANY clients in one round trip. Returns a plain object
// { [clientId]: count } with an entry (0) for every id asked for. Prefers the
// client_calls_since RPC (one GROUP BY); if that is unavailable, falls back to
// a single bounded select tallied in JS, so a missing migration never breaks a
// dashboard.
async function callsThisMonthForClients(clientIds, since = monthStartISO()) {
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  const out = {};
  for (const id of ids) out[id] = 0;
  if (!ids.length) return out;

  try {
    const { data, error } = await supabase.rpc('client_calls_since', { p_client_ids: ids, p_since: since });
    if (error) throw error;
    for (const r of (data || [])) out[r.client_id] = Number(r.n) || 0;
    return out;
  } catch (e) {
    try {
      const { data } = await supabase
        .from('calls')
        .select('client_id')
        .in('client_id', ids)
        .gte('created_at', since);
      for (const row of (data || [])) out[row.client_id] = (out[row.client_id] || 0) + 1;
    } catch (e2) {
      console.warn('callsThisMonthForClients fallback failed:', e2.message);
    }
    return out;
  }
}

module.exports = { monthStartISO, callsThisMonthForClient, callsThisMonthForClients };
