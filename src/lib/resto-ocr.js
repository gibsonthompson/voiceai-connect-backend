// ============================================================================
// METER OCR  (Claude vision)
// Reads a field meter photo (thermo-hygrometer or moisture meter) and returns
// structured values. Stateless: takes a base64 image, no storage/schema needed.
// Requires ANTHROPIC_API_KEY and @anthropic-ai/sdk on the backend.
// ============================================================================
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6';
const SYSTEM = [
  'You read field meters for a restoration company from a single photo.',
  'Devices: thermo-hygrometers (temperature + relative humidity) and moisture meters (moisture content %).',
  'Extract only values clearly shown on the display. Do not guess or infer values that are not visible.'
].join(' ');

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

async function readMeter(base64, mediaType) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text:
`Read this meter's display. Respond with ONLY a JSON object (no prose, no markdown fences):
"device": "thermo_hygrometer" | "moisture_meter" | "unknown"
"temp_f": number or null       (Fahrenheit; convert if the display is in Celsius)
"rh_pct": number or null       (relative humidity %)
"moisture_pct": number or null (moisture content %)
"raw": string                  (exactly what the display shows, e.g. "78.2F 55%")

Only include values clearly visible on the display. Use null for anything not shown. If the display is unreadable, set everything to null and device to "unknown".` }
      ]
    }]
  });
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  let p;
  try { p = JSON.parse(clean); } catch (_) {
    return { device: 'unknown', temp_f: null, rh_pct: null, moisture_pct: null, raw: '' };
  }
  return {
    device: ['thermo_hygrometer', 'moisture_meter', 'unknown'].includes(p.device) ? p.device : 'unknown',
    temp_f: num(p.temp_f), rh_pct: num(p.rh_pct), moisture_pct: num(p.moisture_pct),
    raw: typeof p.raw === 'string' ? p.raw.slice(0, 120) : ''
  };
}

async function scanMeter({ imageBase64, mediaType }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ocr not configured');
  if (!imageBase64) throw new Error('image required');
  return readMeter(imageBase64, mediaType || 'image/jpeg');
}

module.exports = { scanMeter };