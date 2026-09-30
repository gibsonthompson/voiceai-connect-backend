// ============================================================================
// HQ ITEMS CONTRACT  (destination: src/lib/hq-items.js)
// ----------------------------------------------------------------------------
// Pure module. No env, no secrets, no network. Encodes HQ's exact item shapes
// so a phone-created row is byte-identical to an app-created one, plus the
// booking overlap logic and venture matching the Jarvis tools need.
//
// Every shape and constant here was verified against HQ's live source
// (gibsonthompson/hq, public/index.html): mid(), SHS/SHE, findFreeSlot,
// occupiedRanges, the normalizers, and the hq_items row wrapper
// { id, user_key:'gibson', kind, parent, deleted:!!data.del, data }.
//
// NOTE ON VENTURE: HQ's shipped normalizeNM does NOT carry a venture field, and
// HQ has no 'venture' kind yet. `venture` is written here per the build brief
// (additive jsonb key, defaults to '' = General, never invented). It persists
// in Supabase but is stripped by HQ the next time that task is edited in-app
// until HQ ships venture support. See the handoff brief.
// ============================================================================

'use strict';

// HQ calendar bounds, verified: var SHS=6,SHE=23
const SHS = 6;
const SHE = 23;
const HQ_USER_KEY = 'gibson';
const SLOT_STEP = 0.25; // 15 minutes, HQ's grid

// The canonical ventures the brief seeds, used ONLY as a fallback when no live
// venture rows exist in hq_items. General is the empty-string venture.
const SEEDED_VENTURES = [
  'VoiceAI Connect', 'ScopeBook', 'Southern Peach',
  'Splash Restoration', 'GTC', 'Blog Farm', 'JB Lawn',
];

// HQ's id generator, exact:
//   Date.now().toString(36) + Math.random().toString(36).slice(2,7)
function mid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Wrap an HQ item object in the hq_items row shape HQ itself writes (pushItem):
//   { id, user_key:'gibson', kind, parent, deleted:!!item.del, data:item }
// updated_at is intentionally omitted: the DB trigger hq_items_touch_trg sets it.
function toRow(kind, item, parent) {
  return {
    id: item.id,
    user_key: HQ_USER_KEY,
    kind,
    parent: parent != null ? parent : null,
    deleted: !!item.del,
    data: item,
  };
}

// ---------------------------------------------------------------------------
// ROW BUILDERS  (each returns a full hq_items row ready to upsert)
// Field sets match HQ's normalizers exactly. `venture` is the one additive key.
// ---------------------------------------------------------------------------

// mover (task). HQ normalizeNM fields: id,text,done,ts,pin,mtime,del,tags,
// doneTs,date,startHour,duration. venture added per brief.
function buildMover({ text, venture = '' } = {}) {
  const ts = Date.now();
  const data = {
    id: mid(),
    text: String(text || '').trim(),
    tags: [],
    venture: String(venture || ''),
    done: false,
    del: false,
    ts,
    pin: 0,
    mtime: ts,
    duration: 1,
    doneTs: null,
    date: null,
    startHour: null,
  };
  return toRow('mover', data, null);
}

// event. HQ normalizeEvents fields: id,date,startHour,duration,title,allDay,
// recurring,recurDay,notes,ts,mtime,del.
function buildEvent({ title, date, startHour, duration = 1, notes = '' } = {}) {
  const ts = Date.now();
  const data = {
    id: mid(),
    del: false,
    ts,
    mtime: ts,
    date, // "YYYY-MM-DD"
    startHour, // float, 24h (9.0, 9.25, 13.5)
    duration: Number(duration) || 1,
    title: String(title || '').trim(),
    allDay: false,
    recurring: false,
    recurDay: null,
    notes: String(notes || ''),
  };
  return toRow('event', data, null);
}

// reminder. HQ normalizeReminders fields: id,text,ts,mtime,del.
function buildReminder({ text } = {}) {
  const ts = Date.now();
  const data = { id: mid(), text: String(text || '').trim(), del: false, ts, mtime: ts };
  return toRow('reminder', data, null);
}

// note. HQ normalizeNotes fields: id,text,time,color,ts,mtime,del.
// HQ default color is #46d187.
function buildNote({ text, time = '', color = '#46d187' } = {}) {
  const ts = Date.now();
  const data = {
    id: mid(),
    text: String(text || '').trim(),
    del: false,
    ts,
    mtime: ts,
    time: String(time || ''),
    color: color || '#46d187',
  };
  return toRow('note', data, null);
}

// capture (inbox). HQ normalizeCaptures fields: id,text,ts,mtime,del.
function buildCapture({ text } = {}) {
  const ts = Date.now();
  const data = { id: mid(), text: String(text || '').trim(), del: false, ts, mtime: ts };
  return toRow('capture', data, null);
}

// ---------------------------------------------------------------------------
// BOOKING  (ported exactly from HQ findFreeSlot)
// ---------------------------------------------------------------------------

