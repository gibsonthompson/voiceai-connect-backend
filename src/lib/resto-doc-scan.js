// ============================================================================
// CARRIER DOCUMENT SCAN  (Claude vision)
// Reads a carrier assignment sheet / loss notice / declarations page and returns
// the claim fields found on it, so a tech photographs one page instead of typing
// twenty fields. Stateless: takes a base64 image or PDF, no storage/schema needed.
// Requires ANTHROPIC_API_KEY and @anthropic-ai/sdk on the backend.
//
// NOTHING HERE WRITES TO THE CLAIM. This module only extracts and validates; the
// app shows every field beside the current value and the tech confirms each one.
// A misread date of loss silently corrupts the sudden-vs-gradual coverage
// determination, and a misread policy number goes out on a carrier package, so
// blind auto-fill is not an option.
//
// Model choice: same Sonnet the meter OCR uses. This is one page of structured
// text, and the cost of a cheaper model misreading a claim number onto an
// insurance document is far higher than the cost of the tokens.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6';

const SYSTEM = [
  'You extract claim data from insurance documents for a restoration contractor.',
  'Typical documents: a carrier assignment sheet or first notice of loss, a policy declarations page, a carrier estimate, or a signed work authorization.',
  'Transcribe only what is printed on the page. Never infer, complete, or guess a value that is not legible.',
  'A wrong claim number or date of loss causes a claim to be denied, so omitting a field is always better than guessing it.'
].join(' ');

// The ONLY fields this scanner is allowed to return. The model cannot introduce a
// column name of its own: anything outside this map is dropped. `loss_onset` is
// deliberately absent. Sudden vs gradual is a coverage judgment the tech makes
// after seeing the cause, not something to lift off a form.
const TEXT_FIELDS = [
  'policyholder_name', 'policyholder_email', 'policyholder_phone', 'address',
  'insurance_company', 'carrier_identifier', 'policy_number', 'assignment_identifier',
  'adjuster', 'estimator', 'cause_of_loss', 'cat_code'
];
const DATE_FIELDS = ['date_of_loss', 'date_received', 'policy_effective_date', 'policy_expiration_date'];
const ENUM_FIELDS = {
  type_of_loss: ['water', 'fire', 'mold', 'other'],
  policy_type: ['homeowner', 'commercial', 'renter', 'condo', 'other'],
  deductible_applies: ['all_coverages', 'coverage_specific']
};
const NUM_FIELDS = ['deductible'];

const COVERAGE_TYPES = ['dwelling', 'other_structures', 'contents', 'loss_of_use', 'other'];
const APPLY_TO = ['rc', 'acv', 'both'];
const DOC_TYPES = ['assignment', 'declarations', 'estimate', 'authorization', 'other'];

