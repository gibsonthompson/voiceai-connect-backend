// ============================================================================
// SMS OPT-OUT STORE
// ----------------------------------------------------------------------------
// A STOP (or STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT) is a carrier-enforced opt-out:
// once someone sends it, the carrier blocks ALL further A2P texts from that
// brand to that number, transactional ones included, until they text START. The
// carrier (Telnyx messaging profile, or an agency's Twilio) is the source of
// truth for enforcement. This table mirrors that state on our side for two
// reasons: so our own send path can skip a guaranteed-to-fail send, and so the
// dashboard can show WHY an owner stopped getting call notifications.
//
// Scope: NULL agency_id = platform-wide (the shared Telnyx messaging profile
// every platform number sends on, so an opt-out there applies brand-wide). A
// non-null agency_id scopes the opt-out to one agency's own BYOT (Twilio) brand.
//
// Every function fails OPEN (never throws, never blocks a send on a lookup
// error): a DB hiccup must not stop real notifications, and the carrier is the
// backstop that actually enforces the opt-out regardless.
// ============================================================================

const { supabase } = require('./supabase');

// Normalize to E.164 by digit count (same rule sendTelnyxSMS uses), so a number
// stored as "(908) 940-1491" matches one stored as "+19089401491".
function normE164(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
}

// True when (phone, scope) has an ACTIVE opt-out (a row with resubscribed_at
// still null). agencyId null = platform scope.
async function isOptedOut(phone, agencyId = null) {
  const p = normE164(phone);
  if (!p) return false;
  try {
    let q = supabase.from('sms_opt_outs').select('id').eq('phone', p).is('resubscribed_at', null).limit(1);
    q = agencyId ? q.eq('agency_id', agencyId) : q.is('agency_id', null);
    const { data } = await q;
    return !!(data && data.length);
  } catch (e) { return false; }
}

// Full status for one (phone, scope), for the dashboard. opted_out reflects
// whether the opt-out is currently active.
async function getOptOut(phone, agencyId = null) {
  const p = normE164(phone);
  if (!p) return null;
  try {
    let q = supabase.from('sms_opt_outs').select('*').eq('phone', p).limit(1);
    q = agencyId ? q.eq('agency_id', agencyId) : q.is('agency_id', null);
    const { data } = await q;
    const row = data && data[0];
    if (!row) return null;
    return {
      phone: p,
      agency_id: row.agency_id,
      opted_out: !row.resubscribed_at,
      opted_out_at: row.opted_out_at,
      resubscribed_at: row.resubscribed_at,
      source: row.source,
      last_keyword: row.last_keyword,
    };
  } catch (e) { return null; }
}

// Record (or re-activate) an opt-out for (phone, scope). Idempotent.
async function recordOptOut(phone, { agencyId = null, source = 'inbound_keyword', keyword = null } = {}) {
  const p = normE164(phone);
  if (!p) return false;
  const now = new Date().toISOString();
  try {
    let sel = supabase.from('sms_opt_outs').select('id').eq('phone', p).limit(1);
    sel = agencyId ? sel.eq('agency_id', agencyId) : sel.is('agency_id', null);
    const { data: existing } = await sel;
    if (existing && existing.length) {
      await supabase.from('sms_opt_outs').update({ opted_out_at: now, resubscribed_at: null, source, last_keyword: keyword, updated_at: now }).eq('id', existing[0].id);
    } else {
      await supabase.from('sms_opt_outs').insert({ phone: p, agency_id: agencyId, opted_out_at: now, resubscribed_at: null, source, last_keyword: keyword, updated_at: now });
    }
    console.log(`📵 SMS opt-out recorded: ${p} (scope: ${agencyId || 'platform'}, via: ${keyword || source})`);
    return true;
  } catch (e) { console.warn('recordOptOut failed (non-blocking):', e.message); return false; }
}

// Clear an opt-out (START / UNSTOP / YES). Marks the row resubscribed rather
// than deleting it, so the opt-out history is preserved.
async function clearOptOut(phone, { agencyId = null, source = 'inbound_keyword' } = {}) {
  const p = normE164(phone);
  if (!p) return false;
  const now = new Date().toISOString();
  try {
    let sel = supabase.from('sms_opt_outs').select('id').eq('phone', p).is('resubscribed_at', null).limit(1);
    sel = agencyId ? sel.eq('agency_id', agencyId) : sel.is('agency_id', null);
    const { data: existing } = await sel;
    if (existing && existing.length) {
      await supabase.from('sms_opt_outs').update({ resubscribed_at: now, source, updated_at: now }).eq('id', existing[0].id);
      console.log(`📲 SMS opt-in (resubscribe): ${p} (scope: ${agencyId || 'platform'})`);
    }
    return true;
  } catch (e) { console.warn('clearOptOut failed (non-blocking):', e.message); return false; }
}

// Does a delivery-receipt error indicate a carrier opt-out? Used as the
// bulletproof fallback: even if the inbound STOP never reached our webhook, the
// first blocked outbound tells us. Covers Telnyx opt-out codes and Twilio 21610.
function errorIndicatesOptOut(detail, code) {
  const s = `${detail || ''} ${code || ''}`.toLowerCase();
  if (!s.trim()) return false;
  if (s.includes('opt') || s.includes('unsubscrib') || s.includes('stop message') || s.includes('blocked as spam due to opt')) return true;
  return ['40002', '40300', '40007', '21610'].some((c) => s.includes(c));
}

module.exports = { isOptedOut, getOptOut, recordOptOut, clearOptOut, errorIndicatesOptOut, normE164 };
