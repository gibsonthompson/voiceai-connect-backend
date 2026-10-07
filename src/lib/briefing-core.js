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

const WX_LAT = 33.9562;
const WX_LON = -83.9880;
const WX_PLACE = 'Lawrenceville';

function requireSecret(req, res, next) {
  const secret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

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

async function fetchWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WX_LAT}&longitude=${WX_LON}`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code`
      + `&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=1`;
    const res = await getWithTimeout(url, 8000);
    if (!res.ok) return null;
    const d = await res.json();
    const day = d.daily || {};
    const hi = Math.round((day.temperature_2m_max || [])[0]);
    const lo = Math.round((day.temperature_2m_min || [])[0]);
    const pop = (day.precipitation_probability_max || [])[0];
    const code = (day.weather_code || [])[0];
    const cond = WMO[code] || 'mixed conditions';
    if (!isFinite(hi) || !isFinite(lo)) return null;
    return { hi, lo, pop, cond, place: WX_PLACE };
  } catch (e) {
    console.warn('⚠️ Briefing weather failed:', e.message);
    return null;
  }
}

function weatherLine(w) {
  if (!w) return null;
  const rain = (typeof w.pop === 'number' && w.pop >= 20) ? `, ${w.pop}% chance of rain` : '';
  return `${w.place} today: ${w.cond}, high ${w.hi}, low ${w.lo}${rain}.`;
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

  const [schedule, openMovers, goals, weather, ai, local, politics, falcons] = await Promise.all([
    ready ? hq.listScheduleForDate(etDate, dow) : Promise.resolve([]),
    ready ? hq.listOpenMovers() : Promise.resolve([]),
    ready ? hq.listGoals() : Promise.resolve([]),
    fetchWeather(),
    news.briefAI(),
    news.briefLocal(weekend),
    news.briefPolitics(),
    news.briefFalcons(),
  ]);

  const now = Date.now();
  const openTasks = (openMovers || []).slice(0, 30).map((t) => ({
    text: t.text,
    venture: t.venture || 'General',
    ageDays: t.ts ? Math.floor((now - t.ts) / 86400000) : null,
  }));

  return {
    date: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
    }).format(new Date()),
    weekend,
    schedule: scheduleLine(schedule),
    openTasks,
    goal: (goals && goals[0]) ? goals[0].title : null,
    weatherLine: weatherLine(weather),
    news: { ai, local, politics, falcons },
  };
}

// ── Briefing assistant (reuses the live secretary's voice/model/pacing/tools) ─

// A spoken fallback if the Claude render fails, so the first message is never
// empty and the call can never go silent.
function buildFallbackBriefing(ctx) {
  const p = ['Good morning Gibson. Here is your day.'];
  if (ctx.schedule && ctx.schedule !== 'clear') p.push(`On your calendar, ${ctx.schedule}.`);
  else p.push('Your calendar is open today.');
  if (ctx.weatherLine) p.push(ctx.weatherLine);
  if (ctx.news.ai) p.push(`In AI, ${ctx.news.ai}`);
  if (ctx.news.local) p.push(`Around Atlanta, ${ctx.news.local}`);
  if (ctx.news.politics) p.push(`Nationally, ${ctx.news.politics}`);
  if (ctx.news.falcons) p.push(ctx.news.falcons);
  p.push('Anything you want to add or change?');
  return p.join(' ');
}

// Render the ENTIRE briefing as one spoken monologue. This becomes the call's
// first message, so VAPI speaks the whole thing instead of waiting for Gibson.
async function renderBriefingText(ctx) {
  const prompt = `You are Gibson's chief of staff delivering his morning briefing out loud over the phone. Write the complete briefing as one flowing spoken monologue that he hears start to finish. Warm, grounded, sharp, never perky, no fake cheer. Plain spoken text only: no markdown, no bullet points, no numbered list, no symbols, no em dashes. Say numbers, dates, and times as words. Never say how many of anything there are, never read labels.

Deliver in this order, and skip anything with no data without mentioning it:
1. His day. Walk through today's calendar in time order, a sentence or two. If the schedule shows clear, tell him his calendar is open today.
2. His single highest-leverage move from his open tasks, with one line on why. Weigh how long it has sat and that VoiceAI Connect is his main business. Pick exactly one, do not list them.
3. The goal he is pushing, one quick line, only if there is one.
4. Weather, one line.
5. AI news, from the ai summary.
6. Around Atlanta, from the local summary.
7. Politics, from the politics summary, neutral and factual.
8. Falcons, one quick beat, only if there is something.
End by asking if there is anything he wants to add or change.

Today's data as JSON:
${JSON.stringify(ctx)}

Write only the spoken briefing, nothing else.`;
  const text = await news.complete(prompt, 1100);
  return (text && text.length > 40) ? text : buildFallbackBriefing(ctx);
}

// System prompt for AFTER the briefing is spoken: handle his follow-ups and
// anything he wants to add, as the secretary (tasks by default, must call tools).

module.exports = { assembleBriefing, renderBriefingText, buildFallbackBriefing, etHour, etDateInfo, isWeekendish, fetchWeather, weatherLine };