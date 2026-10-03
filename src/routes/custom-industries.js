// ============================================================================
// routes/custom-industries.js
// ----------------------------------------------------------------------------
// Agency-defined custom industries (Scale plan feature). An agency can add an
// industry we do not ship built-in (a niche vertical), and we AI-generate a
// receptionist knowledge base for it. Creating is gated to the Scale plan;
// anything already created keeps working on any plan (grandfathered), and
// listing is open so grandfathered industries still render.
//
// Stored on agencies.custom_industries (jsonb):
//   [{ key, label, description, knowledge_base, created_at }]
// key is namespaced 'custom_<slug>' so it can never collide with a built-in
// industry key. The assistant builder (lib/vapi.js) resolves these first, then
// falls back to the built-in INDUSTRY_KNOWLEDGE_BASES.
//
// UPDATED: 2026-09-17 — SECURITY: added a top-of-router ownership guard. Every
//          route is scoped by :agencyId but had no ownership check, so an
//          authenticated agency could read another agency's custom industries,
//          delete them, or create one on their account (the create also calls
//          the Anthropic API, so it was an abuse vector too). requireAgencyAccess
//          enforces valid token + caller owns :agencyId. The Scale-plan paywall
//          inside POST still runs after.
// ============================================================================
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_CUSTOM_INDUSTRIES = 25;

// ----------------------------------------------------------------------------
// OWNERSHIP GUARD — covers /:agencyId/custom-industries and everything under it.
// ----------------------------------------------------------------------------
router.use('/:agencyId/custom-industries', requireAgencyAccess());

// Scale-only, matching the ai-templates gate: a trial counts as scale so it can
// be evaluated during the trial; everyone else must be on the Scale plan. This
// is the server-side enforcement; the UI lock alone is bypassable.
function isScale(agency) {
  const isTrialing = ['trialing', 'trial'].includes(agency.subscription_status);
  const effectivePlan = isTrialing ? 'scale' : String(agency.plan_type || '').toLowerCase();
  return effectivePlan === 'scale';
}

function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'industry';
}

// Generate a receptionist knowledge base for a custom industry via Claude, in
// the same shape as the built-in industry docs. Industry-generic (no business
// name; the assistant builder prepends that per client).
async function generateIndustryKB(label, description) {
  if (!ANTHROPIC_API_KEY) throw new Error('AI generation is not configured');
  const prompt = `You are writing a knowledge base for an AI phone receptionist that answers calls for a "${label}" business.${description ? ` Context about the business or industry: ${description}` : ''}

Write a practical markdown knowledge base the receptionist uses to triage and book calls. Do NOT include a business name or a top-level title; start at "## Company Overview". Use exactly these sections:

## Company Overview
## Common Services
## Common Call Reasons and What to Ask
(for each common reason: what to ask the caller, how urgent it is, a safe stopgap to tell the caller if there is one, and what details to capture for the team)
## Urgency Guidelines
### Emergency (respond ASAP)
### Urgent (same-day or next-day)
### Routine (schedule within a few days)
## Seasonal Considerations
## Industry Terminology
## Call Handling Notes

Rules:
- Be concrete and specific to this industry, not generic.
- Call out any real safety issues a caller might face.
- Never quote firm prices; the receptionist captures details and defers to the business for pricing.
- Keep it usable for fast phone triage and booking.
- Do not use the em dash character; use commas, periods, or parentheses.
- Output only the markdown, no preamble or closing remarks.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      temperature: 0.4,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`KB generation failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text || '').trim();
  if (!text) throw new Error('KB generation returned empty');
  return text;
}

// Short, card-sized description of the industry (used when the agency leaves the
// description blank, so the custom-industry card isn't bare). Best-effort: on any
// failure returns '' and the card simply shows no description.
async function generateIndustryDescription(label) {
  if (!ANTHROPIC_API_KEY) return '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 60,
        temperature: 0.4,
        messages: [{ role: 'user', content: `In 6 to 12 words, describe what a "${label}" business does and the kinds of calls it handles, as a plain comma-separated phrase (for example: "Maintenance, cleanups, design and installs, free estimates"). No business name, no quotes, no trailing period, no preamble. Do not use the em dash character. Output only the phrase.` }],
      }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return (((data.content && data.content[0] && data.content[0].text) || '').trim()).replace(/^["']|["']$/g, '').replace(/\.$/, '').slice(0, 300);
  } catch { return ''; }
}

