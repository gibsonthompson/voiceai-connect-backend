// ============================================================================
// ORPHAN TELNYX NUMBER SWEEP
// Location: scripts/sweep-orphan-telnyx-numbers.js
//
// Lists every phone number on your Telnyx account and releases the ones that
// are NOT in use. A number is KEPT if ANY of these are true:
//   1. It's a client number (clients.vapi_phone_number) — auto, from DB
//   2. It's an agency demo number (agencies.demo_phone_number) — auto, from DB
//   3. It was created within the last GRACE_DAYS days — auto, from Telnyx
//   4. It's in HARDCODED_KEEP — system numbers (SMS sender, CallBird demo)
// Everything else is an orphan (expired-trial numbers whose VAPI object was
// deleted but whose Telnyx rental was never released — billing ~$1-2/mo forever).
//
// USAGE:
//   node scripts/sweep-orphan-telnyx-numbers.js          (DRY RUN — lists only)
//   node scripts/sweep-orphan-telnyx-numbers.js --live    (actually releases)
//
// ALWAYS run the dry run first, read the list, THEN run --live.
// ============================================================================
require('dotenv').config();
const fetch = require('node-fetch');
const { supabase } = require('../src/lib/supabase');

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const LIVE = process.argv.includes('--live');

// Keep any number created within this many days, no matter what.
const GRACE_DAYS = 14;

function normalizeE164(p) {
  if (!p) return null;
  let n = String(p).trim();
  if (n.startsWith('+')) return n;
  const d = n.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return `+${d}`;
}

// -- Numbers that must NEVER be released -------------------------------------
// Standalone system numbers that are NOT stored as a client or agency-demo
// number in the DB. Add any future system numbers here.
const HARDCODED_KEEP = [
  '+15055945806',   // CallBird demo line
  '+15058332344',   // Platform SMS sender number
];

const PROTECTED_NUMBERS = new Set(HARDCODED_KEEP.map(normalizeE164));

async function listAllTelnyxNumbers() {
  const numbers = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await fetch(
      `https://api.telnyx.com/v2/phone_numbers?page[number]=${page}&page[size]=250`,
      { headers: { 'Authorization': `Bearer ${TELNYX_API_KEY}` } }
    );
    if (!res.ok) throw new Error(`Telnyx list failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    const data = await res.json();
    (data.data || []).forEach(r => numbers.push({
      id: r.id,
      phone_number: r.phone_number,
      created_at: r.created_at || r.purchased_at || null,
    }));
    totalPages = data.meta?.total_pages || 1;
    page++;
  } while (page <= totalPages);
  return numbers;
}

async function buildInUseSet() {
  const inUse = new Set();

  // Client numbers -- expired/cancelled clients have null vapi_phone_number,
  // so only live numbers come back here.
  const { data: clients, error: cErr } = await supabase
    .from('clients')
    .select('vapi_phone_number')
    .not('vapi_phone_number', 'is', null);
  if (cErr) throw new Error(`clients query failed: ${cErr.message}`);
  (clients || []).forEach(c => { const n = normalizeE164(c.vapi_phone_number); if (n) inUse.add(n); });

  // Agency demo numbers
  const { data: agencies, error: aErr } = await supabase
    .from('agencies')
    .select('demo_phone_number')
    .not('demo_phone_number', 'is', null);
  if (aErr) throw new Error(`agencies query failed: ${aErr.message}`);
  (agencies || []).forEach(a => { const n = normalizeE164(a.demo_phone_number); if (n) inUse.add(n); });

  return inUse;
}

function isWithinGrace(created_at, graceCutoffMs) {
  if (!created_at) return false; // unknown age -> not protected by grace
  const t = new Date(created_at).getTime();
  if (Number.isNaN(t)) return false;
  return t > graceCutoffMs;
}

async function releaseNumber(telnyxId) {
  const res = await fetch(`https://api.telnyx.com/v2/phone_numbers/${telnyxId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${TELNYX_API_KEY}` },
  });
  return res.ok || res.status === 404;
}

(async () => {
  if (!TELNYX_API_KEY) { console.error('TELNYX_API_KEY not set'); process.exit(1); }

  console.log(`\n=== Telnyx Orphan Sweep -- ${LIVE ? 'LIVE (will release)' : 'DRY RUN (no changes)'} ===\n`);

  const graceCutoffMs = Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000;

  const [allNumbers, inUse] = await Promise.all([listAllTelnyxNumbers(), buildInUseSet()]);

  let recentKept = 0;
  const orphans = [];

  for (const n of allNumbers) {
    const norm = normalizeE164(n.phone_number);
    if (inUse.has(norm)) continue;            // active client / agency demo
    if (PROTECTED_NUMBERS.has(norm)) continue; // system numbers
    if (isWithinGrace(n.created_at, graceCutoffMs)) { recentKept++; continue; } // < grace days old
    orphans.push(n);
  }

  console.log(`Telnyx account holds:                ${allNumbers.length} numbers`);
  console.log(`In use (active clients + demos):      ${inUse.size} numbers`);
  console.log(`Protected (system / hardcoded):       ${PROTECTED_NUMBERS.size} numbers`);
  console.log(`Kept -- created within ${GRACE_DAYS} days:      ${recentKept} numbers\n`);

  if (orphans.length === 0) {
    console.log('No orphans found. Nothing to release.');
    process.exit(0);
  }

  console.log(`Found ${orphans.length} orphaned numbers:\n`);
  orphans.forEach(o => {
    const age = o.created_at ? `created ${o.created_at}` : 'created date unknown';
    console.log(`   ${o.phone_number}  (${o.id})  ${age}`);
  });

  console.log(`\nEstimated monthly savings: ~$${orphans.length}.00 - $${orphans.length * 2}.00 (at $1-2/number/mo)\n`);

  if (!LIVE) {
    console.log('DRY RUN -- nothing was released. Re-run with --live to release these.');
    process.exit(0);
  }

  let released = 0, failed = 0;
  for (const o of orphans) {
    const ok = await releaseNumber(o.id);
    if (ok) { released++; console.log(`Released ${o.phone_number}`); }
    else { failed++; console.error(`Failed   ${o.phone_number}`); }
    await new Promise(r => setTimeout(r, 250)); // gentle on rate limits
  }

  console.log(`\n=== Done -- released ${released}, failed ${failed} ===`);
  process.exit(0);
})().catch(err => { console.error('Sweep crashed:', err.message); process.exit(1); });