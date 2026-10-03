// ============================================================================
// HQ SUPABASE CLIENT  (destination: src/lib/hq-supabase.js)
// ----------------------------------------------------------------------------
// A SECOND Supabase client, separate from lib/supabase.js, pointed at HQ's own
// project with a SERVER-SIDE service-role key. This is the only place the VAC
// backend talks to HQ. HQ's database is NOT migrated; the link is two env vars.
//
//   HQ_SUPABASE_URL               = HQ project URL
//   HQ_SUPABASE_SERVICE_ROLE_KEY  = HQ service-role key (server-side ONLY)
//
// Instantiation mirrors lib/supabase.js exactly. It is guarded so that if the
// env vars are not set yet (e.g. this file is deployed before the vars are
// added), requiring it can never crash the backend or the receptionist. Every
// op no-ops with a clear error until the client is configured.
//
// All writes go through hq-items.js builders so rows are byte-identical to
// app-created ones. updated_at is set by HQ's DB trigger, never by us.
// ============================================================================

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { HQ_USER_KEY } = require('./hq-items');

const HQ_URL = process.env.HQ_SUPABASE_URL;
const HQ_KEY = process.env.HQ_SUPABASE_SERVICE_ROLE_KEY;

// Only construct the client when both vars exist. createClient throws on a
// falsy URL, which would take down module load (and the whole server) on a
// deploy that lands before the vars are set. Guarding keeps the receptionist
// unaffected until HQ credentials are in the environment.
let hqSupabase = null;
if (HQ_URL && HQ_KEY) {
  hqSupabase = createClient(HQ_URL, HQ_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
} else {
  console.warn('⚠️ HQ Supabase not configured (HQ_SUPABASE_URL / HQ_SUPABASE_SERVICE_ROLE_KEY missing). HQ tools will no-op until set.');
}

function isReady() {
  return !!hqSupabase;
}

function notReady() {
  return { ok: false, error: 'HQ Supabase not configured' };
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------

// Upsert one or more hq_items rows (onConflict id), the same call HQ's own
// pushItem uses. Upsert (not insert) so a retried VAPI tool call is idempotent.
async function upsertItems(rows) {
  if (!hqSupabase) return notReady();
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return { ok: true, count: 0 };
  const { error } = await hqSupabase.from('hq_items').upsert(list, { onConflict: 'id' });
  if (error) {
    console.error('❌ HQ upsert failed:', error.message, error.details || '');
    return { ok: false, error: error.message };
  }
  return { ok: true, count: list.length };
}

// Convenience for a single row.
async function insertItem(row) {
  return upsertItems([row]);
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

// All non-deleted rows of a kind for Gibson.
async function listByKind(kind) {
  if (!hqSupabase) return [];
  const { data, error } = await hqSupabase
    .from('hq_items')
    .select('*')
    .eq('user_key', HQ_USER_KEY)
    .eq('kind', kind)
    .eq('deleted', false);
  if (error) { console.error(`❌ HQ listByKind(${kind}) failed:`, error.message); return []; }
  return (data || []).filter((r) => r && r.data && !r.data.del);
}

// Open (not done) movers, most recently created first. Returns lightweight
// objects the tools can speak from, plus the raw row for updates.
async function listOpenMovers() {
  const rows = await listByKind('mover');
  return rows
    .filter((r) => !r.data.done)
    .map((r) => ({
      id: r.id,
      text: r.data.text || '',
      venture: r.data.venture || '',
      ts: r.data.ts || 0,
      row: r,
    }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// Live venture names (kind='venture', data.name). Empty array if HQ has no
// venture rows yet, in which case callers fall back to the seeded list.
async function listVentures() {
  const rows = await listByKind('venture');
  return rows
    .map((r) => (r.data && (r.data.name || r.data.title)) || '')
    .filter((n) => n && String(n).trim());
}

// Live, non-archived goals (kind='goal'), most recent first. Returns the id
// and title so a spoken goal name can be fuzzy-matched when adding a step.
async function listGoals() {
  const rows = await listByKind('goal');
  return rows
    .filter((r) => !r.data.archived)
    .map((r) => ({ id: r.id, title: r.data.title || '', ts: r.data.created || r.data.ts || 0 }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// Rebuild HQ's occupiedRanges for a date server-side: every busy [start,end)
// block on that date from events (incl. recurring on the weekday), scheduled
// movers, and scheduled goal steps. Skips done items, all-day events, and
// items with no startHour. ignoreId lets a reschedule exclude itself.
async function getOccupiedRanges(dateStr, dow, ignoreId) {
  if (!hqSupabase) return [];
  const { data, error } = await hqSupabase
    .from('hq_items')
    .select('*')
    .eq('user_key', HQ_USER_KEY)
    .in('kind', ['event', 'mover', 'step'])
    .eq('deleted', false);
  if (error) { console.error('❌ HQ getOccupiedRanges failed:', error.message); return []; }

  const ranges = [];
  for (const r of data || []) {
    const d = r.data;
    if (!d || d.del) continue;
    if (ignoreId && r.id === ignoreId) continue;

    if (r.kind === 'event') {
      if (d.allDay || d.startHour == null) continue;
      const onDate = d.date === dateStr || (d.recurring && d.recurDay === dow);
      if (!onDate) continue;
      ranges.push([d.startHour, d.startHour + (d.duration || 1)]);
    } else {
      // mover or step: scheduled, not done, on this date
      if (d.done || d.date !== dateStr || d.startHour == null) continue;
      ranges.push([d.startHour, d.startHour + (d.duration || 1)]);
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// COMPLETE A TASK BY FUZZY TEXT
// ---------------------------------------------------------------------------

function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreMatch(query, text) {
  const q = normText(query);
  const t = normText(text);
  if (!q || !t) return 0;
  if (t === q) return 1.0;
  if (t.includes(q)) return 0.9;
  if (q.includes(t)) return 0.85;
  const a = new Set(q.split(' ').filter(Boolean));
  const b = new Set(t.split(' ').filter(Boolean));
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  return (hits / Math.max(a.size, 1)) * 0.8;
}

// Fuzzy-match an open mover by spoken text and mark it done. Sets
// data.done=true, data.doneTs=now, bumps data.mtime, leaves data.ts and
// deleted alone (done is not delete). Returns the matched task or null.
async function completeMoverByFuzzy(query) {
  const open = await listOpenMovers();
  if (open.length === 0) return { matched: null, reason: 'no_open_tasks' };

  let best = null;
  let bestScore = 0;
  for (const m of open) {
    const s = scoreMatch(query, m.text);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  if (!best || bestScore < 0.5) return { matched: null, reason: 'no_match' };

  const now = Date.now();
  const updated = { ...best.row, data: { ...best.row.data, done: true, doneTs: now, mtime: now } };
  const res = await upsertItems([updated]);
  if (!res.ok) return { matched: null, reason: 'write_failed', error: res.error };
  return { matched: { id: best.id, text: best.text, venture: best.venture } };
}

module.exports = {
  hqSupabase,
  isReady,
  upsertItems,
  insertItem,
  listByKind,
  listOpenMovers,
  listVentures,
  listGoals,
  getOccupiedRanges,
  completeMoverByFuzzy,
};