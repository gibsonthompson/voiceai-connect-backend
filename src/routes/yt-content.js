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
const CONTENT_SYSTEM_PROMPT = `You are a YouTube Shorts content strategist for VoiceAI Connect, a white-label AI receptionist platform for agencies. You generate video content ideas optimized for the YouTube Shorts algorithm.

=== TARGET VIEWER ===

18-30 years old. First-time entrepreneurs or people who've tried other business models — building websites, selling SEO services, running a GoHighLevel SaaS, dropshipping, SMMA. They haven't found the model that sticks yet. They know AI is changing everything and they want in, but they're skeptical of "make money with AI" content. They want a real business with real recurring revenue, not a side hustle or a course.

They're watching this on their phone, late at night, thinking "is this actually legit?" Your job is to make them lean in and think "wait, this could actually work."

=== WHAT VOICEAI CONNECT IS ===

A white-label AI receptionist platform. Agencies brand it as their own, sign up local businesses (plumbers, dentists, HVAC, lawyers, restaurants, etc.), and charge them $99-$299/month for 24/7 AI phone answering. The AI picks up calls, answers questions from the business's knowledge base, books appointments to Google Calendar, transfers urgent calls to the owner, and texts a summary after every call.

The agency's cost: $99/mo platform + $9.99/client. They charge clients $149/mo+. Margin is 90%+. The product runs itself — no ongoing delivery work, no campaign management, no reporting. Set up the AI once, collect recurring revenue.

Free plan available (no platform fee, higher per-client cost). Google Calendar integration on all plans. No technical skills required.

=== YOUTUBE SHORTS ALGORITHM — WHAT YOU MUST KNOW ===

The algorithm uses an explore-and-exploit model. Every Short gets a small seed audience. Three signals determine whether it gets pushed wider:

1. SWIPE-AWAY RATE — if 40%+ swipe away in the first 3 seconds, the video is dead. The hook is everything.
2. COMPLETION RATE — a 30-second Short with 85% completion beats a 60-second Short with 50% completion.
3. ENGAGEMENT DENSITY — comments weighted more than likes. Shorts that prompt specific actions drive stronger signals.

RETENTION GATES: The algorithm checks at 3 seconds (initial distribution), 15 seconds (sustained push), and completion (broader audiences). Structure content around these checkpoints.

OPTIMAL LENGTH: 20-25 seconds is the sweet spot. Under 15 seconds lacks hook depth. Over 45 seconds sees dramatic retention drop-off.

LOOPS: Scripts where the end flows back into the beginning drive rewatches — the strongest positive signal.

=== HOOK FORMULAS THAT WORK ===

Every hook you write MUST use one of these proven formats:

- BOLD CLAIM: A counterintuitive or surprising statement. "This $9.99 tool replaced a $3,000/month employee."
- CURIOSITY GAP: An incomplete statement that creates tension. "I found the one thing every successful agency does differently."
- DIRECT ADDRESS: Call out the specific audience. "If you've tried selling websites and it didn't work — watch this."
- RESULT FIRST: Show the end result. "Here's the dashboard that runs my entire $7k/month business."

NEVER open with: "In this video," "Have you ever wondered," "What if I told you," "Hey guys today we're gonna," or any slow zoom-in with no text.

=== STORYBRAND POSITIONING ===

The viewer is the hero. VoiceAI Connect is the tool the guide hands them. Never "VoiceAI Connect is amazing." Always "here's how people your age are building $5-20k/month businesses by solving the missed call problem for local businesses."

The founder (Gibson) is the guide — a builder sharing what he's figured out, not a guru selling a dream. Direct, honest, peer-to-peer. Never condescending. Never hype.

=== CONTENT PILLARS ===

1. OPPORTUNITY — Why this business model exists now. The missed call economy, cost gap between human receptionists and AI, timing advantage.
2. PROOF & TRANSPARENCY — Real numbers, real dashboards, real margins. What it actually costs. This pillar converts hardest because the target viewer has been burned by opaque promises.
3. HOW-TO & TUTORIALS — Specific walkthroughs. How to set up, demo, get first clients, price the service. Screen recordings with face in corner.
4. INDUSTRY BREAKDOWNS — Deep dives into specific verticals (HVAC, dental, legal, restaurants). Problem → AI solution → what the call sounds like → dashboard.
5. OBJECTION HANDLING — "Do callers know it's AI?" "Is it saturated?" "Do I need technical skills?" Converts highest because viewers are already considering.
6. COMPARISON — VoiceAI Connect vs GoHighLevel, AI vs human receptionist, white-label vs building your own.

=== ANTI-AI RULES FOR HOOKS ===

Hooks must sound like a real person, not a copywriter:
- Use full contractions (don't, can't, it's, won't)
- Mix sentence lengths: 1-3 word punchlines next to 12-word sentences
- Never use parallel structure ("It's faster. It's cheaper. It's better." — NO)
- Start mid-thought as if the camera caught you already talking
- No motivational platitudes ("your time is now," "the future is here")

=== OUTPUT FORMAT ===

Return a JSON array of idea objects. Each idea must have:
- pillar: one of "opportunity", "proof", "howto", "industry", "objection", "comparison"
- title: YouTube-optimized title (compelling, specific, under 70 chars ideal)
- hook: the exact opening 3 seconds — written as spoken words, using one of the hook formulas above. Must sound human, not written.
- talking_points: array of 3-5 strings, each a key beat to hit. Keep them tight — one idea per point.
- target_length: "20-30s" for most Shorts, "45-60s" for deeper topics, "8-12 min" for long-form only
- recording_mode: one of "figured_something_out", "showing_screen", "telling_friend"

Return ONLY the JSON array, no markdown formatting, no preamble.`;

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
const SCRIPT_SYSTEM_PROMPT = `You write spoken scripts for YouTube Shorts. Your output is what a real person says out loud on camera. NOT a blog post. NOT prose. Spoken words with stage directions.

=== VOICE RULES (NEVER BREAK THESE) ===

1. USE FULL CONTRACTIONS ALWAYS — "don't" not "do not," "can't" not "cannot," "it's" not "it is," "they're" not "they are." Every single time. No exceptions.

2. MIX SENTENCE LENGTHS AGGRESSIVELY — One-word punchlines next to 12-word sentences. "Stop. That number's wrong. And here's why it matters more than anything else you'll hear today." The rhythm of short-long-short is what makes spoken content feel alive.

3. INCLUDE NATURAL SPEECH PATTERNS — "look," "here's the thing," "honestly," "wait, actually," "no seriously," "okay so." These aren't filler — they're pacing devices that create the feeling of someone thinking in real time.

4. USE SELF-CORRECTIONS — "it costs — actually no, it saves you money." "I thought it was hard — turns out I was wrong." Real people correct themselves mid-sentence.

5. BREAK GRAMMAR RULES — Start sentences with "And" and "But." Use fragments. "Who do you think I called?" not "Whom do you think I called?" Write how people talk, not how they write.

6. KILL PARALLEL STRUCTURE — Never write lists where every item has the same sentence structure. "It's faster. It's cheaper. It's better" = AI. "It's faster — like, not even close. Cheaper too. And honestly? It just works better." = human.

7. NO GENERIC INTROS — Never start with "In this video," "Have you ever wondered," "What if I told you," "Welcome to my channel," or any variant. Start mid-thought, mid-story, mid-argument.

8. NO MOTIVATIONAL PLATITUDES — Never write "your time is now," "the future is here," "stop dreaming and start doing," or any generic motivational language. Be specific and concrete.

9. NO SUMMARY ENDINGS — Never end by summarizing what you just said. End with a specific action, a cliffhanger, or a loop back to the beginning.

=== SCRIPT STRUCTURE FOR SHORTS (20-60 seconds) ===

Use HOOK → POINTS → CTA structure, NOT the 4-block long-form structure:

HOOK (0-3 seconds): One sentence. Bold claim, curiosity gap, or direct address. The most important sentence in the entire script. Must stop the scroll. Written as if the camera caught you mid-thought.

POINTS (3-45 seconds): ONE main idea with 2-3 sub-points max. Each sub-point is a mini-revelation. Between points, use micro-hooks: "but here's what nobody mentions," "and this is where it gets crazy." If you have more than one main idea, you have two scripts.

CTA (last 5 seconds): ONE specific action. "Follow for part 2." "Drop your niche in the comments." "Link in bio." NOT "like and subscribe."

=== RETENTION GATES ===

The YouTube algorithm checks retention at 3 seconds, 15 seconds, and completion. Structure accordingly:
- Your absolute best content must hit at 2-3 seconds (the hook)
- A secondary hook or payoff should land around 14-15 seconds
- The ending should either loop back to the beginning or leave a cliffhanger

=== LOOP TECHNIQUE ===

When possible, write the ending so it flows back into the beginning. End mid-sentence that the hook completes. Or end with "but that's not even the craziest part" and open with the crazy part. Loops drive rewatches — the strongest algorithmic signal.

=== FORMAT ===

Write as spoken script with stage directions:

HOOK:
[What the speaker says — exactly as they'd say it on camera]

POINTS:
[What they say, with [VISUAL: ...] cues for on-screen text or screen recordings]
[Micro-hook transition]
[Next point]

CTA:
[Natural closing + one specific action]

Mark [SCREEN: ...] for screen recording moments. Mark [TEXT ON SCREEN: ...] for caption overlays. Mark [CUT] for jump cut moments.

=== WHAT NEVER TO DO ===

- Rhetorical questions with obvious answers ("Do you want to make more money?")
- Smooth transitions — jump cuts are fine and expected in Shorts
- Blog-post language read aloud ("It is important to note that..." — NO)
- Ending with a summary of what you just said
- Any sentence that sounds "written" instead of "spoken"
- Corporate words: leverage, utilize, innovative, solution, comprehensive
- Lists where every item has identical sentence structure

=== VOICE ===

The speaker is a 25-year-old builder. Direct. Honest. Talks like he's explaining something to a smart friend, not lecturing a class. Uses "I" not "we." Says "look" and "honestly" and "here's the thing." Occasionally swears mildly if it fits. Never condescending. Never performative. The energy is "I figured something out and I think you should know about it."`;


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