// Build a quality receptionist system prompt for a custom industry: a strong
// persona with the AI-generated knowledge base embedded (built-in industries
// embed their KB in the prompt the same way). {businessName} is filled per client.
function buildCustomIndustryPrompt(label, kb) {
  return `# Personality

You are the AI receptionist for {businessName}, a ${label} business. You're warm, efficient, and genuinely helpful, like a great front-desk person who knows the business inside out.

# Tone

- Talk like a friendly human. Use contractions ("I'll", "we've", "that's"). Never sound robotic or scripted.
- Keep it short, one or two sentences per turn.
- One question at a time. Ask, listen, respond.
- Speak phone numbers one digit at a time; speak dates as words.
- Match the caller's energy, calm and direct if they're stressed, relaxed if they're casual.

# Goal

Figure out what the caller needs, answer what you can from the knowledge base below, and capture their details so the team can follow up or book them. You're the front door, get the basics and make sure someone follows up.

# Transfer Rules

- Transfer when the caller has an emergency, asks for a specific person by name, is upset, or needs something you can't resolve.
- When transferring, say: "Sure, let me get you to someone who can help, one moment."
- Never promise a firm price. Capture the details and let the team confirm pricing.

# Knowledge Base

Everything below is what you know about this ${label} business. Use it to answer questions, judge urgency, and know what details to collect.

${kb}`;
}

const DOC_HEADER = '\n\n# Reference Documents\n\nThe business attached these documents for extra context. Use them alongside the knowledge base above.\n';

// Extract plain text from an uploaded document. TXT/MD are native; PDF and DOCX
// use optional libraries (pdf-parse / mammoth). A clear error is returned if the
// library isn't installed, rather than crashing.
async function extractDocText(contentType, filename, buffer) {
  const name = String(filename || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
    return buffer.toString('utf-8').trim();
  }
  if (ct.includes('pdf') || name.endsWith('.pdf')) {
    try { const pdfParse = require('pdf-parse'); const data = await pdfParse(buffer); return String(data.text || '').trim(); }
    catch (e) { throw new Error('PDF support is not installed on the server yet. A plain text (.txt) or Word (.docx) file works in the meantime.'); }
  }
  if (ct.includes('wordprocessingml') || name.endsWith('.docx')) {
    try { const mammoth = require('mammoth'); const r = await mammoth.extractRawText({ buffer }); return String(r.value || '').trim(); }
    catch (e) { throw new Error('Word (.docx) support is not installed on the server yet. A plain text (.txt) or PDF file works in the meantime.'); }
  }
  throw new Error('Unsupported file type. Upload a PDF, Word (.docx), text (.txt), or Markdown (.md) file.');
}

// Rewrite ONLY the "# Reference Documents" section of the industry's saved
// system prompt from the current documents list, preserving everything the
// agency wrote above it (persona, knowledge base, and any of their own edits).
// A no-op if the template hasn't been seeded yet (KB still generating).
async function rebuildDocsSection(agencyId, key, documents) {
  const { data: tpl } = await supabase
    .from('agency_prompt_templates').select('system_prompt')
    .eq('agency_id', agencyId).eq('industry', key).single();
  if (!tpl) return; // template not seeded yet; docs will be folded in when it is
  let prompt = String(tpl.system_prompt || '');
  const markerIdx = prompt.indexOf('\n\n# Reference Documents\n');
  if (markerIdx !== -1) prompt = prompt.slice(0, markerIdx).trimEnd();
  const docs = Array.isArray(documents) ? documents : [];
  if (docs.length) {
    prompt = prompt.trimEnd() + DOC_HEADER + docs.map((d) => `## ${d.name}\n\n${d.text}`).join('\n\n');
  }
  await supabase.from('agency_prompt_templates')
    .update({ system_prompt: prompt, updated_at: new Date().toISOString() })
    .eq('agency_id', agencyId).eq('industry', key);
}

