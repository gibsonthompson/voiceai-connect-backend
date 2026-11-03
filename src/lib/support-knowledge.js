// ============================================================================
// SUPPORT KNOWLEDGE — the single "master brain" every VoiceAI Connect support
// surface reads (in-dashboard agency bot, marketing-site prospect bot, FAQ bot).
//
// It is admin-editable from /admin/support-knowledge, stored in platform_settings
// so edits go live with no deploy:
//   support_knowledge_doc    -> the master document text
//   support_knowledge_videos -> JSON array of { title, url } (YouTube links)
// support-knowledge.md ships as the SEED/fallback, used until an admin saves.
//
// getSupportKnowledge()    -> combined string the bots get (doc + VIDEO LIBRARY)
// getSupportKnowledgeRaw() -> { doc, videos } for the admin editor
// setSupportKnowledge(d,v) -> save both and bust the cache so edits apply now
// ============================================================================
const fs = require('fs');
const path = require('path');
const { supabase } = require('./supabase');

const DOC_KEY = 'support_knowledge_doc';
const VIDEOS_KEY = 'support_knowledge_videos';

let SEED_DOC = 'VoiceAI Connect is a white-label AI receptionist platform for agencies. To hear the AI now, call the public demo line at (404) 201-7505. For anything else, email support@myvoiceaiconnect.com.';
try {
  SEED_DOC = fs.readFileSync(path.join(__dirname, 'support-knowledge.md'), 'utf8');
} catch (e) {
  console.error('support-knowledge.md seed could not be read:', e.message);
}

async function getSetting(key) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from('platform_settings').select('value').eq('key', key).maybeSingle();
    return data ? data.value : null;
  } catch (e) { console.warn('support-knowledge getSetting failed:', e.message); return null; }
}
async function setSetting(key, value) {
  if (!supabase) return;
  await supabase.from('platform_settings').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
}

// Raw stored values the admin editor loads and saves.
async function getSupportKnowledgeRaw() {
  let doc = SEED_DOC;
  let videos = [];
  const d = await getSetting(DOC_KEY);
  if (d && String(d).trim()) doc = String(d);
  const v = await getSetting(VIDEOS_KEY);
  if (v) { try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) videos = parsed; } catch (_) { /* ignore */ } }
  return { doc, videos };
}

let _cache = null, _cacheAt = 0;
const TTL_MS = 30 * 1000;

// The combined knowledge the bots receive: the doc plus a generated video list.
async function getSupportKnowledge() {
  if (_cache && Date.now() - _cacheAt < TTL_MS) return _cache;
  const { doc, videos } = await getSupportKnowledgeRaw();
  let out = doc;
  const lines = (videos || [])
    .filter((x) => x && x.url)
    .map((x) => `Video: ${String(x.title || 'Walkthrough').trim()}, ${String(x.url).trim()}`);
  if (lines.length) out += `\n\n## VIDEO LIBRARY (share the matching link when it helps)\n${lines.join('\n')}`;
  _cache = out; _cacheAt = Date.now();
  return out;
}

async function setSupportKnowledge(doc, videos) {
  const cleanVideos = Array.isArray(videos)
    ? videos
        .filter((x) => x && typeof x.url === 'string' && x.url.trim())
        .map((x) => ({ title: String(x.title || '').slice(0, 200), url: String(x.url).trim().slice(0, 500) }))
        .slice(0, 100)
    : [];
  await setSetting(DOC_KEY, String(doc == null ? '' : doc));
  await setSetting(VIDEOS_KEY, JSON.stringify(cleanVideos));
  _cache = null; _cacheAt = 0;
  return { doc: String(doc == null ? '' : doc), videos: cleanVideos };
}

module.exports = { getSupportKnowledge, getSupportKnowledgeRaw, setSupportKnowledge, SEED_DOC };