const str = (v, max = 200) => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || /^(n\/?a|none|unknown|not listed|not provided)$/i.test(s)) return null;
  return s.slice(0, max);
};
const num = (v) => {
  if (v == null || v === '') return null;
  // tolerate "$1,000.00"
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// Strict YYYY-MM-DD, and it must be a real calendar date. A bad date string sent to
// a Postgres `date` column throws; a plausible-but-wrong one is worse.
const date = (v) => {
  const s = str(v, 10);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  // A loss cannot be in the future, and policy dates predate the invention of insurance software
  if (y < 1980 || y > new Date().getUTCFullYear() + 5) return null;
  return s;
};
// Match against the allowed vocabulary on a "squashed" form (lowercase, letters and
// digits only), so a carrier form printing "Home Owner", "home-owner", or
// "Other Structures" all resolve to the canonical value instead of being dropped.
// Returns the canonical value, never the model's spelling.
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const enumOf = (v, allowed) => {
  const s = str(v, 40);
  if (!s) return null;
  const target = squash(s);
  return allowed.find((a) => squash(a) === target) || null;
};

// Turn whatever the model produced into something safe to show the tech. Anything
// unrecognized is dropped rather than passed through.
function normalizeExtraction(p) {
  const out = { docType: 'other', fields: {}, coverages: [], notes: '' };
  if (!p || typeof p !== 'object') return out;

  out.docType = DOC_TYPES.includes(p.docType) ? p.docType : 'other';
  out.notes = str(p.notes, 300) || '';

  const f = (p.fields && typeof p.fields === 'object') ? p.fields : {};
  for (const k of TEXT_FIELDS) { const v = str(f[k]); if (v != null) out.fields[k] = v; }
  for (const k of DATE_FIELDS) { const v = date(f[k]); if (v != null) out.fields[k] = v; }
  for (const k of NUM_FIELDS) { const v = num(f[k]); if (v != null && v >= 0) out.fields[k] = v; }
  for (const k of Object.keys(ENUM_FIELDS)) { const v = enumOf(f[k], ENUM_FIELDS[k]); if (v != null) out.fields[k] = v; }

  // A policy that expired before the loss, or started after it, means the model
  // misread something (or the loss genuinely is not covered, which is not ours to
  // assert). Keep the dates, but say so, rather than letting it pass silently.
  const dol = out.fields.date_of_loss;
  if (dol && out.fields.policy_expiration_date && out.fields.policy_expiration_date < dol) {
    out.notes = (out.notes ? out.notes + ' ' : '') + 'The policy expiration date read as earlier than the date of loss. Check both against the document.';
  }

  if (Array.isArray(p.coverages)) {
    for (const c of p.coverages.slice(0, 12)) {
      if (!c || typeof c !== 'object') continue;
      const type = enumOf(c.type, COVERAGE_TYPES) || 'other';
      const name = str(c.name, 60) || type.replace(/_/g, ' ');
      const limit = num(c.limit);
      const deductible = num(c.deductible);
      if (limit == null && deductible == null) continue;   // an empty row helps nobody
      out.coverages.push({
        type, name,
        limit: limit != null && limit >= 0 ? limit : null,
        deductible: deductible != null && deductible >= 0 ? deductible : null,
        apply_to: enumOf(c.apply_to, APPLY_TO) || 'both'
      });
    }
  }

  return out;
}

const PROMPT = `Read this insurance document and extract the claim data printed on it.

Respond with ONLY a JSON object (no prose, no markdown fences):
"docType": "assignment" | "declarations" | "estimate" | "authorization" | "other"
"fields": {
  "policyholder_name": string,        (the insured)
  "policyholder_phone": string,
  "policyholder_email": string,
  "address": string,                  (the LOSS / property address, not the carrier's address)
  "insurance_company": string,
  "carrier_identifier": string,       (the CLAIM NUMBER assigned by the insurer)
  "policy_number": string,
  "assignment_identifier": string,    (adjuster file number / assignment id, if separate from the claim number)
  "adjuster": string,                 (adjuster or claim representative)
  "estimator": string,
  "date_of_loss": "YYYY-MM-DD",
  "date_received": "YYYY-MM-DD",      (date the assignment was received/issued)
  "type_of_loss": "water" | "fire" | "mold" | "other",
  "cause_of_loss": string,            (specific cause, e.g. "supply line failure", "roof leak")
  "cat_code": string,
  "policy_type": "homeowner" | "commercial" | "renter" | "condo" | "other",
  "policy_effective_date": "YYYY-MM-DD",
  "policy_expiration_date": "YYYY-MM-DD",
  "deductible": number,
  "deductible_applies": "all_coverages" | "coverage_specific"
}
"coverages": [ { "type": "dwelling"|"other_structures"|"contents"|"loss_of_use"|"other", "name": string, "limit": number, "deductible": number, "apply_to": "rc"|"acv"|"both" } ]
"notes": string   (anything the reader should double check, e.g. a smudged digit. Empty string if nothing.)

Rules:
- OMIT any key you cannot read clearly. Do not include it with a guessed or placeholder value.
- Dates must be YYYY-MM-DD. If a date is ambiguous (e.g. 03/04/25 could be March or April), omit it and say so in "notes".
- Money must be a plain number, no currency symbol or commas.
- Do NOT decide whether the damage was sudden or gradual. That is not your call.
- If the page is not an insurance document, return docType "other" with empty fields.`;

async function readDoc(base64, mediaType) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // PDFs go in as a document block; photos as an image block.
  const isPdf = String(mediaType).toLowerCase() === 'application/pdf';
  const source = { type: 'base64', media_type: isPdf ? 'application/pdf' : mediaType, data: base64 };
  const fileBlock = isPdf ? { type: 'document', source } : { type: 'image', source };

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: PROMPT }] }]
  });

  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  let p;
  try { p = JSON.parse(clean); } catch (_) {
    return { docType: 'other', fields: {}, coverages: [], notes: 'The document could not be read. Try a flatter, sharper photo of the whole page.' };
  }
  return normalizeExtraction(p);
}

const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

async function scanDocument({ fileBase64, mediaType }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('doc scan not configured');
  if (!fileBase64) throw new Error('file required');
  const mt = (mediaType || 'image/jpeg').toLowerCase();
  if (!ALLOWED_MEDIA.includes(mt)) throw new Error('unsupported file type');
  return readDoc(fileBase64, mt);
}

module.exports = { scanDocument, normalizeExtraction };