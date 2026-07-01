// ============================================================================
// AI SCOPE OF WORK  (IICRC S500 / S520)
// Two-pass generation from the claim's field data:
//   Pass 1 (Haiku)  drafts a room-by-room mitigation scope (cheap).
//   Pass 2 (Sonnet) refines it into carrier-ready structured JSON.
// Persists to resto_scopes. Requires ANTHROPIC_API_KEY + @anthropic-ai/sdk.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');
const { fetchClaimGraph } = require('./resto-report');

const DRAFT_MODEL = 'claude-haiku-4-5-20251001';
const FINAL_MODEL = 'claude-sonnet-4-6';

// Compact, model-friendly summary of everything documented on the claim.
function buildFieldSummary(graph) {
  const { claim, structures, rooms, notes, readings, chambers, dryStandards, sketches, moldScans, media } = graph;
  const lines = [];
  lines.push(`Loss type: ${claim.type_of_loss || 'unknown'}. Category ${claim.category_of_water ?? '-'}, Class ${claim.class_of_water ?? '-'}.`);
  if (claim.cat_code) lines.push(`CAT code: ${claim.cat_code}.`);

  for (const st of structures) {
    lines.push(`\nSTRUCTURE: ${st.name}`);
    const stRooms = rooms.filter((r) => r.structure_id === st.id);
    for (const room of stRooms) {
      lines.push(`  ROOM: ${room.name}`);
      notes.filter((n) => n.room_id === room.id).forEach((n) => n.body && lines.push(`    note: ${n.body}`));

      sketches.filter((s) => s.room_id === room.id).forEach((s) => {
        const cj = s.canvas_json || {};
        const mps = cj.moisturePoints || [];
        if (mps.length) lines.push(`    moisture readings: ${mps.map((m) => m.label).filter(Boolean).join(', ')}`);
        const eq = cj.equipment || [];
        if (eq.length) {
          const counts = eq.reduce((a, e) => { a[e.type] = (a[e.type] || 0) + 1; return a; }, {});
          lines.push(`    equipment placed: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
        }
        if ((cj.wetAreas || []).length) lines.push(`    wet area documented on moisture map`);
      });

      const roomMediaIds = (media || []).filter((m) => m.room_id === room.id).map((m) => m.id);
      (moldScans || []).filter((sc) => roomMediaIds.includes(sc.media_id)).forEach((sc) =>
        lines.push(`    mold screening: ${sc.verdict} (${sc.confidence ?? 0}%)${sc.recommend_lab_sampling ? ', lab sampling recommended' : ''}`));
    }

    chambers.filter((c) => c.structure_id === st.id).forEach((ch) => {
      lines.push(`  DRYING CHAMBER: ${ch.name} - ${ch.length_ft ?? '?'}x${ch.width_ft ?? '?'}x${ch.height_ft ?? 8} ft, Class ${ch.class_of_loss ?? '-'}`);
      dryStandards.filter((d) => d.chamber_id === ch.id).forEach((d) => lines.push(`    dry standard: ${d.material} = ${d.goal_value ?? '-'}`));
      const cr = readings.filter((r) => r.chamber_id === ch.id).slice(0, 3);
      if (cr.length) lines.push(`    recent readings: ${cr.map((r) => `${r.reading_type} ${r.temp_f}F/${r.rh_pct}% ${r.gpp}GPP`).join('; ')}`);
    });
  }
  return lines.join('\n');
}

async function callText(anthropic, model, system, user, maxTokens) {
  const msg = await anthropic.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function generateScope({ claimId, orgId, userId }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('scope not configured');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const graph = await fetchClaimGraph(claimId);
  if (!graph.claim) throw new Error('claim not found');
  const field = buildFieldSummary(graph);

  // Pass 1: cheap draft
  const draft = await callText(anthropic, DRAFT_MODEL,
    'You are an IICRC-certified restoration estimator. Draft a practical room-by-room mitigation scope of work from the field documentation. Water losses follow IICRC S500; mold follows S520. Be specific and realistic. Do not invent damage, readings, or rooms that are not present in the data.',
    `Field documentation:\n${field}\n\nDraft a room-by-room list of mitigation tasks (plain text, grouped by room). Include extraction, removal/demolition, cleaning/antimicrobial, drying equipment, and monitoring where justified by the data.`,
    1500);

  // Pass 2: carrier-ready structured JSON
  const finalText = await callText(anthropic, FINAL_MODEL,
    'You are an IICRC-certified restoration estimator producing a carrier-ready mitigation scope of work. Use standard restoration terminology aligned with IICRC S500 (water) and S520 (mold). Ground every line item in the provided field data and draft; do not fabricate quantities or damage. Respond with ONLY a JSON object, no prose or markdown fences.',
    `Field documentation:\n${field}\n\nDraft scope:\n${draft}\n\nProduce the final scope as JSON with this exact shape:
{
  "summary": "2-3 sentence overview of the loss and the mitigation approach",
  "rooms": [
    { "room": "room name", "items": [ { "task": "concise scope line", "justification": "why, tied to the field data", "standard": "S500" | "S520" | "" } ] }
  ]
}
Only include rooms present in the data. Keep tasks concise and professional.`,
    2500);

  let parsed;
  try { parsed = JSON.parse(finalText.replace(/```json/gi, '').replace(/```/g, '').trim()); }
  catch (_) { parsed = { summary: '', rooms: [], raw: finalText.slice(0, 4000) }; }
  if (!parsed || typeof parsed !== 'object') parsed = { summary: '', rooms: [] };
  if (!Array.isArray(parsed.rooms)) parsed.rooms = [];

  const supabase = require('./supabase').supabase;
  const { data: row } = await supabase.from('resto_scopes').insert({
    org_id: orgId, claim_id: claimId, content: parsed, summary: parsed.summary || null,
    model: `${DRAFT_MODEL} -> ${FINAL_MODEL}`, created_by: userId || null
  }).select('*').single();

  return row || { content: parsed, summary: parsed.summary || null };
}

module.exports = { generateScope, buildFieldSummary };