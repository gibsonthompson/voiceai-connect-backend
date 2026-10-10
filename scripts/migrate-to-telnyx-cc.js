// ============================================================================
// scripts/migrate-to-telnyx-cc.js
// Production rollout tool: move clients onto the own-the-call warm transfer
// engine (voice_routing = 'telnyx_cc'). One client, a whole agency, or every
// eligible client. Idempotent, with a dry-run and an auto-written rollback file.
//
//   node scripts/migrate-to-telnyx-cc.js --client <clientId>
//   node scripts/migrate-to-telnyx-cc.js --agency <agencyId>
//   node scripts/migrate-to-telnyx-cc.js --all
//     flags: --dry-run        show what would change, touch nothing
//            --skip-test      skip is_test_client rows
//            --delay <ms>     pause between clients (default 300)
//
//   Rollback (uses the file written by a run):
//   node scripts/migrate-to-telnyx-cc.js --revert-file telnyx_cc_rollback_<ts>.json
//   node scripts/migrate-to-telnyx-cc.js --revert <clientId> <oldConnectionId>
//
// What a forward migration does per client, and ONLY this:
//   1. ensureWhisperInfra() -> the shared Call Control connection id.
//   2. Points the client's own Telnyx number at that Call Control app, so
//      inbound hits /webhook/telnyx-voice (number stays on Telnyx; SMS intact).
//   3. Sets clients.voice_routing = 'telnyx_cc'.
// It never releases a number and never deletes anything. The old VAPI import (if
// any) simply stops receiving calls, because Telnyx now routes inbound to Call
// Control. Each client's previous Telnyx connection_id is saved to the rollback
// file so a run can be fully undone.
//
// Run on the backend (TELNYX_API_KEY, VAPI_API_KEY, Supabase env present), e.g.
// the DigitalOcean app console, or locally with those envs.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { supabase } = require(path.join(__dirname, '..', 'src', 'lib', 'supabase'));
const { ensureWhisperInfra, pointNumberAtCallControl } = require(path.join(__dirname, '..', 'src', 'lib', 'vapi'));

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] || null) : null;
}
function has(flag) { return process.argv.indexOf(flag) !== -1; }

function toE164(phone) {
  if (!phone) return null;
  const s = String(phone).trim();
  if (s.startsWith('+') && s.length >= 11) return s;
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

async function getTelnyxConnectionId(e164) {
  if (!TELNYX_API_KEY || !e164) return null;
  try {
    const res = await fetch(
      `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(e164)}`,
      { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } }
    );
    if (!res.ok) return null;
    const record = ((await res.json()).data || [])[0];
    return record ? (record.connection_id || null) : null;
  } catch { return null; }
}

async function setTelnyxConnectionId(e164, connectionId) {
  const res = await fetch(
    `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(e164)}`,
    { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Telnyx lookup failed: HTTP ${res.status}`);
  const record = ((await res.json()).data || [])[0];
  if (!record) throw new Error(`Telnyx number ${e164} not found on account`);
  const patch = await fetch(`https://api.telnyx.com/v2/phone_numbers/${record.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection_id: connectionId }),
  });
  if (!patch.ok) throw new Error(`Telnyx connection assign failed: HTTP ${patch.status}`);
  return record.id;
}

// Select the set of clients to act on.
async function selectClients() {
  const clientId = arg('--client') || (!process.argv[2]?.startsWith('-') ? process.argv[2] : null);
  const agencyId = arg('--agency');
  const cols = 'id, business_name, vapi_phone_number, voice_routing, agency_id, is_test_client';

  let q = supabase.from('clients').select(cols);
  if (clientId) q = q.eq('id', clientId);
  else if (agencyId) q = q.eq('agency_id', agencyId);
  else if (has('--all')) { /* no filter */ }
  else return { error: 'Specify --client <id>, --agency <id>, or --all.' };

  const { data, error } = await q;
  if (error) return { error: error.message };
  return { clients: data || [] };
}