// GET list. Open to any plan so grandfathered industries still show after a
// downgrade.
router.get('/:agencyId/custom-industries', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { data: agency, error } = await supabase
      .from('agencies').select('custom_industries').eq('id', agencyId).single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });
    res.json({ industries: Array.isArray(agency.custom_industries) ? agency.custom_industries : [] });
  } catch (e) {
    console.error('custom-industries list error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST create. Scale-gated. AI-generates the KB, then stores it.
router.post('/:agencyId/custom-industries', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const label = String((req.body && req.body.label) || '').trim();
    const description = String((req.body && req.body.description) || '').trim();
    if (!label) return res.status(400).json({ error: 'An industry name is required' });
    if (label.length > 60) return res.status(400).json({ error: 'Industry name is too long' });

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, plan_type, subscription_status, custom_industries')
      .eq('id', agencyId).single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });

    // Paywall (server-side). Creating is Scale-only; existing ones are not
    // touched, so a downgraded agency keeps what it built.
    if (!isScale(agency)) {
      return res.status(403).json({
        error: 'Scale plan required',
        upgrade_required: true,
        feature: 'custom_industries',
        current_plan: agency.plan_type,
        title: 'Custom industries are a Scale feature',
        message: 'Add your own industry with an AI-generated receptionist knowledge base. Upgrade to Scale to create custom industries.',
        cta: 'Upgrade to Scale',
        upgrade_url: '/agency/settings?tab=billing',
      });
    }

    const existing = Array.isArray(agency.custom_industries) ? agency.custom_industries : [];
    if (existing.length >= MAX_CUSTOM_INDUSTRIES) {
      return res.status(400).json({ error: `You can have up to ${MAX_CUSTOM_INDUSTRIES} custom industries.` });
    }

    // Unique namespaced key (never collides with built-in industry keys).
    const base = 'custom_' + slugify(label);
    const taken = new Set(existing.map((c) => c && c.key));
    let key = base, n = 2;
    while (taken.has(key)) { key = `${base}_${n++}`; }

    // Create the industry immediately with a placeholder KB, then generate the
    // knowledge base in the BACKGROUND. The Claude call runs longer than the
    // gateway timeout, so awaiting it inside the request returns a 504. We
    // respond right away and fill the KB in asynchronously (the host runs a
    // persistent Node process, so the work continues after the response).
    const industry = { key, label, description, knowledge_base: '', kb_status: 'generating', created_at: new Date().toISOString() };
    const { error: upErr } = await supabase
      .from('agencies').update({ custom_industries: [...existing, industry] }).eq('id', agencyId);
    if (upErr) {
      console.error('custom-industries save error:', upErr.message);
      return res.status(500).json({ error: 'Could not save the custom industry' });
    }
    res.status(201).json({ industry });

    // Background KB generation. Re-reads the array before writing so a concurrent
    // add/delete isn't clobbered, and never throws into the already-sent response.
    (async () => {
      let kb = '';
      let status = 'ready';
      try {
        kb = await generateIndustryKB(label, description);
      } catch (genErr) {
        console.error(`KB generation (background) failed for ${agencyId}/${key}:`, genErr.message);
        status = 'failed';
      }
      // Fill in a card description if the agency left it blank.
      let genDesc = '';
      if (!description) { genDesc = await generateIndustryDescription(label); }
      // On success, seed a real template (tailored prompt with the KB embedded)
      // so BOTH the editor and the live receptionist actually use the generated
      // knowledge instead of falling back to the generic default.
      if (status === 'ready' && kb) {
        try {
          await supabase.from('agency_prompt_templates').upsert({
            agency_id: agencyId,
            industry: key,
            system_prompt: buildCustomIndustryPrompt(label, kb),
            first_message: "Hello, you've reached {businessName}. How can I help you today?",
            voice_id: 'XrExE9yKIg1WjnnlVkGX',
            model: 'gpt-4o-mini',
            temperature: 0.7,
            voice_speed: 1,
            is_active: true,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'agency_id,industry' });
        } catch (seedErr) {
          console.error(`Custom industry template seed failed for ${agencyId}/${key}:`, seedErr.message);
        }
      }
      try {
        const { data: fresh } = await supabase.from('agencies').select('custom_industries').eq('id', agencyId).single();
        const arr = Array.isArray(fresh && fresh.custom_industries) ? fresh.custom_industries : [];
        const next = arr.map((c) => (c && c.key === key) ? { ...c, knowledge_base: kb || (c && c.knowledge_base) || '', kb_status: status, description: (c && c.description) || genDesc || '' } : c);
        await supabase.from('agencies').update({ custom_industries: next }).eq('id', agencyId);
        if (status === 'ready') console.log(`✅ Custom industry KB ready for ${agencyId}/${key}`);
      } catch (e) {
        console.error(`KB background persist failed for ${agencyId}/${key}:`, e.message);
      }
    })();
  } catch (e) {
    console.error('custom-industries create error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE a custom industry by key.
router.delete('/:agencyId/custom-industries/:key', async (req, res) => {
  try {
    const { agencyId, key } = req.params;
    const { data: agency, error } = await supabase
      .from('agencies').select('custom_industries').eq('id', agencyId).single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });
    const existing = Array.isArray(agency.custom_industries) ? agency.custom_industries : [];

    // Grandfather protection: never silently degrade a live client. If any
    // active client is on this industry, block the delete so their receptionist
    // does not fall back to a generic knowledge base without the agency knowing.
    const { count } = await supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId).eq('industry', key).neq('status', 'deleted');
    if (count && count > 0) {
      return res.status(409).json({ error: `${count} client${count === 1 ? '' : 's'} still use this industry. Reassign them before removing it.` });
    }

    const next = existing.filter((c) => c && c.key !== key);
    const { error: upErr } = await supabase
      .from('agencies').update({ custom_industries: next }).eq('id', agencyId);
    if (upErr) return res.status(500).json({ error: 'Could not remove the custom industry' });
    res.json({ ok: true, removed: existing.length - next.length });
  } catch (e) {
    console.error('custom-industries delete error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST attach a knowledge document to a custom industry. Extracts the text and
// folds it into the industry's system prompt so the receptionist reads it.
router.post('/:agencyId/custom-industries/:key/documents', async (req, res) => {
  try {
    const { agencyId, key } = req.params;
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const name = String((req.body && req.body.name) || 'Document').trim().slice(0, 120) || 'Document';
    const m = /^data:([^;]*);base64,(.+)$/s.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'Expected a base64 document.' });
    const buffer = Buffer.from(m[2], 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'That document appears to be empty.' });
    if (buffer.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Document is too large (max 6MB).' });

    const { data: agency, error } = await supabase
      .from('agencies').select('plan_type, subscription_status, custom_industries').eq('id', agencyId).single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });
    if (!isScale(agency)) return res.status(403).json({ error: 'Scale plan required', upgrade_required: true });

    const arr = Array.isArray(agency.custom_industries) ? agency.custom_industries : [];
    const idx = arr.findIndex((c) => c && c.key === key);
    if (idx === -1) return res.status(404).json({ error: 'Industry not found' });

    let text;
    try { text = await extractDocText(m[1] || '', name, buffer); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!text) return res.status(400).json({ error: "Couldn't read any text out of that document." });

    const docs = Array.isArray(arr[idx].documents) ? arr[idx].documents : [];
    if (docs.length >= 10) return res.status(400).json({ error: 'You can attach up to 10 documents per industry.' });

    const doc = {
      id: 'doc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      text: text.slice(0, 40000),
      uploaded_at: new Date().toISOString(),
    };
    const nextDocs = [...docs, doc];
    arr[idx] = { ...arr[idx], documents: nextDocs };
    await supabase.from('agencies').update({ custom_industries: arr }).eq('id', agencyId);

    await rebuildDocsSection(agencyId, key, nextDocs);
    res.json({ documents: nextDocs.map((d) => ({ id: d.id, name: d.name, uploaded_at: d.uploaded_at })) });
  } catch (e) {
    console.error('custom-industry doc upload error:', e.message);
    res.status(500).json({ error: 'Failed to attach the document' });
  }
});