// Exact port of HQ's findFreeSlot. Returns the first start >= `start` where a
// `dur`-long block does not overlap any range, sliding to 15 min past the
// latest conflicting range end and re-checking. Refuses (null) if it would end
// after SHE+1 (i.e. past midnight, matching HQ's real guard s+dur>SHE+1).
// ranges = array of [start, end) floats.
function findFreeSlot(start, dur, ranges) {
  if (!isFinite(start) || !isFinite(dur) || dur <= 0) return null;
  let s = start;
  let guard = 0;
  const list = Array.isArray(ranges) ? ranges : [];
  while (guard++ < 400) {
    if (s + dur > SHE + 1) return null;
    let latestEnd = null;
    for (const r of list) {
      if (!r || !isFinite(r[0]) || !isFinite(r[1])) continue;
      if (s < r[1] && s + dur > r[0]) {
        if (latestEnd == null || r[1] > latestEnd) latestEnd = r[1];
      }
    }
    if (latestEnd == null) return s; // clear
    const nudged = latestEnd + SLOT_STEP;
    s = nudged > s ? nudged : s + SLOT_STEP;
  }
  return null;
}

// High-level booking resolver the tool speaks from. Mirrors HQ's addEvt guards:
// requested start must be within [SHS, SHE]; then findFreeSlot decides the real
// slot. Returns a spoken-ready result.
function resolveBooking(reqStart, dur, ranges) {
  const start = Number(reqStart);
  const d = Number(dur) || 1;
  if (!isFinite(start) || !isFinite(d) || d <= 0) {
    return { ok: false, reason: 'invalid', message: 'That is not a valid time or length.' };
  }
  if (start < SHS || start > SHE) {
    return {
      ok: false,
      reason: 'outside_hours',
      message: `That is outside the calendar hours (${fmtHour(SHS)} to ${fmtHour(SHE)}).`,
    };
  }
  const slot = findFreeSlot(start, d, ranges);
  if (slot == null) {
    return {
      ok: false,
      reason: 'no_slot',
      message: `No open slot that day before ${fmtHour(SHE + 1)}.`,
    };
  }
  const slid = Math.abs(slot - start) > 1e-9;
  return {
    ok: true,
    startHour: slot,
    slid,
    message: slid
      ? `${fmtHour(start)}'s taken, I put it at ${fmtHour(slot)}.`
      : `Booked ${fmtHour(slot)}.`,
  };
}

// Spoken hour format from an HQ float hour. 9 -> "9am", 9.25 -> "9:15am",
// 13.5 -> "1:30pm", 24 -> "12am".
function fmtHour(h) {
  if (!isFinite(h)) return '';
  let hh = Math.floor(h);
  const mins = Math.round((h - hh) * 60);
  const norm = ((hh % 24) + 24) % 24;
  const ampm = norm < 12 ? 'am' : 'pm';
  let disp = norm % 12;
  if (disp === 0) disp = 12;
  return mins === 0 ? `${disp}${ampm}` : `${disp}:${String(mins).padStart(2, '0')}${ampm}`;
}

// ---------------------------------------------------------------------------
// VENTURE MATCHING
// Map a spoken business name to a canonical venture NAME, or '' (General).
// Never invents a venture. `known` is the live list of venture names (from
// hq_items kind='venture' data.name); falls back to SEEDED_VENTURES if empty.
// ---------------------------------------------------------------------------

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function despace(s) {
  return norm(s).replace(/ /g, '');
}

function matchVenture(spoken, known) {
  const spokenNorm = norm(spoken);
  if (!spokenNorm) return '';
  const spokenTight = despace(spoken); // "voice ai connect" -> "voiceaiconnect"
  const list = (Array.isArray(known) && known.length ? known : SEEDED_VENTURES)
    .filter((n) => n && String(n).trim());

  // "general" / "none" / "no business" -> General explicitly.
  if (/^(general|none|no business|nothing|unassigned)$/.test(spokenNorm)) return '';

  let best = '';
  let bestScore = 0;
  for (const name of list) {
    const nameNorm = norm(name);
    if (!nameNorm) continue;
    const nameTight = despace(name);
    let score = 0;
    if (nameNorm === spokenNorm) score = 1.0;
    // Space-insensitive compare so "voice ai connect" matches "VoiceAI Connect"
    // and "southernpeach" matches "Southern Peach".
    else if (nameTight === spokenTight) score = 1.0;
    else if (nameNorm.startsWith(spokenNorm) || spokenNorm.startsWith(nameNorm)) score = 0.9;
    else if (nameTight.startsWith(spokenTight) || spokenTight.startsWith(nameTight)) score = 0.9;
    else if (nameNorm.includes(spokenNorm) || spokenNorm.includes(nameNorm)) score = 0.85;
    else if (nameTight.includes(spokenTight) || spokenTight.includes(nameTight)) score = 0.85;
    else {
      // token overlap (handles "peach" -> "Southern Peach", partial names)
      const a = new Set(spokenNorm.split(' ').filter(Boolean));
      const b = new Set(nameNorm.split(' ').filter(Boolean));
      let hits = 0;
      for (const t of a) if (b.has(t)) hits++;
      const denom = Math.max(a.size, 1);
      score = (hits / denom) * 0.75;
    }
    if (score > bestScore) { bestScore = score; best = name; }
  }
  // Threshold: below this we file to General rather than guess wrong.
  return bestScore >= 0.5 ? best : '';
}

module.exports = {
  SHS,
  SHE,
  SLOT_STEP,
  HQ_USER_KEY,
  SEEDED_VENTURES,
  mid,
  toRow,
  buildMover,
  buildEvent,
  buildReminder,
  buildNote,
  buildCapture,
  findFreeSlot,
  resolveBooking,
  fmtHour,
  matchVenture,
};
