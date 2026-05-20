// src/routes/help.js
// Support widget endpoints: AI chatbot + SMS escalation
// Mount in server.js: app.use('/api/help', require('./routes/help'));
// UPDATED: 2026-05-20 — Fixed sendAndLogSMS param names (was using to/body/type
//          instead of phone/message/messageType, causing "Invalid phone: undefined").
//          Updated Claude model to claude-sonnet-4-6-20260217.

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { sendAndLogSMS } = require('../lib/sms-logger');

// Initialize Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Gibson's phone number for escalation
const SUPPORT_PHONE = process.env.SUPPORT_PHONE_NUMBER || '';
// Platform notification number for sending
const PLATFORM_NUMBER = process.env.TELNYX_SMS_FROM_NUMBER || process.env.TELNYX_PHONE_NUMBER || process.env.PLATFORM_PHONE_NUMBER || '';

// ── Knowledge Base Context (embedded for AI) ────────────────────────
// This is the full FAQ content the AI uses to answer questions.
// Keep in sync with frontend lib/support-kb.ts
const KB_CONTEXT = `
You are the VoiceAI Connect support assistant. Answer questions about the platform accurately and helpfully using ONLY the information below. If a question isn't covered, say you don't have that information and suggest the user contact support.

Be concise — keep answers under 3-4 sentences unless the question requires more detail. Use a friendly, professional tone. Never make up features or pricing that aren't listed below.

=== VOICEAI CONNECT KNOWLEDGE BASE ===

WHAT IS VOICEAI CONNECT:
VoiceAI Connect is a white-label AI receptionist platform for agencies. Agencies brand it as their own, onboard local businesses as clients, and collect monthly recurring revenue. The platform handles voice AI, phone numbers, billing, and dashboards.

PLANS & PRICING:
- Free: $0/mo platform, $29.99/client/mo, $0.12/min. Core features, VoiceAI Connect branding (not white-labeled). No trial.
- Pro: $99/mo platform, $9.99/client/mo, $0.10/min. 14-day no-card trial. Includes white-label, AI Lab, lead finder, marketing site, demo line, outreach templates, referrals, 5 agency + 2 client team members.
- Scale: $499/mo platform, $0/client, $0.05/min. 14-day no-card trial. Everything in Pro + unlimited team, BYOT (Twilio), API access, industry templates, priority support.

BILLING:
- Usage-based: platform fee + per-client + per-minute charges.
- Agencies set their OWN client pricing (e.g. $149/mo). The difference is profit (typically 80-96% margin).
- Subscribe via Settings > Billing. Manage subscription through Stripe portal.
- Free plan requires payment info when adding first client (for per-client charges).
- Trials last 14 days with full Scale access. One trial per agency. After trial, reverts to Free plan.
- Month-to-month, cancel anytime.

STRIPE CONNECT (RECEIVING PAYMENTS):
- Connect Stripe in Settings > Payments. Client payments go directly to agency's bank — zero revenue share.
- "Setup Incomplete" means Stripe needs more verification. Click "Complete" to finish.
- Both Charges and Payouts must show "OK" to receive payments.

ADDING CLIENTS:
- Click "Add Client," fill in business info. Platform auto-provisions AI assistant, phone number, and dashboard in ~60 seconds.
- Clients can self-signup via marketing website (Pro/Scale).
- Unlimited clients on all plans (cost varies by plan).
- Supported industries: Home Services, Medical, Dental, Legal, Salons, Real Estate, Automotive, Restaurants, Fitness, Accounting, Veterinary, Insurance, and more.

AI LAB (Pro/Scale):
- Configure AI receptionists: system prompt, voice selection, model, knowledge base, test calls, call mode.
- Call modes: Primary (AI answers all calls) or Secondary/Overflow (AI answers when owner doesn't).
- Models: GPT-4o Mini (fastest, default), GPT-4.1 Mini (latest), GPT-4o (strongest reasoning, slower).
- Temperature: 0.0-1.0 (lower = precise, higher = creative, default 0.7).
- Browser test calls available — no phone needed.
- Voice selection with ElevenLabs voices (male/female, various accents/styles, preview playback).

KNOWLEDGE BASE:
- Per-client business info the AI uses: services, pricing, FAQs, hours, policies.
- Editable in AI Lab or by clients in their dashboard.
- More detail = better AI performance. Include services, hours, policies, payment methods, emergency procedures.

PHONE NUMBERS:
- Auto-provisioned US numbers via Telnyx. No A2P registration needed.
- Clients forward their existing number to the AI number.
- International numbers via BYOT/Twilio (Scale plan).

WHITE-LABEL & BRANDING (Pro/Scale):
- Logo, colors, theme (light/dark) customizable in Settings > Profile.
- Colors auto-extracted from logo upload.
- Client dashboard header can show agency name or client business name.
- Free plan shows VoiceAI Connect default branding.
- Theme toggle (sun/moon in sidebar) works on all plans.

MARKETING WEBSITE (Pro/Scale):
- Auto-generated branded landing page with pricing, demo line, and signup.
- Includes interactive AI demo phone line — prospects experience the product firsthand.
- Fully hosted, no setup needed.

LEAD FINDER (Pro/Scale):
- Google Maps: search by industry and location.
- Indeed: search by job title to find businesses hiring receptionists.
- Fit scores (0-100): 70+ Hot, 50-69 Warm, 30-49 Cool.
- Save leads to CRM pipeline, CSV import/export.

OUTREACH (Pro/Scale):
- 13 templates: 6 email, 3 SMS, 4 cold call scripts.
- Merge variables for personalization.
- Sequence tracking with follow-up queue.
- Create custom templates.

TEAM MEMBERS:
- Free: 0. Pro: 5 agency + 2 per client. Scale: unlimited.
- Invite via Settings > Team.

REFERRAL PROGRAM (Pro/Scale):
- 40% recurring commission on referred agencies.
- Customizable referral link.
- Payouts via Stripe Connect.

CALL HANDLING:
- AI answers in sub-2 seconds, handles natural conversation.
- Call transfer to owner for urgent matters (configurable in system prompt).
- Spam detection and caller recognition on all plans.
- Full recordings, transcripts, and AI summaries.
- After-hours mode with different greeting.
- Compliance: include recording disclaimer in greeting.
- AI can be configured to not mention it's AI.

GOOGLE CALENDAR INTEGRATION:
- Built-in Google Calendar integration — AI can check real-time availability and book appointments during calls.
- Caller says they want an appointment → AI checks Google Calendar → offers available slots → books it automatically.
- Calendar events include caller name, phone, and reason for appointment.
- Agencies control which client plan tiers get calendar access (Settings > Pricing, toggle "Google Calendar" per plan).
- Clients connect their own Google account via OAuth (secure, agency never sees credentials).
- Works with shared team calendars — connect the Google account that owns the calendar.
- Troubleshooting: verify Google account connected, correct calendar selected, feature enabled for client's plan tier.

DEMO MODE:
- Toggle in Settings > Demo Mode. Shows sample data (14 clients, calls, leads, revenue). Display only, doesn't affect real data.

TROUBLESHOOTING:
- AI not answering: Check AI assistant configured, phone provisioned, subscription active, greeting/prompt not empty.
- Wrong answers: Update knowledge base and system prompt with correct info.
- Can't add client: Set up payment (Free plan needs card for per-client charges).
- Locked features: Requires Pro or Scale upgrade.
- Stripe incomplete: Complete verification in Stripe.
- Sample data showing: Demo Mode is on — toggle off in Settings.

SUPPORT:
- Use the help widget for FAQs, AI assistant, or contacting the team.
- Settings > Feedback for feature requests.
- Support responds within a few hours.
`;

