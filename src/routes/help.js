// src/routes/help.js
// Support widget endpoints: AI chatbot + SMS escalation
// Mount in server.js: app.use('/api/help', require('./routes/help'));
// UPDATED: 2026-05-20 - Fixed sendAndLogSMS param names (was using to/body/type
//          instead of phone/message/messageType, causing "Invalid phone: undefined").
// UPDATED: 2026-05-29 - Fixed model string: claude-sonnet-4-6 (was using deprecated dated version)
// UPDATED: 2026-07-31 - Escalations now persist to support_requests (admin
//          Support queue) in addition to the SMS. Also fixed the identity
//          extraction: tokens carry agencyId/clientId (camelCase) from
//          generateToken, so the old decoded.agency_id read was always
//          undefined ("Agency: Unknown"). Now resolves the real agency/client
//          name from the DB and captures agency vs client. DB insert and SMS
//          are independent best-effort, so one failing never loses the other.

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { sendAndLogSMS } = require('../lib/sms-logger');
const { supabase } = require('../lib/supabase');

// Initialize Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Gibson's phone number for escalation
const SUPPORT_PHONE = process.env.SUPPORT_PHONE_NUMBER || '';
// Platform notification number for sending
const PLATFORM_NUMBER = process.env.TELNYX_SMS_FROM_NUMBER || process.env.TELNYX_PHONE_NUMBER || process.env.PLATFORM_PHONE_NUMBER || '';

// ── Knowledge Base Context (embedded for AI) ────────────────────────
const KB_CONTEXT = `
You are the VoiceAI Connect support assistant. Answer questions about the platform accurately and helpfully using ONLY the information below. If a question isn't covered, say you don't have that information and suggest the user contact support.

Be concise - keep answers under 3-4 sentences unless the question requires more detail. Use a friendly, professional tone. Never make up features or pricing that aren't listed below.

=== VOICEAI CONNECT KNOWLEDGE BASE ===

WHAT IS VOICEAI CONNECT:
VoiceAI Connect is a white-label AI receptionist platform for agencies. Agencies brand it as their own, onboard local businesses as clients, and collect monthly recurring revenue. The platform handles voice AI, phone numbers, billing, and dashboards.

PLANS & PRICING:
- Free: $0/mo platform, $29.99/client/mo, $0.12/min. Core features, VoiceAI Connect branding (not white-labeled). No trial.
- Pro: $99/mo platform, $9.99/client/mo, $0.10/min. 14-day free trial (credit card required to start - not charged until the trial ends, cancel anytime before then). Includes white-label, AI Lab, lead finder, marketing site, demo line, outreach templates, referrals, 5 agency + 2 client team members.
- Scale: $499/mo platform, $0/client, $0.05/min. 14-day free trial (credit card required to start - not charged until the trial ends, cancel anytime before then). Everything in Pro + unlimited team, BYOT (Twilio), API access, industry templates, priority support.

BILLING:
- Usage-based: platform fee + per-client + per-minute charges.
- Agencies set their OWN client pricing (e.g. $149/mo). The difference is profit (typically 80-96% margin).
- Subscribe via Settings > Billing. Manage subscription through Stripe portal.
- Free plan requires payment info when adding first client (for per-client charges).
- Pro and Scale trials last 14 days and require a credit card to start. The card is not charged until the trial ends; the subscription then begins automatically on the plan that was selected. Cancel anytime before the trial ends to avoid any charge. One trial per agency. The Free plan has no trial and needs no card - it activates immediately.
- Month-to-month, cancel anytime.

STRIPE CONNECT (RECEIVING PAYMENTS):
- Connect Stripe in Settings > Payments. Client payments go directly to agency's bank - zero revenue share.
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
- Browser test calls available - no phone needed.
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
- Includes interactive AI demo phone line - prospects experience the product firsthand.
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
- Built-in Google Calendar integration - AI can check real-time availability and book appointments during calls.
- Caller says they want an appointment → AI checks Google Calendar → offers available slots → books it automatically.
- Calendar events include caller name, phone, and reason for appointment.
- Agencies control which client plan tiers get calendar access (Settings > Pricing, toggle "Google Calendar" per plan).
- Clients connect their own Google account via OAuth (secure, agency never sees credentials).
- Works with shared team calendars - connect the Google account that owns the calendar.
- Troubleshooting: verify Google account connected, correct calendar selected, feature enabled for client's plan tier.

DEMO MODE:
- Toggle in Settings > Demo Mode. Shows sample data (14 clients, calls, leads, revenue). Display only, doesn't affect real data.

TROUBLESHOOTING:
- AI not answering: Check AI assistant configured, phone provisioned, subscription active, greeting/prompt not empty.
- Wrong answers: Update knowledge base and system prompt with correct info.
- Can't add client: Set up payment (Free plan needs card for per-client charges).
- Locked features: Requires Pro or Scale upgrade.
- Stripe incomplete: Complete verification in Stripe.
- Sample data showing: Demo Mode is on - toggle off in Settings.

SUPPORT:
- Use the help widget for FAQs, AI assistant, or contacting the team.
- Settings > Feedback for feature requests.
- Support responds within a few hours.
`;

