// ============================================================================
// BRIEFING CORE  (destination: src/lib/briefing-core.js)
// ----------------------------------------------------------------------------
// Shared assembly + render for the morning briefing, so BOTH the cron route
// (routes/jarvis-briefing.js) and the on-demand call-in tool (the webhook's
// hq_todays_briefing) produce the identical briefing from one place. Pulls the
// calendar, top tasks, goal, weather, and the Claude-summarized news.
// ============================================================================

'use strict';

const hq = require('./hq-supabase');
const items = require('./hq-items');
const news = require('./briefing-news');
const googleCal = require('./google-calendar');
const { getPlatformSetting, setPlatformSetting } = require('./vapi');

// Where the most recent fully-rendered briefing is cached. The morning cron
// (and an optional prewarm) warm this, so the briefing call and an on-demand
// call-in hand back the cached text instantly instead of re-running the slow
// news research and render, which overran VAPI's tool timeout and made the
// assistant say the server timed out.
const BRIEFING_CACHE_KEY = 'jarvis_briefing_cache';
const BRIEFING_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Self-contained Claude call (same Anthropic setup the rest of the backend
// uses). Kept here so rendering never depends on another file exporting it.
const BRIEF_CLAUDE_MODEL = 'claude-sonnet-4-6';
async function completeClaude(prompt, maxTokens) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
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
        model: BRIEF_CLAUDE_MODEL,
        max_tokens: maxTokens || 1000,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) { console.warn('⚠️ briefing render failed:', res.status); return null; }
    const data = await res.json();
    const text = data && data.content && data.content[0] && data.content[0].text;
    return text ? text.trim() : null;
  } catch (e) {
    console.warn('⚠️ briefing render error:', e.message);
    return null;
  } finally { clearTimeout(t); }
}

const WX_LAT = 33.9562;
const WX_LON = -83.9880;
const WX_PLACE = 'Lawrenceville';

// Current hour in America/New_York (0-23), DST-correct.
function etHour() {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false, hourCycle: 'h23' }).format(new Date());
  return parseInt(h, 10);
}

// Today's date (YYYY-MM-DD) and weekday (0-6) in America/New_York, for the HQ
// schedule lookup.
function etDateInfo() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return { date: s, dow: dt.getUTCDay() };
}

function isWeekendish() {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
  return wd === 'Fri' || wd === 'Sat' || wd === 'Sun';
}

// Plain-English current date and time in Gibson's timezone. Injected into every
// prompt so the model never guesses the date. It was answering "June 2024" (its
// training prior) because nothing told it what day it actually is, which also
// drove the Falcons "they play tonight" error.
function etNowString() {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date());
  return `${s} Eastern`;
}

// Just the weekday + date (no time), for prompts that want the day only.
function etTodayString() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).format(new Date());
}

async function getWithTimeout(url, ms, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, headers: headers || {} }); }
  finally { clearTimeout(t); }
}

// ── Weather (Open-Meteo, no key) ────────────────────────────────────────────

const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy',
  45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow',
  80: 'rain showers', 81: 'rain showers', 82: 'heavy rain showers',
  85: 'snow showers', 86: 'snow showers',
  95: 'thunderstorms', 96: 'thunderstorms', 99: 'severe thunderstorms',
};

const WIND_DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
function windDir(deg) {
  if (typeof deg !== 'number' || !isFinite(deg)) return '';
  return WIND_DIRS[Math.round(deg / 45) % 8];
}

// Format an Open-Meteo local ISO time ("2026-10-09T19:12") to "7:12 PM".
function clockFromIso(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

async function fetchWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WX_LAT}&longitude=${WX_LON}`
      + `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunrise,sunset,uv_index_max`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York&forecast_days=1`;
    const res = await getWithTimeout(url, 8000);
    if (!res.ok) return null;
    const d = await res.json();
    const day = d.daily || {};
    const cur = d.current || {};
    const hi = Math.round((day.temperature_2m_max || [])[0]);
    const lo = Math.round((day.temperature_2m_min || [])[0]);
    const pop = (day.precipitation_probability_max || [])[0];
    const code = (day.weather_code || [])[0];
    const cond = WMO[code] || 'mixed conditions';
    if (!isFinite(hi) || !isFinite(lo)) return null;
    const now = isFinite(Math.round(cur.temperature_2m)) ? Math.round(cur.temperature_2m) : null;
    const feels = isFinite(Math.round(cur.apparent_temperature)) ? Math.round(cur.apparent_temperature) : null;
    const nowCond = WMO[cur.weather_code] || null;
    const wind = isFinite(Math.round(cur.wind_speed_10m)) ? Math.round(cur.wind_speed_10m) : null;
    const wdir = windDir(cur.wind_direction_10m);
    const sunset = clockFromIso((day.sunset || [])[0]);
    const uvRaw = (day.uv_index_max || [])[0];
    const uv = (typeof uvRaw === 'number' && isFinite(uvRaw)) ? Math.round(uvRaw) : null;
    return { hi, lo, pop, cond, place: WX_PLACE, now, feels, nowCond, wind, wdir, sunset, uv };
  } catch (e) {
    console.warn('⚠️ Briefing weather failed:', e.message);
    return null;
  }
}

