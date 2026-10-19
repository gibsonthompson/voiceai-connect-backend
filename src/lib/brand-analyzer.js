// ============================================================================
// src/lib/brand-analyzer.js
//
// Turns an uploaded logo into a full brand kit using Claude vision.
//
// The hybrid approach: the CALLER sends the accurate dominant palette it pulled
// from the logo's pixels (exact hex is not something a vision model is reliable
// at). Claude then LOOKS at the logo plus that palette and returns the things
// pixels can't see: the vibe, which color is primary vs accent vs neutral, the
// light/dark recommendation, the display + body fonts that match the logo's own
// letterforms (chosen from our catalog), and an icon style. Everything Claude
// returns is validated here; anything invalid falls back to a safe default, so
// a bad/hallucinated response can never reach the agency row. If the vision call
// fails entirely, we still return a usable kit from the palette alone.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { validFont, validIconStyle, catalogForPrompt, DEFAULT_ICON_STYLE } = require('./brand-fonts');

// Matches the vision model the rest of the backend already runs (resto-ocr /
// resto-doc-scan). Override with BRAND_VISION_MODEL if needed.
const MODEL = process.env.BRAND_VISION_MODEL || 'claude-sonnet-4-6';
const HEX_RE = /^#([0-9a-fA-F]{6})$/;

