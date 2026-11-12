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
    pricing: normalizePricing(raw.pricing),
  };
}

// A business's price list, kept with the intake config. Each entry is an item,
// a price, and an optional unit ("each", "per lb", "per acre"). Defensive: a bad
// row is dropped, never throws, duplicates by item name collapse to the first.
function normalizePricing(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const item = String(p.item || '').trim();
    const price = Number(p.price);
    if (!item || !Number.isFinite(price) || price < 0) continue;
    const dedupe = item.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const entry = { item, price: Math.round(price * 100) / 100 };
    const unit = String(p.unit || '').trim();
    if (unit) entry.unit = unit;
    out.push(entry);
  }
  return out;
}

// Given the price list and the items the caller ordered, compute the line items
// and the total IN CODE (never trusting the model to do money math). Unmatched
// items are dropped; a missing/zero quantity defaults to 1.
function computeOrderTotals(pricing, orderItems) {
  if (!Array.isArray(pricing) || !pricing.length || !Array.isArray(orderItems) || !orderItems.length) return null;
  const byItem = new Map(pricing.map((p) => [String(p.item).toLowerCase(), p]));
  const lineItems = [];
  let total = 0;
  for (const oi of orderItems) {
    if (!oi || typeof oi !== 'object') continue;
    const match = byItem.get(String(oi.item || '').trim().toLowerCase());
    if (!match) continue;
    let qty = Number(oi.quantity);
    if (!Number.isFinite(qty) || qty <= 0) qty = 1;
    const subtotal = Math.round(match.price * qty * 100) / 100;
    total += subtotal;
    lineItems.push({ item: match.item, quantity: qty, unit_price: match.price, unit: match.unit || null, subtotal });
  }
  if (!lineItems.length) return null;
  return { lineItems, total: Math.round(total * 100) / 100 };
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

  let pricingBlock = '';
  if (schema.pricing && schema.pricing.length) {
    const priceLines = schema.pricing.map((p) => `- ${p.item}: $${p.price.toFixed(2)}${p.unit ? ` ${p.unit}` : ''}`);
    pricingBlock = `

## Prices
These are the business's exact prices. When a caller asks a price, or you confirm what they want, use these numbers exactly. Never make up a price. If a caller asks about something that is not listed, tell them you will have the team confirm that price rather than guessing.
${priceLines.join('\n')}

As you take the order, keep track of each item and how many they want. When you read the order back to confirm, say the price of each item and the order total so there are no surprises.`;
  }

  return `

# Taking the caller's request (${schema.label})
Your job here is to serve this caller and make it easy for them. ${schema.intro}

Collect the details below, ONE at a time, in this order. Ask for one thing, wait for the answer, acknowledge it in a few words, then ask the next. Never ask for two things at once, and never read this list aloud, just work through it like a helpful person would. If an item is marked "only if", skip it unless that condition is true.

${lines.join('\n')}${pricingBlock}

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
  // When the business has a price list, also pull the priced items the caller
  // ordered. The model only matches items to the list and gives a quantity; the
  // prices and the total are applied in code afterwards (see computeOrderTotals).
  if (schema.pricing && schema.pricing.length) {
    const itemNames = schema.pricing.map((p) => p.item);
    properties.order_items = {
      type: ['array', 'null'],
      description: 'Each priced item the caller ordered. Use only items from this price list; leave null or empty if none were ordered.',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', enum: itemNames, description: 'The exact price-list item the caller ordered' },
          quantity: { type: ['number', 'null'], description: 'How many or how much of this item the caller wants. Use 1 if they did not give a number.' },
        },
      },
    };
  }
  return {
    type: 'object',
    description: `Structured ${schema.label} captured from the call. Use null for anything the caller did not provide.`,
    properties,
  };
}

module.exports = { normalizeIntakeSchema, buildIntakeInstructions, buildIntakeExtractionSchema, normalizePricing, computeOrderTotals };
