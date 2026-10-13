#!/usr/bin/env node
/**
 * scripts/diagnose-concierge.js
 * ---------------------------------------------------------------------------
 * READ-ONLY diagnosis of the concierge / demo line (+1 404 671 9089, the number
 * on the marketing site). Buys nothing, deletes nothing, changes nothing — it
 * only READS from VAPI, Telnyx, and platform_settings and prints the truth so
 * we know exactly why the line says "service not available" and what the fix is.
 *
 * Run it FROM THE BACKEND FOLDER so the .env + node_modules resolve:
 *   node scripts/diagnose-concierge.js
 *
 * What it answers:
 *   1. Does a VAPI phone-number object still exist for this number? If so, is it
 *      still pointed at /webhook/vapi-concierge (the only thing that makes it
 *      answer), or did its routing drift / get cleared?
 *   2. Does the underlying Telnyx DID still exist on the account (i.e. are we
 *      still renting it), or was it released (a sweep / teardown)?
 *   3. What does platform_settings say vs. what the providers actually show?
 * ---------------------------------------------------------------------------
 */

try { require('dotenv').config(); } catch (e) {}

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || '(BACKEND_URL not set)';
const CONCIERGE_WEBHOOK = '/webhook/vapi-concierge';

// The number on the website. Last-10 is what we match on so a re-bought number
// is still recognised. app/page.tsx PLATFORM_DEMO_NUMBER = (404) 671-9089.
const CONCIERGE_LAST10 = (process.env.CONCIERGE_NUMBER_LAST10 || '4046719089').replace(/\D/g, '').slice(-10);

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const urlOf = (p) => (p && (p.serverUrl || (p.server && p.server.url))) || '(none)';

let supabase = null;
try { ({ supabase } = require('../src/lib/supabase')); } catch (e) {
  try { ({ supabase } = require('../lib/supabase')); } catch (e2) {}
}

async function vapiList() {
  if (!VAPI_API_KEY) return { error: 'VAPI_API_KEY not set' };
  const res = await fetch('https://api.vapi.ai/phone-number?limit=1000', {
    headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
  });
  if (!res.ok) return { error: `VAPI list HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}` };
  const data = await res.json();
  return { list: Array.isArray(data) ? data : (data.results || data.data || []) };
}

async function telnyxLookup(e164) {
  if (!TELNYX_API_KEY) return { error: 'TELNYX_API_KEY not set' };
  const res = await fetch(
    `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(e164)}`,
    { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } }
  );
  if (!res.ok) return { error: `Telnyx lookup HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}` };
  const body = await res.json();
  return { data: body.data || [] };
}

async function getSetting(key) {
  if (!supabase) return '(no supabase client)';
  try {
    const { data } = await supabase.from('platform_settings').select('value, updated_at').eq('key', key).maybeSingle();
    return data || '(not set)';
  } catch (e) { return `(read failed: ${e.message})`; }
}

(async () => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' CONCIERGE / DEMO LINE DIAGNOSIS  (read-only)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Expecting number ending ...${CONCIERGE_LAST10}`);
  console.log(` Concierge webhook: ${BACKEND_URL}${CONCIERGE_WEBHOOK}\n`);

  // ── platform_settings ───────────────────────────────────────────────
  console.log('── platform_settings ──────────────────────────────────────');
  console.log(' concierge_demo_number:', JSON.stringify(await getSetting('concierge_demo_number')));
  console.log('');

  // ── VAPI truth ──────────────────────────────────────────────────────
  console.log('── VAPI phone-number objects ───────────────────────────────');
  const v = await vapiList();
  if (v.error) {
    console.log(' ⚠️', v.error);
  } else {
    const match = v.list.filter((p) => last10(p.number) === CONCIERGE_LAST10);
    const pointed = v.list.filter((p) => urlOf(p).includes(CONCIERGE_WEBHOOK));
    if (match.length === 0) {
      console.log(` ❌ NO VAPI object for ...${CONCIERGE_LAST10}. VAPI cannot answer this number.`);
      console.log(`    → the VAPI phone object was deleted (swept) or never re-imported.`);
    } else {
      for (const p of match) {
        const ok = urlOf(p).includes(CONCIERGE_WEBHOOK);
        console.log(` ${ok ? '✅' : '⚠️ '} ${p.number}  id=${p.id}`);
        console.log(`      serverUrl : ${urlOf(p)}  ${ok ? '(correct)' : '(NOT the concierge webhook — line will not answer as concierge)'}`);
        console.log(`      assistantId: ${p.assistantId || '(null — dynamic/assistant-request, expected)'}`);
        console.log(`      provider  : ${p.provider || '?'}   status: ${p.status || '?'}`);
      }
    }
    if (pointed.length > match.length) {
      console.log(` ℹ️  ${pointed.length} total object(s) point at the concierge webhook (possible duplicates):`);
      for (const p of pointed) console.log(`      ${p.number}  id=${p.id}`);
    }
  }
  console.log('');

  // ── Telnyx truth ────────────────────────────────────────────────────
  console.log('── Telnyx DID (are we still renting it?) ───────────────────');
  const e164 = `+1${CONCIERGE_LAST10}`;
  const t = await telnyxLookup(e164);
  if (t.error) {
    console.log(' ⚠️', t.error);
  } else if (!t.data.length) {
    console.log(` ❌ ${e164} is NOT on the Telnyx account. The DID was released — it must be re-bought`);
    console.log(`    (and the website number may need to change if this exact DID is gone from inventory).`);
  } else {
    for (const d of t.data) {
      console.log(` ✅ ${d.phone_number}  telnyxId=${d.id}`);
      console.log(`      status          : ${d.status || '?'}`);
      console.log(`      connection_id   : ${d.connection_id || '(none)'}`);
      console.log(`      messaging_profile: ${d.messaging_profile_id || '(none)'}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' READING OF THE RESULT');
  console.log('───────────────────────────────────────────────────────────');
  console.log(' • VAPI object present + serverUrl = concierge webhook  → routing is fine; look elsewhere.');
  console.log(' • VAPI object present + wrong/empty serverUrl          → re-point it (cheap, keeps the number).');
  console.log(' • VAPI object MISSING but Telnyx DID present           → re-import into VAPI + point at webhook (keeps the number).');
  console.log(' • Telnyx DID MISSING                                   → DID was released; re-buy (website number may change).');
  console.log('═══════════════════════════════════════════════════════════\n');
  process.exit(0);
})().catch((e) => { console.error('\n❌ diagnose-concierge failed:', e.message, '\n'); process.exit(1); });