// ============================================================================
// BRIEFING NEWS  (destination: src/lib/briefing-news.js)
// ----------------------------------------------------------------------------
// The research + summarization layer for the Jarvis morning briefing. For each
// topic it gathers recent items from several Google News RSS queries (keyless),
// pulls the title, snippet, source, and age, dedupes, then hands the batch to
// Claude to digest into a tight, substantive, SPOKEN summary (a couple of
// sentences), not a pile of raw headlines.
//
// Reuses the backend's existing Anthropic setup, matching src/lib/website-
// scraper.js exactly: POST https://api.anthropic.com/v1/messages with
// x-api-key: ANTHROPIC_API_KEY, anthropic-version 2023-06-01, model
// claude-sonnet-4-6. If ANTHROPIC_API_KEY is missing or a source is down, every
// function degrades gracefully to null and the briefing just skips that section.
// ============================================================================

'use strict';

const CLAUDE_MODEL = 'claude-sonnet-4-6';

async function getWithTimeout(url, ms, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: headers || {} });
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').trim();
}

// Google News suffixes each title with " - Source"; drop it for a clean read.
function cleanHeadline(t) {
  const s = decodeEntities(t);
  const i = s.lastIndexOf(' - ');
  return (i > 20 ? s.slice(0, i) : s).trim();
}

// Pull recent items for one query from Google News RSS: title, snippet (from
// the description, HTML stripped), source, and age in hours from pubDate.
async function fetchRssItems(query, n) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await getWithTimeout(url, 9000, { 'User-Agent': 'Mozilla/5.0 (JarvisBriefing)' });
    if (!res.ok) return [];
    const xml = await res.text();
    const out = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && out.length < n) {
      const b = m[1];
      const tm = b.match(/<title>([\s\S]*?)<\/title>/);
      if (!tm) continue;
      const title = cleanHeadline(tm[1]);
      if (!title || title.length < 8) continue;
      const dm = b.match(/<description>([\s\S]*?)<\/description>/);
      let snippet = dm ? decodeEntities(dm[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
      if (snippet.length > 280) snippet = snippet.slice(0, 280);
      const sm = b.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      const source = sm ? decodeEntities(sm[1]) : '';
      const pm = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      let ageHours = null;
      if (pm) {
        const d = new Date(decodeEntities(pm[1]));
        if (!isNaN(d.getTime())) ageHours = Math.max(0, Math.round((Date.now() - d.getTime()) / 3600000));
      }
      out.push({ title, snippet, source, ageHours });
    }
    return out;
  } catch (e) {
    console.warn(`⚠️ briefing RSS failed (${query}):`, e.message);
    return [];
  }
}

// Gather across several queries for one topic, dedupe by title, newest first.
async function gatherTopic(queries, perQuery, cap) {
  const batches = await Promise.all(queries.map((q) => fetchRssItems(q, perQuery)));
  const seen = new Set();
  const items = [];
  for (const batch of batches) {
    for (const it of batch) {
      const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  }
  items.sort((a, b) => (a.ageHours == null ? 999 : a.ageHours) - (b.ageHours == null ? 999 : b.ageHours));
  return items.slice(0, cap);
}

// Digest gathered items into a spoken summary via Claude. Returns a clean
// plain-text paragraph, or null if the key is missing, there is nothing to
// summarize, or the call fails.
async function summarize(guidance, items, maxTokens) {
  if (!process.env.ANTHROPIC_API_KEY || !items || !items.length) return null;
  const list = items.map((it) => {
    const bits = [];
    if (it.source) bits.push(it.source);
    if (it.ageHours != null) bits.push(`${it.ageHours}h ago`);
    const tag = bits.length ? ` (${bits.join(', ')})` : '';
    return `- ${it.title}${tag}${it.snippet ? `\n  ${it.snippet}` : ''}`;
  }).join('\n');
  const prompt = `${guidance}\n\nToday's raw headlines and snippets:\n\n${list}\n\nWrite the spoken summary now. Plain text only, no markdown, no bullet points, no numbered list, no em dashes, no special characters. It is read aloud over the phone, so it must flow as natural spoken sentences.`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens || 320,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) { console.warn('⚠️ briefing summarize failed:', res.status); return null; }
    const data = await res.json();
    const text = data && data.content && data.content[0] && data.content[0].text;
    return text ? text.trim() : null;
  } catch (e) {
    console.warn('⚠️ briefing summarize error:', e.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── Topic briefs ────────────────────────────────────────────────────────────

async function briefAI() {
  const items = await gatherTopic(
    ['artificial intelligence news', 'OpenAI OR Anthropic OR Google DeepMind', 'new AI model OR AI product launch'],
    4, 10,
  );
  return summarize(
    'You are briefing a sharp solo founder who builds AI voice software, on today\'s AI news. In two or three spoken sentences, tell him the few things that actually matter today: new model or product releases, major company moves, anything relevant to someone building with AI. Be specific, name the companies and models. Cut the hype.',
    items, 320,
  );
}

async function briefLocal(weekend) {
  const items = await gatherTopic(
    weekend
      ? ['things to do Atlanta this weekend', 'Lawrenceville Georgia news', 'Gwinnett County Georgia news']
      : ['Atlanta Georgia local news', 'Lawrenceville Georgia news', 'Gwinnett County Georgia news'],
    4, 10,
  );
  return summarize(
    `You are briefing someone who lives near Lawrenceville in the Atlanta metro, on local news. In two or three spoken sentences, give him what is worth knowing around town today${weekend ? ', and since it is the weekend, work in anything good going on this weekend' : ''}. Keep it local and relevant, skip national stories.`,
    items, 320,
  );
}

async function briefPolitics() {
  const items = await gatherTopic(
    ['US national news today', 'Congress legislation OR federal policy', 'US economy OR inflation OR gas prices'],
    4, 12,
  );
  return summarize(
    'You are giving a strictly nonpartisan, high-level briefing of the US national news every American should know today. In two or three spoken sentences, cover only the consequential things: major legislation or government decisions, the economy, anything with real impact on an ordinary person. No spin, no opinion, no partisan framing, no political horse-race noise.',
    items, 320,
  );
}

async function briefFalcons() {
  const items = await gatherTopic(['Atlanta Falcons'], 5, 6);
  return summarize(
    'You are a friend catching him up on the Atlanta Falcons. In one or two short, casual spoken sentences, give the latest that matters: last game result, key injuries, or the next game. Keep it light.',
    items, 180,
  );
}

module.exports = { briefAI, briefLocal, briefPolitics, briefFalcons, fetchRssItems, gatherTopic, summarize };
