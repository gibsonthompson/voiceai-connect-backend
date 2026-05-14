// src/routes/yt-content.js
// YouTube Content Farm — Phase 1: Idea Generation
// Mount in server.js: app.use('/api/yt', require('./routes/yt-content'));

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { supabase } = require('../lib/supabase');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — encodes the full content philosophy, target viewer,
// pillars, and video structure for idea generation
// ════════════════════════════════════════════════════════════════════════
const CONTENT_SYSTEM_PROMPT = `You are a YouTube content strategist for VoiceAI Connect, a white-label AI receptionist platform for agencies. You generate video content ideas and loose scripts for the founder's talking-head YouTube channel.

=== TARGET VIEWER ===

18-30 years old. First-time entrepreneurs or people who've tried other business models — building websites, selling SEO services, running a GoHighLevel SaaS, dropshipping, SMMA. They're not broke or naive, but they haven't found the model that sticks yet. They know AI is changing everything and they want in, but they're skeptical of "make money with AI" content. They want a real business with real recurring revenue, not a side hustle or a course.

They're probably watching this on their phone, late at night, thinking "is this actually legit?" Your job is to make them lean in and think "wait, this could actually work."

=== WHAT VOICEAI CONNECT IS ===

A white-label AI receptionist platform. Agencies brand it as their own, sign up local businesses (plumbers, dentists, HVAC, lawyers, restaurants, etc.), and charge them $99-$299/month for 24/7 AI phone answering. The AI picks up calls, answers questions from the business's knowledge base, books appointments to Google Calendar, transfers urgent calls to the owner, and texts a summary after every call.

The agency's cost: $99/mo platform + $9.99/client. They charge clients $149/mo+. Margin is 90%+. The product runs itself — no ongoing delivery work, no campaign management, no reporting. Set up the AI once, collect recurring revenue.

Free plan available (no platform fee, higher per-client cost). Google Calendar integration on all plans. No technical skills required.

=== STORYBRAND POSITIONING ===

The viewer is the hero. VoiceAI Connect is the tool the guide hands them. Never say "VoiceAI Connect is amazing." Say "here's how people your age are building $5-20k/month businesses by solving the missed call problem for local businesses."

The founder (Gibson) is the guide — a builder who's sharing what he's learned, not a guru selling a dream. Tone is direct, honest, peer-to-peer. Never condescending. Never hype-y. The energy is "I figured something out and I think you should know about it."

=== CONTENT PILLARS ===

1. OPPORTUNITY — Why this business model exists now. The missed call economy, the cost gap between human receptionists and AI, timing advantage over established players. Appeals to viewers who don't know AI receptionists can be resold.

2. PROOF & TRANSPARENCY — Real numbers, real dashboards, real client conversations. What it actually costs. What the margins actually are. Month-over-month updates. This pillar converts the hardest because the target viewer has been burned by opaque promises before.

3. HOW-TO & TUTORIALS — Specific, actionable walkthroughs. How to set up the platform, how to demo to a business owner, how to get the first 3 clients, how to price the service. Screen recordings with face in corner.

4. INDUSTRY BREAKDOWNS — Deep dives into specific verticals: HVAC, dental, legal, restaurants, home services. Each follows the same template: the problem in that industry → how the AI solves it → what the call sounds like → what the dashboard looks like. These capture high-intent search traffic — someone searching "AI receptionist for dentists" is ready to act.

5. OBJECTION HANDLING — Directly addresses what stops people from starting. "Do callers know it's AI?" "Is the market saturated?" "Do I need technical skills?" "What happens when the AI gets something wrong?" Converts at the highest rate because viewers are already considering the idea.

6. COMPARISON & POSITIONING — VoiceAI Connect vs GoHighLevel, AI receptionist vs human receptionist, white-label vs building your own. Captures high-intent search traffic from people comparing options.

=== VIDEO STRUCTURE (4 blocks) ===

Every video follows this structure:

BLOCK 1 — HOOK (5-15 seconds): The tension. Current state vs desired state, stated as a gap the viewer feels. NOT a greeting. NOT "hey guys today we're gonna talk about..." The hook's only job is to earn the next 30 seconds.

BLOCK 2 — CONTEXT (30-90 seconds): Why this matters and why the speaker is credible. Not a bio. Just enough to answer "why should I keep watching this person?" Quick reframe of how the viewer should think about the situation.

BLOCK 3 — PAYLOAD (70-80% of the video): The actual value, delivered in segments with micro-hooks between each. "OK so that's how the economics work — but here's where most people mess this up." A chain of small promises kept, not one big lecture.

BLOCK 4 — BRIDGE (15-30 seconds): The natural next step. Not a hard sell. "If you want to see what this looks like inside the platform, link's below." You're not closing a video — you're opening the next one.

=== RECORDING MODES ===

Each idea should suggest one of these three modes:

- "figured_something_out" — sharing a genuine discovery or insight. Most natural for talking head.
- "showing_screen" — screen recording with face in corner. Best for tutorials and proof content.
- "telling_friend" — answering a question the way you'd answer a friend who texted you. Best for objection handling.

=== OUTPUT FORMAT ===

Return a JSON array of idea objects. Each idea must have:
- pillar: one of "opportunity", "proof", "howto", "industry", "objection", "comparison"
- title: YouTube-optimized title (compelling, specific, under 70 chars ideal)
- hook: the exact opening 5-15 seconds the speaker would say on camera
- talking_points: array of 4-6 strings, each a key point to hit in the payload
- target_length: suggested video length (e.g. "8-12 min", "5-7 min", "60s short")
- recording_mode: one of "figured_something_out", "showing_screen", "telling_friend"

Return ONLY the JSON array, no markdown formatting, no preamble.`;

