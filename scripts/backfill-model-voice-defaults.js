// ============================================================================
// scripts/backfill-model-voice-defaults.js
// Put the whole fleet on the current defaults: LLM gpt-4.1, TTS
// eleven_flash_v2_5. Live calls read clients.llm_model / clients.tts_model, so
// setting those is what actually moves existing clients onto the new stack
// (new clients already inherit the defaults from the dynamic builder).
//
//   node scripts/backfill-model-voice-defaults.js --all
//   node scripts/backfill-model-voice-defaults.js --client <clientId>
//   node scripts/backfill-model-voice-defaults.js --agency <agencyId>
//     flags:
//       --dry-run      show what would change, touch nothing
//       --skip-test    skip is_test_client rows
//       --templates    ALSO set agency_prompt_templates.model / .tts_model
//       --patch-vapi   ALSO PATCH each client's STATIC VAPI assistant (the one
//                      used by AI Lab test calls and as a fallback), merging the
//                      new model + voice model into the live assistant so test
//                      calls match live calls. Off by default (a VAPI API loop).
//       --delay <ms>   pause between VAPI PATCHes (default 250)
//
//   Rollback a run (restores clients, templates, and VAPI assistants it touched):
//   node scripts/backfill-model-voice-defaults.js --revert-file model_backfill_rollback_<ts>.json
//
// Why both a DB write and a VAPI PATCH:
//   - clients.llm_model / tts_model  -> what buildDynamicAssistantConfig reads
//     on every LIVE call. This is the one that matters for production calls.
//   - the static VAPI assistant      -> only used by AI Lab "Start Test Call"
//     and as a fallback if an assistant-request ever fails. Patching it keeps
//     test calls sounding identical to live. The PATCH does a READ-then-merge
//     so it only changes model.model and voice.model and never drops the
//     assistant's prompt, tools, voiceId, or other voice settings.
//
// Run on the backend (Supabase env + VAPI_API_KEY present), e.g. the
// DigitalOcean app console.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { supabase } = require(path.join(__dirname, '..', 'src', 'lib', 'supabase'));

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_API_BASE = 'https://api.vapi.ai';

// The fleet defaults. Keep in step with assistant-config-builder DEFAULT_LLM_MODEL
// and ELEVENLABS_TTS_MODEL.
const TARGET_LLM = 'gpt-4.1';
const TARGET_TTS = 'eleven_flash_v2_5';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function arg(flag) { const i = process.argv.indexOf(flag); return i !== -1 ? (process.argv[i + 1] || null) : null; }
function has(flag) { return process.argv.indexOf(flag) !== -1; }

const DRY = has('--dry-run');
const SKIP_TEST = has('--skip-test');
const DO_TEMPLATES = has('--templates');
const DO_VAPI = has('--patch-vapi');
const DELAY = parseInt(arg('--delay') || '250', 10);

// ---------------------------------------------------------------------------
// VAPI helpers (read-then-merge so we never clobber the assistant).
// ---------------------------------------------------------------------------
async function vapiGetAssistant(id) {
  const r = await fetch(`${VAPI_API_BASE}/assistant/${id}`, {
    headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
  });
  if (!r.ok) throw new Error(`GET assistant ${id} -> ${r.status}`);
  return r.json();
}

async function vapiPatchAssistant(id, body) {
  const r = await fetch(`${VAPI_API_BASE}/assistant/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH assistant ${id} -> ${r.status}: ${(await r.text().catch(() => '')).slice(0, 180)}`);
  return r.json();
}

// Patch only model.model + voice.model, preserving everything else. Returns the
// previous {model, voiceModel} for the rollback file, or null if skipped.
async function patchAssistantModelVoice(id) {
  const a = await vapiGetAssistant(id);
  const prev = { model: a.model && a.model.model, voiceModel: a.voice && a.voice.model };
  const nextModel = Object.assign({}, a.model || { provider: 'openai' }, { model: TARGET_LLM });
  const nextVoice = Object.assign({}, a.voice || { provider: '11labs' }, { model: TARGET_TTS });
  if (!DRY) await vapiPatchAssistant(id, { model: nextModel, voice: nextVoice });
  return prev;
}