async function revertFromFile(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));
  console.log(`Reverting ${rows.length} client(s) from ${file} ...`);
  for (const r of rows) {
    try {
      if (r.oldConnectionId) await setTelnyxConnectionId(r.number, r.oldConnectionId);
      await supabase.from('clients').update({ voice_routing: 'vapi_direct' }).eq('id', r.clientId);
      console.log(`  reverted ${r.business_name || r.clientId} (${r.number}) -> ${r.oldConnectionId || '(no conn saved)'}`);
    } catch (e) {
      console.error(`  FAILED revert ${r.clientId}: ${e.message}`);
    }
    await sleep(250);
  }
  console.log('Revert done.');
}

async function main() {
  // Single explicit revert
  if (has('--revert')) {
    const i = process.argv.indexOf('--revert');
    const clientId = process.argv[i + 1];
    const oldConn = process.argv[i + 2];
    if (!clientId || !oldConn) { console.error('Usage: --revert <clientId> <oldConnectionId>'); process.exit(1); }
    const { data: c } = await supabase.from('clients').select('vapi_phone_number').eq('id', clientId).single();
    const number = toE164(c && c.vapi_phone_number);
    if (number) await setTelnyxConnectionId(number, oldConn);
    await supabase.from('clients').update({ voice_routing: 'vapi_direct' }).eq('id', clientId);
    console.log(`Reverted ${clientId} -> ${oldConn}`);
    process.exit(0);
  }

  // Batch revert from a file
  const revertFile = arg('--revert-file');
  if (revertFile) { await revertFromFile(revertFile); process.exit(0); }

  const dryRun = has('--dry-run');
  const skipTest = has('--skip-test');
  const delay = Number(arg('--delay') || 300);

  const sel = await selectClients();
  if (sel.error) { console.error(sel.error); process.exit(1); }
  let clients = sel.clients;
  if (skipTest) clients = clients.filter((c) => !c.is_test_client);

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Candidates: ${clients.length}`);

  // ensure infra once (skipped on dry run)
  let connectionId = null;
  if (!dryRun) {
    const infra = await ensureWhisperInfra();
    connectionId = infra.connectionId;
    console.log(`Call Control connection id: ${connectionId}`);
  }

  const rollback = [];
  let migrated = 0, skipped = 0, failed = 0;

  for (const c of clients) {
    const number = toE164(c.vapi_phone_number);
    if (c.voice_routing === 'telnyx_cc') { console.log(`  skip (already telnyx_cc): ${c.business_name}`); skipped++; continue; }
    if (!number) { console.log(`  skip (no vapi_phone_number): ${c.business_name}`); skipped++; continue; }

    if (dryRun) { console.log(`  would migrate: ${c.business_name} (${number})`); migrated++; continue; }

    try {
      const oldConn = await getTelnyxConnectionId(number);
      await pointNumberAtCallControl(number, connectionId);
      const { error: updErr } = await supabase.from('clients').update({ voice_routing: 'telnyx_cc' }).eq('id', c.id);
      if (updErr) throw new Error(updErr.message);
      rollback.push({ clientId: c.id, business_name: c.business_name, number, oldConnectionId: oldConn });
      console.log(`  migrated: ${c.business_name} (${number}) [old conn ${oldConn || 'none'}]`);
      migrated++;
    } catch (e) {
      console.error(`  FAILED: ${c.business_name} (${number}): ${e.message}`);
      failed++;
    }
    await sleep(delay);
  }

  if (!dryRun && rollback.length) {
    const file = path.join(process.cwd(), `telnyx_cc_rollback_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(rollback, null, 2));
    console.log(`\nRollback file written: ${file}`);
    console.log(`Undo this batch with:\n  node scripts/migrate-to-telnyx-cc.js --revert-file ${file}`);
  }

  console.log(`\nSummary: migrated=${migrated} skipped=${skipped} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