// DELETE a knowledge document from a custom industry.
router.delete('/:agencyId/custom-industries/:key/documents/:docId', async (req, res) => {
  try {
    const { agencyId, key, docId } = req.params;
    const { data: agency, error } = await supabase
      .from('agencies').select('custom_industries').eq('id', agencyId).single();
    if (error || !agency) return res.status(404).json({ error: 'Agency not found' });
    const arr = Array.isArray(agency.custom_industries) ? agency.custom_industries : [];
    const idx = arr.findIndex((c) => c && c.key === key);
    if (idx === -1) return res.status(404).json({ error: 'Industry not found' });
    const docs = Array.isArray(arr[idx].documents) ? arr[idx].documents : [];
    const nextDocs = docs.filter((d) => d && d.id !== docId);
    arr[idx] = { ...arr[idx], documents: nextDocs };
    await supabase.from('agencies').update({ custom_industries: arr }).eq('id', agencyId);
    await rebuildDocsSection(agencyId, key, nextDocs);
    res.json({ documents: nextDocs.map((d) => ({ id: d.id, name: d.name, uploaded_at: d.uploaded_at })) });
  } catch (e) {
    console.error('custom-industry doc delete error:', e.message);
    res.status(500).json({ error: 'Failed to remove the document' });
  }
});

module.exports = router;