// ── POST /api/support/chat ──────────────────────────────────────────
// AI chatbot powered by Claude
router.post('/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'AI service not configured' });
    }

    // Build conversation history for Claude
    const messages = [];

    // Add previous conversation (last 10 messages max)
    const recentHistory = (history || []).slice(-10);
    for (const msg of recentHistory) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Add current message
    messages.push({ role: 'user', content: message.trim() });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6-20260217',
      max_tokens: 500,
      system: KB_CONTEXT,
      messages,
    });

    const assistantResponse = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    res.json({ response: assistantResponse });
  } catch (err) {
    console.error('Support chat error:', err);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// ── POST /api/support/message ───────────────────────────────────────
// SMS escalation to Gibson
router.post('/message', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!SUPPORT_PHONE) {
      console.error('SUPPORT_PHONE_NUMBER not configured');
      return res.status(500).json({ error: 'Support messaging not configured' });
    }

    // Extract agency info from auth token if available
    let agencyInfo = 'Unknown';
    let userEmail = 'Unknown';
    let agencyId = null;
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        agencyInfo = decoded.agencyName || decoded.agency_name || decoded.agency_id || 'Unknown';
        userEmail = decoded.email || 'Unknown';
        agencyId = decoded.agency_id || null;
      }
    } catch {
      // Token parsing failed, continue with Unknown
    }

    // Format SMS
    const smsBody = [
      '🆘 VoiceAI Support Request',
      `Agency: ${agencyInfo}`,
      `Email: ${userEmail}`,
      `Message: ${message.trim().substring(0, 600)}`,
      `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
    ].join('\n');

    // FIX: Use correct parameter names for sendAndLogSMS
    // Old code used { to, from, body, type } which are not valid params —
    // sendAndLogSMS expects { phone, message, agencyId, recipientType, messageType, metadata }
    await sendAndLogSMS({
      phone: SUPPORT_PHONE,
      message: smsBody,
      agencyId: agencyId,
      recipientType: 'admin',
      messageType: 'support_escalation',
      metadata: { agencyName: agencyInfo, email: userEmail },
    });

    res.json({ success: true, message: 'Your message has been sent to our team.' });
  } catch (err) {
    console.error('Support escalation error:', err);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

module.exports = router;