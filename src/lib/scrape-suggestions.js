// ============================================================================
// src/lib/scrape-suggestions.js
//
// Turns a website scrape's structured output into "Found on your website"
// suggestions for the four things a client sets up: services, staff, service
// areas, and business hours. Each list is deduped against what the client
// already has, so a scrape only ever SUGGESTS, never overwrites or contradicts
// a manual entry. Called from the Learn-from-website action AND from signup, so
// a client's dashboard has suggestions waiting the first time they open it.
//
// Stored on the clients row:
//   service_suggestions      jsonb  [{ name, price }]
//   staff_suggestions        jsonb  [{ name, role }]
//   service_area_suggestions jsonb  ["City", ...]
//   hours_suggestion         jsonb  { monday: {open,close,closed}, ... } | null
//   faq_suggestions          jsonb  [{ question, answer }]
// ============================================================================

const { pickStreetAddress } = require('./address-utils');

const MAX_ITEMS = 15;

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// True when two names are the same or clearly overlapping, so we do not suggest
// something the client already has.
function isSimilar(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  ta.forEach(t => { if (tb.has(t)) inter++; });
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.6;
}

// ---- Services: services[] names + pricing[] "Name: $X" --------------------
function buildServiceSuggestions(structuredData, existingNames) {
  if (!structuredData) return [];
  const byKey = new Map();
  const add = (name, price) => {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 80) return;
    const key = norm(clean);
    if (!key) return;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { name: clean, price: price || null });
    else if (!prev.price && price) prev.price = price;
  };
  (Array.isArray(structuredData.pricing) ? structuredData.pricing : []).forEach(entry => {
    const str = String(entry || '').trim();
    const m = str.match(/^(.*?)[:\-–]\s*(.+)$/);
    if (m && m[1] && m[2]) add(m[1], m[2].trim().slice(0, 100));
    else add(str, null);
  });
  (Array.isArray(structuredData.services) ? structuredData.services : []).forEach(s => add(s, null));

  const existing = (existingNames || []).map(norm);
  const out = [];
  for (const cand of byKey.values()) {
    if (existing.some(ex => isSimilar(cand.name, ex))) continue;
    out.push(cand);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ---- Staff: team_members[] "Dr. Smith - General Dentist" ------------------
function buildStaffSuggestions(structuredData, existingNames) {
  if (!structuredData || !Array.isArray(structuredData.team_members)) return [];
  const existing = (existingNames || []).map(norm);
  const seen = new Set();
  const out = [];
  for (const entry of structuredData.team_members) {
    const str = String(entry || '').trim();
    if (!str) continue;
    // Split name from role on a dash or comma: "Dr. Smith - General Dentist".
    let name = str, role = '';
    const m = str.match(/^(.*?)\s*[\-–,]\s*(.+)$/);
    if (m && m[1] && m[2]) { name = m[1].trim(); role = m[2].trim(); }
    if (!name || name.length > 80) continue;
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    if (existing.some(ex => isSimilar(name, ex))) continue;
    seen.add(key);
    out.push({ name, role: role ? role.slice(0, 80) : '' });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ---- Service areas: service_areas[] cities/areas ---------------------------
function buildAreaSuggestions(structuredData, existingAreas) {
  if (!structuredData || !Array.isArray(structuredData.service_areas)) return [];
  const existing = (existingAreas || []).map(norm);
  const seen = new Set();
  const out = [];
  for (const entry of structuredData.service_areas) {
    const clean = String(entry || '').trim();
    if (!clean || clean.length > 60) continue;
    const key = norm(clean);
    if (!key || seen.has(key)) continue;
    if (existing.some(ex => ex === key || isSimilar(clean, ex))) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ---- Business hours: business_hours { day: "9:00 AM - 5:00 PM" | "Closed" }
// Returns the editor shape { day: {open, close, closed} } for all 7 days, or
// null when the scrape found no usable hours. Days the scrape did not mention
// default to a plain 9-5 open (the client reviews before saving).
function buildHoursSuggestion(structuredData) {
  const src = structuredData && structuredData.business_hours;
  if (!src || typeof src !== 'object') return null;
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const out = {};
  let found = 0;
  for (const day of DAYS) {
    const raw = String(src[day] || '').trim();
    if (!raw || /^null$/i.test(raw)) {
      out[day] = { open: '9:00 AM', close: '5:00 PM', closed: false };
      continue;
    }
    if (/closed/i.test(raw)) { out[day] = { open: '9:00 AM', close: '5:00 PM', closed: true }; found++; continue; }
    const m = raw.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*(?:-|–|to)\s*(\d{1,2}:\d{2}\s*[AP]M)/i);
    if (m) {
      out[day] = { open: m[1].toUpperCase().replace(/\s+/, ' ').replace(/(\d)([AP]M)/, '$1 $2'), close: m[2].toUpperCase().replace(/\s+/, ' ').replace(/(\d)([AP]M)/, '$1 $2'), closed: false };
      found++;
    } else {
      out[day] = { open: '9:00 AM', close: '5:00 PM', closed: false };
    }
  }
  return found > 0 ? out : null;
}

// ---- FAQs: faqs[] { question, answer } ------------------------------------
// Deduped against the questions the client already has in their knowledge base
// so a scrape never re-suggests one they've already added or answered.
function buildFaqSuggestions(structuredData, existingQuestions) {
  if (!structuredData || !Array.isArray(structuredData.faqs)) return [];
  const existing = (existingQuestions || []).map(norm);
  const seen = new Set();
  const out = [];
  for (const entry of structuredData.faqs) {
    const q = String(entry && entry.question || '').trim();
    const a = String(entry && entry.answer || '').trim();
    if (!q || !a || q.length > 200) continue;
    const key = norm(q);
    if (!key || seen.has(key)) continue;
    if (existing.some(ex => isSimilar(q, ex))) continue;
    seen.add(key);
    out.push({ question: q, answer: a.slice(0, 600) });
    if (out.length >= 8) break;
  }
  return out;
}

// Pull the client's current FAQ questions out of the stored KB text
// ("Q: ...\nA: ...") so buildFaqSuggestions can dedupe against them.
function existingFaqQuestions(knowledgeBaseData) {
  const text = knowledgeBaseData && knowledgeBaseData.faqs;
  if (!text || typeof text !== 'string') return [];
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => /^Q:/i.test(l))
    .map(l => l.replace(/^Q:\s*/i, '').trim())
    .filter(Boolean);
}

// ---- Build everything from one scrape -------------------------------------
function buildAllSuggestions(structuredData, existing) {
  const e = existing || {};
  return {
    service_suggestions: buildServiceSuggestions(structuredData, e.services),
    staff_suggestions: buildStaffSuggestions(structuredData, e.staff),
    service_area_suggestions: buildAreaSuggestions(structuredData, e.areas),
    hours_suggestion: buildHoursSuggestion(structuredData),
    faq_suggestions: buildFaqSuggestions(structuredData, e.faqs),
  };
}

// ---- Fetch existing data, build, and persist all suggestions --------------
// Best-effort: never throws; a failure here must not block a scrape or signup.
async function storeSuggestionsFromScrape(supabase, clientId, structuredData) {
  try {
    if (!supabase || !clientId || !structuredData) return;
    const [{ data: svcs }, { data: staff }, { data: clientRow }] = await Promise.all([
      supabase.from('client_services').select('name').eq('client_id', clientId),
      supabase.from('staff_members').select('name').eq('client_id', clientId),
      supabase.from('clients').select('service_areas, knowledge_base_data, tool_config').eq('id', clientId).single(),
    ]);
    const suggestions = buildAllSuggestions(structuredData, {
      services: (svcs || []).map(s => s.name),
      staff: (staff || []).map(s => s.name),
      areas: Array.isArray(clientRow?.service_areas) ? clientRow.service_areas : [],
      faqs: existingFaqQuestions(clientRow?.knowledge_base_data),
    });

    // Pre-fill the "address" send-SMS preset from the scraped address so the AI
    // can text it when a caller asks. We only fill the VALUE, and only when the
    // client has not set one, and we never flip `enabled` on, the client still
    // chooses to turn address-texting on in their dashboard (value ready to go).
    const update = { ...suggestions };
    // Only seed a real street address, never a vague area the model returned.
    const scrapedAddress = pickStreetAddress(structuredData.primary_address, structuredData.addresses);
    if (scrapedAddress) {
      const tc = (clientRow && clientRow.tool_config && typeof clientRow.tool_config === 'object') ? clientRow.tool_config : {};
      const presets = (tc.smsPresets && typeof tc.smsPresets === 'object') ? tc.smsPresets : {};
      const current = (presets.address && typeof presets.address === 'object') ? presets.address : {};
      if (!current.value || !String(current.value).trim()) {
        update.tool_config = {
          ...tc,
          smsPresets: { ...presets, address: { enabled: current.enabled === true, value: scrapedAddress } },
        };
      }
    }

    await supabase.from('clients').update(update).eq('id', clientId);
    console.log(`💡 Suggestions stored for ${clientId}: ${suggestions.service_suggestions.length} services, ${suggestions.staff_suggestions.length} staff, ${suggestions.service_area_suggestions.length} areas, ${suggestions.faq_suggestions.length} faqs, hours=${!!suggestions.hours_suggestion}, addressPreset=${!!update.tool_config}`);
  } catch (err) {
    console.warn('⚠️ storeSuggestionsFromScrape failed (non-fatal):', err.message);
  }
}

module.exports = {
  norm,
  isSimilar,
  buildServiceSuggestions,
  buildStaffSuggestions,
  buildAreaSuggestions,
  buildHoursSuggestion,
  buildFaqSuggestions,
  existingFaqQuestions,
  buildAllSuggestions,
  storeSuggestionsFromScrape,
};