// ============================================================================
// Intake prompt + extraction builders
// VoiceAI Connect
// ----------------------------------------------------------------------------
// Turns one intake schema (see intake-templates.js) into:
//   buildIntakeInstructions(schema)   -> prompt text that drives the live call
//                                        (ordered, one-question-at-a-time, with
//                                        if-then branches, framed to serve the
//                                        caller)
//   buildIntakeExtractionSchema(schema) -> a JSON Schema used post-call to pull
//                                        a clean structured record from the
//                                        transcript (wired in a later pass)
//   normalizeIntakeSchema(raw)        -> defensive cleanup so an agency-built or
//                                        partial schema never breaks a call
// Pure functions, no side effects.
// ============================================================================

const VALID_TYPES = new Set(['text', 'choice', 'phone', 'number', 'datetime', 'address']);

// Keep only well-formed fields so a bad custom template can never break a call.
function normalizeIntakeSchema(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) return null;
  const fields = [];
  const seen = new Set();
  for (const f of raw.fields) {
    if (!f || typeof f !== 'object') continue;
    const key = String(f.key || '').trim();
    const label = String(f.label || '').trim();
    if (!key || !label || seen.has(key)) continue;
    seen.add(key);
    const type = VALID_TYPES.has(f.type) ? f.type : 'text';
    const field = { key, label, type, required: f.required !== false };
    if (type === 'choice' && Array.isArray(f.options)) field.options = f.options.map((o) => String(o)).filter(Boolean);
    if (f.hint) field.hint = String(f.hint);
    if (f.showIf && f.showIf.field) {
      const sf = { field: String(f.showIf.field) };
      if (Array.isArray(f.showIf.in)) sf.in = f.showIf.in.map((o) => String(o));
      else if (f.showIf.equals !== undefined) sf.equals = String(f.showIf.equals);
      if (sf.in || sf.equals !== undefined) field.showIf = sf;
    }
    fields.push(field);
  }
  if (!fields.length) return null;
  return {
    key: String(raw.key || 'intake'),
    label: String(raw.label || 'Intake'),
    intro: raw.intro ? String(raw.intro) : '',
    fields,
  };
}

function conditionClause(showIf, fields) {
  const ctrl = fields.find((x) => x.key === showIf.field);
  const name = ctrl ? ctrl.label.toLowerCase() : showIf.field;
  if (showIf.in && showIf.in.length) return `only if ${name} is ${showIf.in.join(' or ')}`;
  if (showIf.equals !== undefined) return `only if ${name} is ${showIf.equals}`;
  return '';
}

// Build the live-call instructions. This is where the one-question-at-a-time,
// serve-the-caller flow lives, driven by the fields.
function buildIntakeInstructions(rawSchema) {
  const schema = normalizeIntakeSchema(rawSchema);
  if (!schema) return '';

  const lines = [];
  for (const f of schema.fields) {
    let line = `- ${f.label}`;
    if (f.type === 'choice' && f.options && f.options.length) line += ` (${f.options.join(', ')})`;
    if (f.hint) line += ` [${f.hint}]`;
    if (f.showIf) {
      const clause = conditionClause(f.showIf, schema.fields);
      if (clause) line += ` (${clause})`;
    }
    lines.push(line);
  }
  const required = schema.fields.filter((f) => f.required && !f.showIf).map((f) => f.label.toLowerCase());

  return `

# Taking the caller's request (${schema.label})
Your job here is to serve this caller and make it easy for them. ${schema.intro}

Collect the details below, ONE at a time, in this order. Ask for one thing, wait for the answer, acknowledge it in a few words, then ask the next. Never ask for two things at once, and never read this list aloud, just work through it like a helpful person would. If an item is marked "only if", skip it unless that condition is true.

${lines.join('\n')}

You must get these before wrapping up: ${required.join(', ')}. If the caller offers more than one order or item, run through the relevant details again for each. When you have what you need, read the key details back once to confirm you got them right, then let them know the team will take it from here. Keep it warm and natural, not like a form.`;
}

// Map a field to a JSON Schema property for post-call extraction.
function fieldToJsonSchema(f) {
  const base = { description: f.label + (f.hint ? ` (${f.hint})` : '') };
  if (f.type === 'number') return { type: ['number', 'null'], ...base };
  if (f.type === 'choice' && f.options && f.options.length) {
    return { type: ['string', 'null'], enum: [...f.options, null], ...base };
  }
  return { type: ['string', 'null'], ...base };
}

// Build the post-call extraction schema (JSON Schema). Wired into the webhook
// in a later pass; defined here so the schema is the single source of truth.
function buildIntakeExtractionSchema(rawSchema) {
  const schema = normalizeIntakeSchema(rawSchema);
  if (!schema) return null;
  const properties = {};
  for (const f of schema.fields) properties[f.key] = fieldToJsonSchema(f);
  return {
    type: 'object',
    description: `Structured ${schema.label} captured from the call. Use null for anything the caller did not provide.`,
    properties,
  };
}

module.exports = { normalizeIntakeSchema, buildIntakeInstructions, buildIntakeExtractionSchema };
