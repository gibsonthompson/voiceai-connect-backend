// ============================================================================
// SUPPORT KNOWLEDGE loader — the single "master brain" for every VoiceAI Connect
// support surface (marketing prospect bot, dashboard operator bot, later the
// admin-editable version and any FAQ bot).
//
// The knowledge itself lives in support-knowledge.md, a plain document so it can
// be copied out, updated, and pasted back whole with no code escaping. To attach
// a video to any topic, add a line like:
//   Video: How to add a client, https://youtu.be/XXXXXXXX
// The bots offer the relevant link when it helps, and the chat UIs render it as
// a clickable link.
//
// TWO RULES, enforced in each bot's lens: everything in the doc is user-facing
// (what it does and how to use it, never how it is built), and never invent
// facts not in the doc.
// ============================================================================
const fs = require('fs');
const path = require('path');

let SUPPORT_KNOWLEDGE = '';
try {
  SUPPORT_KNOWLEDGE = fs.readFileSync(path.join(__dirname, 'support-knowledge.md'), 'utf8');
} catch (e) {
  console.error('support-knowledge.md could not be read:', e.message);
  SUPPORT_KNOWLEDGE = 'VoiceAI Connect is a white-label AI receptionist platform for agencies. To hear the AI now, call the public demo line at (404) 201-7505. For anything else, email support@myvoiceaiconnect.com.';
}

module.exports = { SUPPORT_KNOWLEDGE };
