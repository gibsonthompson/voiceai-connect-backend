// ============================================================================
// NUMBER AUDIT (READ ONLY) - reconcile VAPI + Telnyx numbers vs the database
// ----------------------------------------------------------------------------
// Answers three questions with real data instead of guesswork:
//   1. What is VAPI actually billing you for? (vapi-provider numbers cost money;
//      imported telnyx/byo numbers do not.)
//   2. How many Telnyx numbers are you renting, and how many belong to a client
//      or demo that is no longer active? (those are pure waste.)
//   3. Is any single number billed on BOTH VAPI (as a vapi-provider number) and
//      Telnyx at the same time? (that is the only true "double charge".)
//
// It DELETES NOTHING. Run it, read the report, then decide what to release.
//
// Run from the backend repo root (reads .env automatically, no env pasting):
//     node audit-numbers.js
// ============================================================================

require('dotenv').config();

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

let supabase;
try {
  ({ supabase } = require('./src/lib/supabase'));
} catch (e) {
  try { ({ supabase } = require('./lib/supabase')); }
  catch (e2) { console.error('Could not load supabase client from ./src/lib/supabase or ./lib/supabase'); process.exit(1); }
}

// Node 18+ has global fetch; fall back to node-fetch if needed.
const fetchFn = (typeof fetch === 'function') ? fetch : require('node-fetch');

// ── helpers ─────────────────────────────────────────────────────────────
function e164(n) {
  if (!n) return null;
  let s = String(n).trim();
  if (s.startsWith('+')) return s;
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : null;
}

const ACTIVE_CLIENT_SUB = ['active', 'trialing', 'trial']; // still legitimately using a number
const DEAD_CLIENT_SUB = ['trial_expired', 'expired', 'canceled', 'cancelled', 'agency_canceled', 'past_due', 'unpaid'];