// A fuller spoken weather read: what it is doing right now, where it is headed,
// rain, wind, and when the sun goes down. Plain spoken sentences.
function weatherLine(w) {
  if (!w) return null;
  const parts = [];
  if (w.now != null) {
    let right = `Right now in ${w.place} it is ${w.now}${w.nowCond ? ' and ' + w.nowCond : ''}`;
    if (w.feels != null && Math.abs(w.feels - w.now) >= 3) right += `, feels like ${w.feels}`;
    parts.push(right + '.');
  }
  let out = `Today you're looking at a high of ${w.hi} and a low of ${w.lo}, ${w.cond}`;
  if (typeof w.pop === 'number' && w.pop >= 20) out += `, with a ${w.pop}% chance of rain`;
  parts.push(out + '.');
  if (w.wind != null && w.wind >= 8) parts.push(`Wind around ${w.wind} out of the ${w.wdir}.`);
  if (w.uv != null) {
    const band = w.uv >= 8 ? 'very high' : w.uv >= 6 ? 'high' : w.uv >= 3 ? 'moderate' : 'low';
    parts.push(`UV index peaks around ${w.uv}, ${band}.`);
  }
  if (w.sunset) parts.push(`Sun sets at ${w.sunset}.`);
  const note = weatherNote(w);
  if (note) parts.push(note);
  return parts.join(' ');
}

// A practical takeaway pulled from the day's numbers, so the weather ends with
// something actionable rather than just readings. One short note, highest
// priority first.
function weatherNote(w) {
  if (!w) return null;
  if (typeof w.pop === 'number' && w.pop >= 60) return 'Take an umbrella, rain is likely.';
  if (w.uv != null && w.uv >= 6) return 'Wear sunscreen if you are out for a while, the sun is strong.';
  if (typeof w.hi === 'number' && w.hi <= 40) return 'Bundle up, it stays cold.';
  if (typeof w.hi === 'number' && w.hi >= 90) return 'Stay hydrated, it gets hot.';
  if (typeof w.pop === 'number' && w.pop >= 30) return 'Maybe keep an umbrella handy.';
  if (w.wind != null && w.wind >= 18) return 'It is breezy, so a jacket helps.';
  return null;
}

// ── Schedule line ───────────────────────────────────────────────────────────

function scheduleLine(sched) {
  if (!sched || !sched.length) return 'clear';
  return sched.map((e) => (e.allDay ? `all day ${e.title}` : `${items.fmtHour(e.startHour)} ${e.title}`)).join('; ');
}

// ── Assemble ────────────────────────────────────────────────────────────────

async function assembleBriefing() {
  const { date: etDate, dow } = etDateInfo();
  const weekend = isWeekendish();
  const ready = hq.isReady();
  const todayStr = etTodayString();

  // Pull the real next Falcons game first so the summary can state the actual
  // day instead of guessing "tonight" off a headline.
  const falconsGame = await news.nextFalconsGame().catch(() => null);

  const [hqSchedule, openMovers, goals, weather, ai, local, politics, falcons, voiceai, trades, crypto, gcalEvents] = await Promise.all([
    ready ? hq.listScheduleForDate(etDate, dow) : Promise.resolve([]),
    ready ? hq.listOpenMovers() : Promise.resolve([]),
    ready ? hq.listGoals() : Promise.resolve([]),
    fetchWeather(),
    news.briefAI(todayStr),
    news.briefLocal(weekend, todayStr),
    news.briefPolitics(todayStr),
    news.briefFalcons(todayStr, falconsGame),
    news.briefVoiceAI(todayStr),
    news.briefTrades(todayStr),
    news.briefCrypto(todayStr),
    googleCal.listEventsForDate(etDate).catch(() => []),
  ]);

  // Merge his real Google Calendar into the HQ schedule so the day's lead-in
  // reflects both. Same { title, startHour, allDay } shape, all-day first then
  // by time.
  const schedule = [...(hqSchedule || []), ...(gcalEvents || [])].sort((a, b) => {
    if (a.allDay && !b.allDay) return -1;
    if (b.allDay && !a.allDay) return 1;
    return (a.startHour || 0) - (b.startHour || 0);
  });

  const now = Date.now();
  const openTasks = (openMovers || []).slice(0, 30).map((t) => ({
    text: t.text,
    venture: t.venture || 'General',
    ageDays: t.ts ? Math.floor((now - t.ts) / 86400000) : null,
  }));

  return {
    now: etNowString(),
    date: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
    }).format(new Date()),
    weekend,
    schedule: scheduleLine(schedule),
    openTasks,
    goal: (goals && goals[0]) ? goals[0].title : null,
    weatherLine: weatherLine(weather),
    news: { ai, voiceai, local, politics, trades, crypto, falcons },
  };
}

// ── Briefing assistant (reuses the live secretary's voice/model/pacing/tools) ─