// ── POST /api/help/chat ─────────────────────────────────────────────
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
      model: 'claude-sonnet-4-6',
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

// ── POST /api/help/message ──────────────────────────────────────────
// Support escalation. Persists to support_requests (admin Support queue) AND
// texts the platform owner. Both are independent best-effort: a DB failure must
// not lose the SMS, and an SMS failure must not lose the DB record. Returns
// success as long as the request was captured in at least one place.
router.post('/message', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Pull identity from the auth token. generateToken mints
    // { userId, email, role, agencyId, clientId } (camelCase); fall back to
    // snake_case defensively. role distinguishes agency vs client callers.
    let userEmail = 'Unknown';
    let agencyId = null;
    let clientId = null;
    let role = null;
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userEmail = decoded.email || 'Unknown';
        agencyId = decoded.agencyId || decoded.agency_id || null;
        clientId = decoded.clientId || decoded.client_id || null;
        role = decoded.role || null;
      }
    } catch {
      // Token parsing failed, continue as anonymous.
    }

    const userType =
      (role && String(role).startsWith('client')) || (clientId && !agencyId)
        ? 'client'
        : 'agency';

    // Resolve a human-readable name for the record and SMS. The token does not
    // carry the agency/client name, so look it up (best effort).
    let displayName = 'Unknown';
    try {
      if (userType === 'agency' && agencyId) {
        const { data } = await supabase.from('agencies').select('name').eq('id', agencyId).single();
        if (data?.name) displayName = data.name;
      } else if (clientId) {
        const { data } = await supabase.from('clients').select('business_name').eq('id', clientId).single();
        if (data?.business_name) displayName = data.business_name;
      }
    } catch {
      // non-blocking
    }

    const cleanMessage = message.trim().substring(0, 2000);

    // 1) Persist to support_requests so it lands in the admin Support queue.
    let persisted = false;
    try {
      const { error: insertErr } = await supabase.from('support_requests').insert({
        agency_id: agencyId,
        client_id: clientId,
        user_type: userType,
        user_email: userEmail === 'Unknown' ? null : userEmail,
        display_name: displayName === 'Unknown' ? null : displayName,
        message: cleanMessage,
        source: 'widget',
        status: 'open',
      });
      if (insertErr) console.error('support_requests insert failed (non-blocking):', insertErr.message);
      else persisted = true;
    } catch (dbErr) {
      console.error('support_requests insert threw (non-blocking):', dbErr.message);
    }

    // 2) Text the platform owner, as before.
    let smsSent = false;
    if (SUPPORT_PHONE) {
      try {
        const smsBody = [
          '🆘 VoiceAI Support Request',
          `${userType === 'client' ? 'Client' : 'Agency'}: ${displayName}`,
          `Email: ${userEmail}`,
          `Message: ${cleanMessage.substring(0, 600)}`,
          `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
        ].join('\n');

        await sendAndLogSMS({
          phone: SUPPORT_PHONE,
          message: smsBody,
          agencyId: agencyId,
          recipientType: 'admin',
          messageType: 'support_escalation',
          metadata: { name: displayName, email: userEmail, userType },
        });
        smsSent = true;
      } catch (smsErr) {
        console.error('Support escalation SMS failed (non-blocking):', smsErr.message);
      }
    } else {
      console.error('SUPPORT_PHONE_NUMBER not configured (support request still saved to queue)');
    }

    // Success as long as the request was captured somewhere.
    if (persisted || smsSent) {
      return res.json({ success: true, message: 'Your message has been sent to our team.' });
    }
    return res.status(500).json({ error: 'Failed to send message. Please try again.' });
  } catch (err) {
    console.error('Support escalation error:', err);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

module.exports = router;