// ---- small color helpers (no deps) -----------------------------------------
function normHex(h) {
  if (!h || typeof h !== 'string') return null;
  let s = h.trim();
  if (/^#([0-9a-fA-F]{3})$/.test(s)) s = '#' + s.slice(1).split('').map((c) => c + c).join('');
  return HEX_RE.test(s) ? s.toLowerCase() : null;
}
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function relLum({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const l1 = relLum(rgb(a)), l2 = relLum(rgb(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
// Readable text color to sit on a brand color (white or near-black, whichever wins).
function readableOn(hex) {
  return contrast(hex, '#ffffff') >= contrast(hex, '#0f172a') ? '#ffffff' : '#0f172a';
}
function isNeutral(hex) {
  const { r, g, b } = rgb(hex);
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  return sat < 0.15 || mx < 0.12 || mn > 0.88;
}

// Parse a data: URL or raw base64 into { media_type, data }. For an http(s) URL
// we fetch and base64 it. Returns null if we can't read an image.
async function toImageSource(logo) {
  if (!logo || typeof logo !== 'string') return null;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(logo.trim());
  if (m) return { type: 'base64', media_type: m[1], data: m[2] };
  if (/^https?:\/\//i.test(logo)) {
    try {
      const res = await fetch(logo);
      if (!res.ok) return null;
      const ct = res.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5 * 1024 * 1024) return null; // 5MB guard
      return { type: 'base64', media_type: ct.split(';')[0], data: buf.toString('base64') };
    } catch { return null; }
  }
  return null;
}

// Build the safe default kit from the palette alone (used as fallback and as the
// base we overlay Claude's choices onto).
function paletteKit(palette, name) {
  const dom = Array.isArray(palette && palette.dominant) ? palette.dominant.map((d) => normHex(d.hex)).filter(Boolean) : [];
  const brandish = dom.filter((h) => !isNeutral(h));
  const primary = brandish[0] || dom[0] || '#10b981';
  const secondary = brandish[1] || dom[1] || primary;
  const accent = brandish[2] || dom[2] || primary;
  const theme = (palette && (palette.suggestedTheme === 'light' ? 'light' : 'dark')) || 'dark';
  const bg = normHex(palette && palette.bgColor) || (theme === 'light' ? '#ffffff' : '#0a0b0f');
  return {
    vibe: { words: [], description: '' },
    logo_type: null,
    letterform: null,
    colors: {
      primary, secondary, accent,
      theme,
      logo_background_color: (palette && palette.bgTransparent) ? null : bg,
      primary_text: readableOn(primary),
    },
    palette: dom.map((hex, i) => ({ hex, role: i === 0 ? 'primary' : (isNeutral(hex) ? 'neutral' : 'accent'), pct: (palette.dominant[i] && palette.dominant[i].pct) || null })),
    fonts: { display: 'Sora', body: 'Inter', rationale: '' },
    icon_style: DEFAULT_ICON_STYLE,
    source: 'fallback',
  };
}

function buildPrompt(palette, name) {
  const dom = (palette && palette.dominant || []).map((d) => `${d.hex} (~${d.pct}% of the mark)`).join(', ') || '(none detected)';
  const themeHint = palette && palette.suggestedTheme ? palette.suggestedTheme : 'unknown';
  return `You are a senior brand designer. You are given a company logo image and the EXACT dominant colors pulled from its pixels. Design a cohesive dashboard brand kit.

Business name: ${name || '(unknown)'}
Exact logo colors (pixel-accurate, use THESE values, do not invent new hex): ${dom}
Logo background looks: ${themeHint}

Choose fonts ONLY from this catalog (use the family name exactly). Pick a DISPLAY font whose letterforms match the logo's own type, and a BODY font that pairs well and is highly readable:
${catalogForPrompt()}

Icon style options (nav icon weight): "fine" (elegant/luxury/light), "regular" (modern/clean/professional), "bold" (strong/techy/energetic).

Return ONLY valid JSON, no prose, in exactly this shape:
{
  "vibe": { "words": ["3-5 adjectives"], "description": "one short sentence" },
  "logo_type": "wordmark | lettermark | pictorial | combination | emblem",
  "letterform": "short description of the logo's type style, e.g. 'bold geometric sans'",
  "colors": {
    "primary": "#hex (the main brand color, pick from the exact colors above)",
    "secondary": "#hex",
    "accent": "#hex",
    "theme": "light | dark (what the dashboard should default to)"
  },
  "roles": [ { "hex": "#hex", "role": "primary|accent|neutral|background|text" } ],
  "fonts": { "display": "Exact Family Name", "body": "Exact Family Name", "rationale": "one short sentence on why these match the logo" },
  "icon_style": "fine | regular | bold"
}`;
}

// Main entry. opts: { logo (data URL / http url / base64), palette, name }.
async function analyzeLogo(opts) {
  const { logo, palette, name } = opts || {};
  const base = paletteKit(palette || {}, name);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const image = await toImageSource(logo);
  if (!apiKey || !image) {
    // No key or unreadable image: hand back the palette-only kit.
    return base;
  }

  let parsed = null;
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: image },
          { type: 'text', text: buildPrompt(palette || {}, name) },
        ],
      }],
    });
    const text = (resp && resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const jsonStr = text.startsWith('{') ? text : (text.match(/\{[\s\S]*\}/) || [null])[0];
    if (jsonStr) parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.warn('brand-analyzer: vision call failed, using palette fallback:', e.message);
    return base;
  }
  if (!parsed || typeof parsed !== 'object') return base;

  // ---- validate + merge onto the safe base ----
  const out = { ...base, source: 'ai' };

  if (parsed.vibe && typeof parsed.vibe === 'object') {
    out.vibe = {
      words: Array.isArray(parsed.vibe.words) ? parsed.vibe.words.filter((w) => typeof w === 'string').slice(0, 6) : [],
      description: typeof parsed.vibe.description === 'string' ? parsed.vibe.description.slice(0, 240) : '',
    };
  }
  if (typeof parsed.logo_type === 'string') out.logo_type = parsed.logo_type.slice(0, 40);
  if (typeof parsed.letterform === 'string') out.letterform = parsed.letterform.slice(0, 120);

  const c = parsed.colors || {};
  const p = normHex(c.primary), s = normHex(c.secondary), a = normHex(c.accent);
  if (p) out.colors.primary = p;
  if (s) out.colors.secondary = s;
  if (a) out.colors.accent = a;
  if (c.theme === 'light' || c.theme === 'dark') out.colors.theme = c.theme;
  out.colors.primary_text = readableOn(out.colors.primary); // always enforce contrast ourselves

  if (Array.isArray(parsed.roles)) {
    const roles = parsed.roles
      .map((r) => ({ hex: normHex(r && r.hex), role: typeof (r && r.role) === 'string' ? r.role : 'accent' }))
      .filter((r) => r.hex)
      .slice(0, 8);
    if (roles.length) out.palette = roles.map((r) => ({ hex: r.hex, role: r.role, pct: null }));
  }

  const f = parsed.fonts || {};
  const display = validFont(f.display, 'display') || out.fonts.display;
  const body = validFont(f.body, 'body') || out.fonts.body;
  out.fonts = { display, body, rationale: typeof f.rationale === 'string' ? f.rationale.slice(0, 200) : '' };

  out.icon_style = validIconStyle(parsed.icon_style);

  return out;
}

module.exports = { analyzeLogo, readableOn, contrast };
