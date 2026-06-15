// ============================================================================
// VOICES ROUTE - Voice listing + greeting preview (TTS)
// Mounted at /api/voices (separate from /api/client routes)
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const router = express.Router();

// Import voice options from client-routes
const { VOICE_OPTIONS } = require('./client-routes');

// ============================================================================
// GET /api/voices - List all available voices
// Returns format expected by frontend: { success: true, grouped: { female: [], male: [] } }
// ============================================================================
router.get('/', async (req, res) => {
  try {
    // Group voices by gender
    const femaleVoices = VOICE_OPTIONS.filter(v => v.gender === 'female');
    const maleVoices = VOICE_OPTIONS.filter(v => v.gender === 'male');
    
    // Sort: recommended first, then alphabetically
    const sortVoices = (voices) => {
      return voices.sort((a, b) => {
        if (a.recommended && !b.recommended) return -1;
        if (!a.recommended && b.recommended) return 1;
        return a.name.localeCompare(b.name);
      });
    };

    res.json({
      success: true,
      total: VOICE_OPTIONS.length,
      grouped: {
        female: sortVoices(femaleVoices),
        male: sortVoices(maleVoices)
      },
      voices: VOICE_OPTIONS // Also include flat list
    });
  } catch (error) {
    console.error('Error fetching voices:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// POST /api/voices/preview - Speak arbitrary text (the client's greeting) in a
// chosen voice, so the picker previews the REAL greeting instead of the stock
// ElevenLabs sample. The voices are ElevenLabs voices (VAPI normally proxies
// them); a direct preview needs ELEVENLABS_API_KEY on this backend. Returns
// audio/mpeg. If the key is missing, returns 503 and the frontend falls back
// to the stock sample, so nothing breaks before the key is added.
// ============================================================================
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TTS_MODEL_ID = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';
const MAX_PREVIEW_CHARS = 500;

// In-memory cache (voiceId + text hash -> mp3 Buffer). Avoids re-billing the
// same greeting/voice combo. FIFO-capped so it can't grow unbounded.
const previewCache = new Map();
const PREVIEW_CACHE_MAX = 200;

// Lightweight per-IP rate limit (no external deps) to bound abuse and cost.
const rateBuckets = new Map();
const RATE_MAX = 40;            // requests per window
const RATE_WINDOW_MS = 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  rateBuckets.set(ip, recent);
  return recent.length > RATE_MAX;
}

router.post('/preview', async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(503).json({ success: false, error: 'Voice preview not configured' });
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ success: false, error: 'Too many previews, give it a second' });
    }

    const { voice_id, text } = req.body || {};
    if (!voice_id || typeof voice_id !== 'string') {
      return res.status(400).json({ success: false, error: 'voice_id required' });
    }
    const clean = String(text || '').trim().slice(0, MAX_PREVIEW_CHARS);
    if (clean.length < 2) {
      return res.status(400).json({ success: false, error: 'text required' });
    }

    const cacheKey = `${voice_id}:${crypto.createHash('sha1').update(clean).digest('hex')}`;
    const cached = previewCache.get(cacheKey);
    if (cached) {
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cached);
    }

    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: clean,
          model_id: TTS_MODEL_ID,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!ttsRes.ok) {
      const errText = await ttsRes.text().catch(() => '');
      console.error(`ElevenLabs TTS failed (HTTP ${ttsRes.status}): ${errText.slice(0, 200)}`);
      return res.status(502).json({ success: false, error: 'Voice synthesis failed' });
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());

    previewCache.set(cacheKey, audioBuffer);
    if (previewCache.size > PREVIEW_CACHE_MAX) {
      previewCache.delete(previewCache.keys().next().value); // evict oldest
    }

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(audioBuffer);
  } catch (error) {
    console.error('Voice preview error:', error.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;