// A spoken fallback if the Claude render fails, so the first message is never
// empty and the call can never go silent.
function buildFallbackBriefing(ctx) {
  const p = ['Good morning Gibson. Here is your day.'];
  if (ctx.schedule && ctx.schedule !== 'clear') p.push(`On your calendar, ${ctx.schedule}.`);
  else p.push('Your calendar is open today.');
  if (ctx.openTasks && ctx.openTasks.length) {
    const top = ctx.openTasks[0];
    p.push(`Top of your list, ${top.text}${top.venture && top.venture !== 'General' ? ', for ' + top.venture : ''}.`);
  }
  if (ctx.goal) p.push(`You're pushing toward ${ctx.goal}.`);
  if (ctx.weatherLine) p.push(ctx.weatherLine);
  if (ctx.news.ai) p.push(`In AI, ${ctx.news.ai}`);
  if (ctx.news.voiceai) p.push(`In voice AI, ${ctx.news.voiceai}`);
  if (ctx.news.local) p.push(`Around Atlanta, ${ctx.news.local}`);
  if (ctx.news.politics) p.push(`Nationally, ${ctx.news.politics}`);
  if (ctx.news.trades) p.push(`On notable trades, ${ctx.news.trades}`);
  if (ctx.news.crypto) p.push(`In crypto, ${ctx.news.crypto}`);
  if (ctx.news.falcons) p.push(ctx.news.falcons);
  p.push('Anything you want to add or change?');
  return p.join(' ');
}

// Render the ENTIRE briefing as one spoken monologue. This becomes the call's
// first message, so VAPI speaks the whole thing instead of waiting for Gibson.
async function renderBriefingText(ctx) {
  const prompt = `Right now it is ${ctx.now || etNowString()}. That is the current date and time, use it as truth, never state any other year or date.

You are Gibson's chief of staff delivering his morning briefing out loud over the phone. Write the complete briefing as one flowing spoken monologue that he hears start to finish. Warm, grounded, sharp, never perky, no fake cheer. Keep it tight and snappy, short punchy sentences, he is busy and wants the signal, not padding. Plain spoken text only: no markdown, no bullet points, no numbered list, no symbols, no em dashes. Say numbers, dates, and times as words. Never say how many of anything there are, never read labels.

Deliver in this order, and skip anything with no data without mentioning it:
1. His day. Walk through today's calendar in time order, a sentence or two. If the schedule shows clear, tell him his calendar is open today.
2. His single highest-leverage move from his open tasks, with one line on why. Weigh how long it has sat and that VoiceAI Connect is his main business. Pick exactly one, do not list them.
3. The goal he is pushing, one quick line, only if there is one.
4. Weather, give him the real read from the weather data provided: what it is doing right now, where the day is headed with the high and low, any rain, the wind, and when the sun sets. A few natural sentences, not one clipped line.
5. AI news, from the ai summary.
6. Voice AI, from the voiceai summary, the space he builds in, so give it weight.
7. Around Atlanta, from the local summary.
8. Politics, from the politics summary, neutral and factual.
9. Notable trades, from the trades summary: disclosed politician trades like Pelosi and other big moves. State it factually, never as advice.
10. Crypto, from the crypto summary: meme and political coins and where the majors sit. Factual, never advice.
11. Falcons, one quick beat, only if there is something.
End by asking if there is anything he wants to add or change.

Today's data as JSON:
${JSON.stringify(ctx)}

Write only the spoken briefing, nothing else.`;
  const text = await completeClaude(prompt, 1800);
  return (text && text.length > 40) ? text : buildFallbackBriefing(ctx);
}

// ── Cache (so the briefing call and in-call briefing never pay the slow cost) ─

// Assemble and render the briefing once, then cache the finished text + ctx.
// The morning cron, an optional prewarm, and an on-demand call-in all go
// through here, so the text is ready for the next read without re-researching.
async function assembleAndRenderBriefing() {
  const ctx = await assembleBriefing();
  const text = await renderBriefingText(ctx);
  try {
    await setPlatformSetting(BRIEFING_CACHE_KEY, { text, ctx, ts: Date.now() });
  } catch (e) {
    console.warn('⚠️ briefing cache write failed:', e.message);
  }
  return { ctx, text };
}

// Return the cached briefing if it is still fresh, else null. Fresh means it
// was rendered within maxAgeMs (default six hours), so a mid-morning read gets
// today's briefing, not yesterday's.
async function getFreshBriefing(maxAgeMs) {
  const limit = maxAgeMs || BRIEFING_CACHE_MAX_AGE_MS;
  try {
    const c = await getPlatformSetting(BRIEFING_CACHE_KEY);
    if (c && c.text && c.ts && (Date.now() - c.ts) <= limit) {
      return { text: c.text, ctx: c.ctx || null, ageMs: Date.now() - c.ts };
    }
  } catch (e) {
    console.warn('⚠️ briefing cache read failed:', e.message);
  }
  return null;
}

// System prompt for AFTER the briefing is spoken: handle his follow-ups and
// anything he wants to add, as the secretary (tasks by default, must call tools).

module.exports = {
  assembleBriefing, renderBriefingText, assembleAndRenderBriefing, getFreshBriefing,
  buildFallbackBriefing, etHour, etDateInfo, etNowString, etTodayString,
  isWeekendish, fetchWeather, weatherLine,
};