// ── fetch all VAPI numbers ──────────────────────────────────────────────
async function getVapiNumbers() {
  const out = [];
  try {
    const res = await fetchFn('https://api.vapi.ai/phone-number?limit=1000', {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
    });
    if (!res.ok) {
      console.error(`VAPI list failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return out;
    }
    const data = await res.json();
    const arr = Array.isArray(data) ? data : (data.results || data.data || []);
    for (const p of arr) {
      out.push({ id: p.id, number: e164(p.number), provider: p.provider || 'unknown', name: p.name || null });
    }
  } catch (e) {
    console.error('VAPI list error:', e.message);
  }
  return out;
}

// ── fetch all Telnyx numbers (paginated) ────────────────────────────────
async function getTelnyxNumbers() {
  const out = [];
  let page = 1;
  const size = 250;
  try {
    while (true) {
      const res = await fetchFn(
        `https://api.telnyx.com/v2/phone_numbers?page[number]=${page}&page[size]=${size}`,
        { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } }
      );
      if (!res.ok) {
        console.error(`Telnyx list failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
        break;
      }
      const body = await res.json();
      const data = body.data || [];
      for (const r of data) {
        out.push({ id: r.id, number: e164(r.phone_number), status: r.status || null });
      }
      const totalPages = body.meta?.total_pages || 1;
      if (page >= totalPages || data.length === 0) break;
      page += 1;
      if (page > 50) break; // hard safety cap
    }
  } catch (e) {
    console.error('Telnyx list error:', e.message);
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────
(async () => {
  if (!VAPI_API_KEY) { console.error('VAPI_API_KEY not set'); process.exit(1); }
  if (!TELNYX_API_KEY) { console.error('TELNYX_API_KEY not set'); process.exit(1); }

  console.log('Auditing numbers (read only)...\n');

  const [vapiNums, telnyxNums, clientsRes, agenciesRes] = await Promise.all([
    getVapiNumbers(),
    getTelnyxNumbers(),
    supabase.from('clients').select('id, business_name, subscription_status, status, vapi_phone_number, vapi_phone_id'),
    supabase.from('agencies').select('id, name, subscription_status, status, demo_phone_number, demo_vapi_phone_id'),
  ]);

  const clients = clientsRes.data || [];
  const agencies = agenciesRes.data || [];

  // Build a lookup: number -> owner {kind, label, active}
  const owner = new Map();
  for (const c of clients) {
    const n = e164(c.vapi_phone_number);
    if (!n) continue;
    const active = ACTIVE_CLIENT_SUB.includes(c.subscription_status) && c.status !== 'suspended' && c.status !== 'cancelled';
    owner.set(n, { kind: 'client', label: `${c.business_name} [${c.subscription_status}/${c.status}]`, active });
  }
  for (const a of agencies) {
    const n = e164(a.demo_phone_number);
    if (!n) continue;
    const active = !['canceled', 'cancelled'].includes(a.subscription_status) && a.status !== 'canceled';
    if (!owner.has(n)) owner.set(n, { kind: 'agency_demo', label: `DEMO ${a.name} [${a.subscription_status}/${a.status}]`, active });
  }

  // ── VAPI breakdown ────────────────────────────────────────────────────
  const byProvider = {};
  for (const p of vapiNums) byProvider[p.provider] = (byProvider[p.provider] || 0) + 1;

  console.log('==================================================================');
  console.log(` VAPI: ${vapiNums.length} phone objects`);
  console.log('==================================================================');
  for (const [prov, count] of Object.entries(byProvider)) {
    const paid = prov === 'vapi' ? '  <-- these COST money on VAPI' : '  (imported: free on VAPI, billed by carrier)';
    console.log(`  provider "${prov}": ${count}${paid}`);
  }

  // VAPI vapi-provider numbers that are orphaned/unknown = VAPI billing for nothing
  const vapiPaidOrphans = vapiNums.filter(p => p.provider === 'vapi').filter(p => {
    const o = p.number ? owner.get(p.number) : null;
    return !o || !o.active;
  });
  console.log(`\n  vapi-provider numbers with no active owner (VAPI billing for nothing): ${vapiPaidOrphans.length}`);
  vapiPaidOrphans.slice(0, 50).forEach(p => console.log(`    ${p.number || '(no number/SIP)'}  id=${p.id}  ${p.name || ''}`));

  // ── Telnyx breakdown ──────────────────────────────────────────────────
  console.log('\n==================================================================');
  console.log(` TELNYX: ${telnyxNums.length} numbers rented (each ~$1/mo)`);
  console.log('==================================================================');

  let inUse = 0, deadOwner = 0, noOwner = 0;
  const orphanList = [];
  for (const t of telnyxNums) {
    const o = t.number ? owner.get(t.number) : null;
    if (o && o.active) { inUse++; }
    else if (o && !o.active) { deadOwner++; orphanList.push({ number: t.number, why: o.label }); }
    else { noOwner++; orphanList.push({ number: t.number, why: 'no matching client/demo in DB' }); }
  }
  console.log(`  in use by an active client/demo:        ${inUse}`);
  console.log(`  owned by an EXPIRED/CANCELED client:    ${deadOwner}   <-- leaking`);
  console.log(`  no matching owner in the database:      ${noOwner}   <-- leaking`);
  console.log(`  estimated wasted spend: ~$${(deadOwner + noOwner).toFixed(0)}/mo\n`);
  orphanList.slice(0, 80).forEach(o => console.log(`    ${o.number}   ${o.why}`));
  if (orphanList.length > 80) console.log(`    ...and ${orphanList.length - 80} more`);

  // ── true double-charge check ──────────────────────────────────────────
  const telnyxSet = new Set(telnyxNums.map(t => t.number).filter(Boolean));
  const doubleBilled = vapiNums.filter(p => p.provider === 'vapi' && p.number && telnyxSet.has(p.number));
  console.log('\n==================================================================');
  console.log(' TRUE DOUBLE-BILLING CHECK (same number paid on BOTH VAPI and Telnyx)');
  console.log('==================================================================');
  if (doubleBilled.length === 0) {
    console.log('  None. No single number is a paid vapi-provider number AND a Telnyx rental.');
    console.log('  => Your VAPI and Telnyx charges are two separate pools, not a double charge.');
  } else {
    console.log(`  ${doubleBilled.length} number(s) billed on both:`);
    doubleBilled.forEach(p => console.log(`    ${p.number}  (VAPI id ${p.id})`));
  }

  // ── DB-side view of who holds numbers ─────────────────────────────────
  console.log('\n==================================================================');
  console.log(' DATABASE: clients holding a number, by status');
  console.log('==================================================================');
  const byStatus = {};
  for (const c of clients) {
    if (!c.vapi_phone_number) continue;
    const key = `${c.subscription_status}/${c.status}`;
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  console.log('\nDone. Nothing was deleted. Review the orphan lists above, then we can');
  console.log('release them safely in a separate step.');
  process.exit(0);
})();