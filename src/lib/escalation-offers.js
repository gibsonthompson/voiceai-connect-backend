// ============================================================================
// src/lib/escalation-offers.js
//
// The escalation offer registry. When the AI asks for a human on a call-center
// business, the call path creates an offer here and fans it out to the assigned,
// available agents (via agent-channel). The first agent to claim wins through a
// conditional UPDATE (status 'open' -> 'claimed'), which is atomic across every
// backend instance - two agents clicking "take over" at the same moment can
// never both win.
//
// Backed by the escalation_offers table (service key). Every function is
// best-effort and swallows its errors: a registry hiccup must never throw into a
// live call. A failed create returns null, which the caller treats as "could not
// offer" and falls back to the existing owner/transfer dial.
// ============================================================================

const { supabase } = require('./supabase');

// How long an offer stays live before it expires itself. Must comfortably fit
// inside the transfer wait window on the call path so the caller is handed back
// to the AI cleanly if nobody takes it.
const OFFER_TTL_MS = parseInt(process.env.ESCALATION_OFFER_TTL_MS || '', 10) || 25000;

async function createOffer({
  agencyId, clientId, sessionId, vapiCallId, callerNumber,
  businessName, reason, summary, collected, offeredTo,
}) {
  if (!agencyId || !clientId) return null;
  try {
    const now = Date.now();
    const row = {
      agency_id: agencyId,
      client_id: clientId,
      session_id: sessionId || null,
      vapi_call_id: vapiCallId || null,
      caller_number: callerNumber || null,
      business_name: businessName || null,
      reason: reason || null,
      summary: summary || null,
      collected: collected || null,
      status: 'open',
      offered_to: Array.isArray(offeredTo) ? offeredTo : null,
      expires_at: new Date(now + OFFER_TTL_MS).toISOString(),
    };
    const { data, error } = await supabase
      .from('escalation_offers')
      .insert(row)
      .select()
      .single();
    if (error) { console.warn('escalation-offers: create failed:', error.message); return null; }
    return data;
  } catch (e) {
    console.warn('escalation-offers: create error:', e.message);
    return null;
  }
}

async function getOffer(id) {
  if (!id) return null;
  try {
    const { data } = await supabase.from('escalation_offers').select('*').eq('id', id).maybeSingle();
    return data || null;
  } catch { return null; }
}

// Atomic claim: flips open -> claimed only if still open. Returns the claimed
// offer when THIS agent won, or null when it was already claimed/closed (the
// loser). Safe to call from any instance.
async function claimOffer(id, { memberUserId, displayName, callDelivery }) {
  if (!id || !memberUserId) return null;
  try {
    const { data, error } = await supabase
      .from('escalation_offers')
      .update({
        status: 'claimed',
        claimed_by: memberUserId,
        claimed_name: displayName || null,
        claimed_delivery: callDelivery === 'phone' ? 'phone' : 'browser',
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'open')
      .select()
      .maybeSingle();
    if (error) { console.warn('escalation-offers: claim failed:', error.message); return null; }
    return data || null; // null => lost the race (or no longer open)
  } catch (e) {
    console.warn('escalation-offers: claim error:', e.message);
    return null;
  }
}

// Move an offer to a terminal (or back-to-open) state. Used for connected /
// expired / cancelled / no_agents, and to re-open if a claimer bails before
// taking the call.
async function resolveOffer(id, status, extra) {
  if (!id || !status) return false;
  try {
    const patch = { status, ...(extra || {}) };
    if (status !== 'open') patch.resolved_at = new Date().toISOString();
    const { error } = await supabase.from('escalation_offers').update(patch).eq('id', id);
    return !error;
  } catch { return false; }
}

// Open offers addressed to this agent that have not expired - so an agent whose
// stream (re)connects mid-offer immediately sees the pop.
async function listOpenForAgent({ agencyId, memberUserId }) {
  if (!agencyId || !memberUserId) return [];
  try {
    const { data } = await supabase
      .from('escalation_offers')
      .select('*')
      .eq('agency_id', agencyId)
      .eq('status', 'open')
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(10);
    if (!Array.isArray(data)) return [];
    return data.filter((o) => !Array.isArray(o.offered_to) || o.offered_to.includes(memberUserId));
  } catch { return []; }
}

module.exports = { OFFER_TTL_MS, createOffer, getOffer, claimOffer, resolveOffer, listOpenForAgent };