// ---------------------------------------------------------------------------
// Forward backfill
// ---------------------------------------------------------------------------
async function run() {
  const clientId = arg('--client');
  const agencyId = arg('--agency');
  const all = has('--all');
  if (!clientId && !agencyId && !all) {
    console.error('Specify --client <id>, --agency <id>, or --all (optionally --dry-run).');
    process.exit(1);
  }
  if (DO_VAPI && !VAPI_API_KEY) {
    console.error('--patch-vapi needs VAPI_API_KEY in the environment.');
    process.exit(1);
  }

  let q = supabase.from('clients').select('id, business_name, is_test_client, llm_model, tts_model, vapi_assistant_id');
  if (clientId) q = q.eq('id', clientId);
  else if (agencyId) q = q.eq('agency_id', agencyId);
  const { data: clients, error } = await q;
  if (error) { console.error('Failed to load clients:', error.message); process.exit(1); }

  const rows = (clients || []).filter((c) => !(SKIP_TEST && c.is_test_client));
  console.log(`\n${DRY ? '[DRY RUN] ' : ''}Backfilling ${rows.length} client(s) to LLM=${TARGET_LLM}, TTS=${TARGET_TTS}${DO_VAPI ? ' (+ VAPI assistants)' : ''}${DO_TEMPLATES ? ' (+ agency templates)' : ''}\n`);

  const rollback = { ts: new Date().toISOString(), target: { llm: TARGET_LLM, tts: TARGET_TTS }, clients: [], templates: [] };
  let changed = 0, vapiPatched = 0, vapiFailed = 0;

  for (const c of rows) {
    const needsDb = c.llm_model !== TARGET_LLM || c.tts_model !== TARGET_TTS;
    const entry = { id: c.id, business_name: c.business_name, prev_llm_model: c.llm_model, prev_tts_model: c.tts_model };

    if (needsDb) {
      console.log(`  ${c.business_name}: llm ${c.llm_model || '(default)'} -> ${TARGET_LLM}, tts ${c.tts_model || '(default)'} -> ${TARGET_TTS}`);
      if (!DRY) {
        const { error: uerr } = await supabase.from('clients').update({ llm_model: TARGET_LLM, tts_model: TARGET_TTS }).eq('id', c.id);
        if (uerr) { console.error(`    ! DB update failed: ${uerr.message}`); continue; }
      }
      changed++;
    } else {
      console.log(`  ${c.business_name}: already on defaults`);
    }

    if (DO_VAPI && c.vapi_assistant_id) {
      try {
        const prev = await patchAssistantModelVoice(c.vapi_assistant_id);
        entry.vapi_assistant_id = c.vapi_assistant_id;
        entry.prev_vapi_model = prev.model;
        entry.prev_vapi_voice_model = prev.voiceModel;
        console.log(`    VAPI ${c.vapi_assistant_id}: model ${prev.model} -> ${TARGET_LLM}, voice ${prev.voiceModel} -> ${TARGET_TTS}`);
        vapiPatched++;
        if (DELAY) await sleep(DELAY);
      } catch (e) {
        console.error(`    ! VAPI patch failed for ${c.vapi_assistant_id}: ${e.message}`);
        vapiFailed++;
      }
    }

    rollback.clients.push(entry);
  }

  if (DO_TEMPLATES) {
    let tq = supabase.from('agency_prompt_templates').select('id, agency_id, industry, model, tts_model');
    if (agencyId) tq = tq.eq('agency_id', agencyId);
    const { data: tpls, error: terr } = await tq;
    if (terr) { console.error('Failed to load templates:', terr.message); }
    else {
      console.log(`\n${DRY ? '[DRY RUN] ' : ''}Templates: ${(tpls || []).length} row(s)`);
      for (const t of (tpls || [])) {
        if (t.model === TARGET_LLM && t.tts_model === TARGET_TTS) continue;
        rollback.templates.push({ id: t.id, industry: t.industry, prev_model: t.model, prev_tts_model: t.tts_model });
        console.log(`  template ${t.industry}: model ${t.model || '(none)'} -> ${TARGET_LLM}, tts ${t.tts_model || '(none)'} -> ${TARGET_TTS}`);
        if (!DRY) {
          const { error: uerr } = await supabase.from('agency_prompt_templates').update({ model: TARGET_LLM, tts_model: TARGET_TTS }).eq('id', t.id);
          if (uerr) console.error(`    ! template update failed: ${uerr.message}`);
        }
      }
    }
  }

  if (!DRY && (rollback.clients.length || rollback.templates.length)) {
    const file = path.join(process.cwd(), `model_backfill_rollback_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(rollback, null, 2));
    console.log(`\nRollback written: ${file}`);
  }

  console.log(`\n${DRY ? '[DRY RUN] ' : ''}Done. DB changed: ${changed}/${rows.length}. VAPI patched: ${vapiPatched}${vapiFailed ? `, failed: ${vapiFailed}` : ''}.`);
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------
async function revert() {
  const file = arg('--revert-file');
  if (!file || !fs.existsSync(file)) { console.error('Pass a valid --revert-file <path>.'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\nReverting ${data.clients.length} client(s), ${data.templates.length} template(s) from ${data.ts}\n`);

  for (const c of data.clients) {
    const { error } = await supabase.from('clients').update({ llm_model: c.prev_llm_model, tts_model: c.prev_tts_model }).eq('id', c.id);
    console.log(`  ${c.business_name}: llm -> ${c.prev_llm_model || '(null)'}, tts -> ${c.prev_tts_model || '(null)'}${error ? ` ! ${error.message}` : ''}`);
    if (c.vapi_assistant_id && VAPI_API_KEY) {
      try {
        const a = await vapiGetAssistant(c.vapi_assistant_id);
        const nextModel = Object.assign({}, a.model || {}, { model: c.prev_vapi_model });
        const nextVoice = Object.assign({}, a.voice || {}, { model: c.prev_vapi_voice_model });
        await vapiPatchAssistant(c.vapi_assistant_id, { model: nextModel, voice: nextVoice });
        console.log(`    VAPI ${c.vapi_assistant_id}: restored model ${c.prev_vapi_model}, voice ${c.prev_vapi_voice_model}`);
        if (DELAY) await sleep(DELAY);
      } catch (e) { console.error(`    ! VAPI revert failed: ${e.message}`); }
    }
  }
  for (const t of data.templates) {
    const { error } = await supabase.from('agency_prompt_templates').update({ model: t.prev_model, tts_model: t.prev_tts_model }).eq('id', t.id);
    console.log(`  template ${t.industry}: model -> ${t.prev_model || '(null)'}, tts -> ${t.prev_tts_model || '(null)'}${error ? ` ! ${error.message}` : ''}`);
  }
  console.log('\nRevert complete.');
}

(has('--revert-file') ? revert() : run()).catch((e) => { console.error(e); process.exit(1); });
