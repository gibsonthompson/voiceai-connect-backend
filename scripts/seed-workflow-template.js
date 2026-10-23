// ============================================================================
// SEED WORKFLOW TEMPLATE
//
// Creates a workflow for one agency from a starter template, publishes v1, and
// (with --active) turns it on. Use it to stand up the first real workflow for a
// headless end-to-end test before the canvas UI exists.
//
// Usage:
//   node scripts/seed-workflow-template.js <agencyIdOrSlug> <templateKey> [--active]
//
// templateKey one of: missed_call_followup | post_call_followup |
//                     appointment_confirmation | review_request
//
// Example (CallBird, missed-call follow-up, live):
//   node scripts/seed-workflow-template.js callbird missed_call_followup --active
//
// Safe to re-run: it will not duplicate a workflow that already has the same
// template_key for that agency (it reports and exits).
// ============================================================================

const { supabase } = require('../src/lib/supabase');
const { getTemplate } = require('../src/lib/workflow-templates');

async function resolveAgency(idOrSlug) {
  // Try id first, then slug.
  let { data } = await supabase.from('agencies').select('id, name, slug, plan_type').eq('id', idOrSlug).single();
  if (data) return data;
  ({ data } = await supabase.from('agencies').select('id, name, slug, plan_type').eq('slug', idOrSlug).single());
  return data || null;
}

async function main() {
  const [idOrSlug, templateKey] = process.argv.slice(2);
  const active = process.argv.includes('--active');

  if (!idOrSlug || !templateKey) {
    console.error('Usage: node scripts/seed-workflow-template.js <agencyIdOrSlug> <templateKey> [--active]');
    process.exit(1);
  }
  const tpl = getTemplate(templateKey);
  if (!tpl) {
    console.error(`Unknown template "${templateKey}". Known: missed_call_followup, post_call_followup, appointment_confirmation, review_request`);
    process.exit(1);
  }
  const agency = await resolveAgency(idOrSlug);
  if (!agency) {
    console.error(`No agency found for "${idOrSlug}" (tried id and slug).`);
    process.exit(1);
  }

  // Don't duplicate.
  const { data: existing } = await supabase
    .from('workflows').select('id, status')
    .eq('agency_id', agency.id).eq('template_key', tpl.key).limit(1);
  if (existing && existing.length) {
    console.log(`Workflow from "${tpl.key}" already exists for ${agency.name} (id ${existing[0].id}, status ${existing[0].status}). Nothing to do.`);
    process.exit(0);
  }

  // Create the workflow.
  const { data: wf, error: wfErr } = await supabase
    .from('workflows')
    .insert({
      agency_id: agency.id,
      name: tpl.name,
      description: tpl.description,
      status: active ? 'active' : 'draft',
      trigger_type: tpl.trigger_type,
      trigger_config: tpl.trigger_config || {},
      graph: tpl.graph,
      stop_on: tpl.stop_on || {},
      entry_rules: tpl.entry_rules || {},
      template_key: tpl.key,
      created_by: 'seed-script',
    })
    .select().single();
  if (wfErr) { console.error('Failed to create workflow:', wfErr.message); process.exit(1); }

  // Publish v1 (snapshot) and point the workflow at it.
  const { data: ver, error: verErr } = await supabase
    .from('workflow_versions')
    .insert({
      workflow_id: wf.id, agency_id: agency.id, version: 1,
      graph: tpl.graph, trigger_type: tpl.trigger_type, trigger_config: tpl.trigger_config || {},
      stop_on: tpl.stop_on || {}, entry_rules: tpl.entry_rules || {}, published_by: 'seed-script',
    })
    .select().single();
  if (verErr) { console.error('Failed to publish version:', verErr.message); process.exit(1); }

  await supabase.from('workflows').update({ live_version_id: ver.id, updated_at: new Date().toISOString() }).eq('id', wf.id);

  console.log('Seeded workflow:');
  console.log(`  agency:   ${agency.name} (${agency.id})`);
  console.log(`  workflow: ${wf.name} (${wf.id})`);
  console.log(`  trigger:  ${tpl.trigger_type}  config=${JSON.stringify(tpl.trigger_config || {})}`);
  console.log(`  version:  v1 (${ver.id})`);
  console.log(`  status:   ${active ? 'ACTIVE (live)' : 'draft (pass --active to turn on)'}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