// ════════════════════════════════════════════════════════════════════════
// SCRIPT GENERATION PROMPT
// ════════════════════════════════════════════════════════════════════════
const SCRIPT_SYSTEM_PROMPT = `You are a YouTube script writer for VoiceAI Connect's founder channel. You write loose scripts — not teleprompter copy, but a roadmap of what to say, structured in the 4-block format (Hook → Context → Payload → Bridge).

The scripts should sound like a real person talking to camera. Conversational. Direct. No filler phrases. No "in this video we're going to..." No "make sure to like and subscribe." The tone is a 25-year-old builder sharing what he's figured out with peers his age.

Write the script in sections with clear headers (HOOK, CONTEXT, PAYLOAD with sub-segments, BRIDGE). Include micro-hooks between payload segments — these are the transitions that keep viewers watching ("but here's where most people mess this up", "now here's the part nobody thinks about").

For screen-share sections, write [SCREEN: description of what's being shown] so the speaker knows when to switch to screen recording.

Keep the language direct and peer-level. No corporate speak. No "leverage" or "utilize." Talk like you're explaining this to a smart friend over coffee.`;

// ════════════════════════════════════════════════════════════════════════
// POST /api/yt/ideas/generate
// Generate a batch of content ideas for a specific pillar (or mixed)
// ════════════════════════════════════════════════════════════════════════
router.post('/ideas/generate', async (req, res) => {
  try {
    const { pillar = 'mixed', count = 5, context = '' } = req.body;

    let userPrompt = '';
    if (pillar === 'mixed') {
      userPrompt = `Generate ${count} YouTube video ideas spread across different pillars. Mix it up — don't put more than 2 in the same pillar. Make each idea specific and compelling, not generic.`;
    } else {
      userPrompt = `Generate ${count} YouTube video ideas for the "${pillar}" pillar. Each idea should be distinct — different angles, different hooks, different value propositions. No two ideas should feel like the same video with a different title.`;
    }

    if (context) {
      userPrompt += `\n\nAdditional context from the creator: ${context}`;
    }

    // Check what ideas already exist to avoid duplicates
    const { data: existing } = await supabase
      .from('yt_content_ideas')
      .select('title')
      .in('status', ['idea', 'approved', 'scripted', 'recorded'])
      .limit(50);

    if (existing && existing.length > 0) {
      const existingTitles = existing.map(e => e.title).join('\n- ');
      userPrompt += `\n\nThese ideas already exist — do NOT generate anything similar:\n- ${existingTitles}`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: CONTENT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON from response
    let ideas;
    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      ideas = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse AI response:', text.substring(0, 500));
      return res.status(500).json({ error: 'Failed to parse AI response', raw: text.substring(0, 500) });
    }

    if (!Array.isArray(ideas) || ideas.length === 0) {
      return res.status(500).json({ error: 'AI returned no ideas' });
    }

    // Validate and insert each idea
    const validPillars = ['opportunity', 'proof', 'howto', 'industry', 'objection', 'comparison'];
    const validModes = ['figured_something_out', 'showing_screen', 'telling_friend'];

    const rows = ideas.map(idea => ({
      pillar: validPillars.includes(idea.pillar) ? idea.pillar : 'opportunity',
      title: (idea.title || '').substring(0, 200),
      hook: idea.hook || '',
      talking_points: Array.isArray(idea.talking_points) ? idea.talking_points : [],
      target_length: idea.target_length || '8-12 min',
      recording_mode: validModes.includes(idea.recording_mode) ? idea.recording_mode : 'figured_something_out',
      status: 'idea',
    }));

    const { data: inserted, error: insertErr } = await supabase
      .from('yt_content_ideas')
      .insert(rows)
      .select();

    if (insertErr) {
      console.error('Insert error:', insertErr);
      return res.status(500).json({ error: 'Failed to save ideas', details: insertErr.message });
    }

    console.log(`🎬 Generated ${inserted.length} YouTube content ideas`);
    res.json({ success: true, count: inserted.length, ideas: inserted });
  } catch (err) {
    console.error('Idea generation error:', err);
    res.status(500).json({ error: 'Failed to generate ideas' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/yt/ideas
// List all ideas with optional filters
// ════════════════════════════════════════════════════════════════════════
router.get('/ideas', async (req, res) => {
  try {
    const { status, pillar, limit = 50 } = req.query;

    let query = supabase
      .from('yt_content_ideas')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (status) query = query.eq('status', status);
    if (pillar) query = query.eq('pillar', pillar);

    const { data, error } = await query;

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, count: data.length, ideas: data });
  } catch (err) {
    console.error('List ideas error:', err);
    res.status(500).json({ error: 'Failed to list ideas' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/yt/ideas/:id
// Get a single idea
// ════════════════════════════════════════════════════════════════════════
router.get('/ideas/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('yt_content_ideas')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Idea not found' });
    }

    res.json({ success: true, idea: data });
  } catch (err) {
    console.error('Get idea error:', err);
    res.status(500).json({ error: 'Failed to get idea' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// PUT /api/yt/ideas/:id
// Update an idea (edit title, approve, add notes, change status, etc.)
// ════════════════════════════════════════════════════════════════════════
router.put('/ideas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Only allow updating specific fields
    const allowed = ['title', 'hook', 'talking_points', 'script', 'target_length', 'recording_mode', 'status', 'notes', 'pillar'];
    const filtered = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) filtered[key] = updates[key];
    }

    if (Object.keys(filtered).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('yt_content_ideas')
      .update(filtered)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    console.log(`🎬 Updated idea ${id}: ${Object.keys(filtered).join(', ')}`);
    res.json({ success: true, idea: data });
  } catch (err) {
    console.error('Update idea error:', err);
    res.status(500).json({ error: 'Failed to update idea' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// DELETE /api/yt/ideas/:id
// Delete an idea
// ════════════════════════════════════════════════════════════════════════
router.delete('/ideas/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('yt_content_ideas')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: 'Idea deleted' });
  } catch (err) {
    console.error('Delete idea error:', err);
    res.status(500).json({ error: 'Failed to delete idea' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/yt/ideas/:id/script
// Generate a loose script for an approved idea
// ════════════════════════════════════════════════════════════════════════
router.post('/ideas/:id/script', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: idea, error: fetchErr } = await supabase
      .from('yt_content_ideas')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !idea) {
      return res.status(404).json({ error: 'Idea not found' });
    }

    const userPrompt = `Write a loose talking-head script for this YouTube video:

Title: ${idea.title}
Pillar: ${idea.pillar}
Hook: ${idea.hook}
Target Length: ${idea.target_length}
Recording Mode: ${idea.recording_mode}
Talking Points:
${(idea.talking_points || []).map((tp, i) => `${i + 1}. ${tp}`).join('\n')}
${idea.notes ? `\nCreator notes: ${idea.notes}` : ''}

Write the script as a roadmap — what to say in each block, key phrases to hit, where to show screen recordings. NOT a teleprompter script. The speaker should be able to glance at this and riff naturally.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: SCRIPT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const script = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Save script to the idea
    const { data: updated, error: updateErr } = await supabase
      .from('yt_content_ideas')
      .update({ script, status: 'scripted' })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ error: 'Failed to save script', details: updateErr.message });
    }

    console.log(`🎬 Generated script for idea: ${idea.title}`);
    res.json({ success: true, idea: updated });
  } catch (err) {
    console.error('Script generation error:', err);
    res.status(500).json({ error: 'Failed to generate script' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/yt/ideas/stats/summary
// Quick stats: count by status and pillar
// ════════════════════════════════════════════════════════════════════════
router.get('/ideas/stats/summary', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('yt_content_ideas')
      .select('status, pillar');

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const byStatus = {};
    const byPillar = {};
    (data || []).forEach(row => {
      byStatus[row.status] = (byStatus[row.status] || 0) + 1;
      byPillar[row.pillar] = (byPillar[row.pillar] || 0) + 1;
    });

    res.json({ success: true, total: data.length, byStatus, byPillar });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

module.exports = router;
