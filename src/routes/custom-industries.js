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
// ============================================================================
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { supabase } = require('../lib/supabase');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_CUSTOM_INDUSTRIES = 25;

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
      model: 'claude-sonnet-4-6-20260217',
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

    let knowledge_base;
    try {
      knowledge_base = await generateIndustryKB(label, description);
    } catch (genErr) {
      console.error('KB generation error:', genErr.message);
      return res.status(502).json({ error: 'Could not generate the knowledge base right now. Please try again.' });
    }

    const industry = { key, label, description, knowledge_base, created_at: new Date().toISOString() };
    const { error: upErr } = await supabase
      .from('agencies').update({ custom_industries: [...existing, industry] }).eq('id', agencyId);
    if (upErr) {
      console.error('custom-industries save error:', upErr.message);
      return res.status(500).json({ error: 'Could not save the custom industry' });
    }
    res.status(201).json({ industry });
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

module.exports = router;