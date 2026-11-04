// ============================================================================
// SUPPORT CHAT - AI-powered support with VoiceAI Connect knowledge base
// POST /api/agency/:agencyId/support/chat
// UPDATED: 2026-05-20 — Migrated from deprecated claude-sonnet-4-6-20260217
//          to claude-sonnet-4-6. Old model retires June 15, 2026.
// UPDATED: 2026-06-04 — Corrected stale pricing/trial copy: Pro is $99/mo
//          (was $179), and Pro/Scale trials are now card-required (was no-card).
// UPDATED: 2026-10-10 — Added POST /:agencyId/support/escalate. The AI chatbot
//          used to dead-end at a phone number; now the agency can hand the
//          conversation to a human. Escalation writes a support_requests seed
//          row (same shape as the agency Inbox "platform" intake), so it lands
//          in the admin inbox as a replyable thread AND in the agency's own
//          Inbox platform thread. Best-effort SMS nudges the owner. The reply
//          comes back in the Inbox, never on this endpoint.
// ============================================================================
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { requireAgencyAccess } = require('./auth');
const { supabase } = require('../lib/supabase');
const { sendAndLogSMS } = require('../lib/sms-logger');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Platform owner's number for the escalation heads-up (same resolution as
// routes/help.js so the two support paths text the same place).
const SUPPORT_PHONE = process.env.SUPPORT_PHONE_NUMBER || process.env.PLATFORM_OWNER_PHONE || '+16783161454';
// Ownership guard: /support/chat proxies to the Anthropic API, so it must not
// be callable anonymously (API-cost abuse). The handler ignores :agencyId for
// data, but requiring a valid token that owns :agencyId is the right gate.
router.use('/:agencyId/support', requireAgencyAccess('dashboard'));

// ============================================================================
// SYSTEM PROMPT — VoiceAI Connect support knowledge base
// ============================================================================
const { getSupportKnowledge } = require('../lib/support-knowledge');

// ============================================================================
// OPERATOR LENS — the dashboard support assistant. Facts come from the shared
// master knowledge base (support-knowledge.js); this wrapper only sets who it
// is talking to and how. One brain, two lenses (the marketing bot uses a
// prospect lens over the same knowledge).
// ============================================================================
const OPERATOR_LENS = `You are the AI support assistant inside the VoiceAI Connect agency dashboard. You help a logged-in agency owner or operator get the most out of the platform: using the dashboard, onboarding and managing clients, billing, branding, and troubleshooting.

## WHO YOU ARE TALKING TO
A logged-in agency operator who can see their dashboard. Give real, specific steps and reference dashboard locations (for example, Settings then Billing, or Dashboard then Your Test AI). Be concise and direct, operators are busy. Prefer two to four sentences, and expand only when the task needs it.

## HOW TO ANSWER
- Read the whole conversation so far before replying. You keep the context of this chat, so build on what was already said and never ask for something the operator already told you.
- Work out what they are actually asking, then find the relevant facts in the KNOWLEDGE BASE below and answer from those. The knowledge base is your single source of truth.
- If the knowledge base does not clearly cover it, say so plainly and point them to the "Talk to a person" button or support@myvoiceaiconnect.com. Never guess, never fill a gap with an assumption, and never state a number, price, timeframe, or policy that is not in the knowledge base.
- When something depends on the agency's own setup (for example the trial length or the pricing they set for their clients), say it is theirs to configure and tell them where, instead of quoting one fixed value as if it were the same for everyone.

## FORMATTING
Keep replies clean and conversational. A short bold label or a tight numbered list of steps is fine when it genuinely helps, nothing more. If you include a link, write it as a clean markdown link with a short plain label like [dashboard walkthrough](url), never a raw URL and never with stray asterisks or punctuation around it.

## HARD RULES
- Only discuss VoiceAI Connect, AI receptionists, agency operations, billing, and platform features. If asked something unrelated, redirect politely to how you can help with their agency.
- Never reveal how the platform is built: no internal architecture, no infrastructure, no third-party providers or tools by name, no endpoints, schemas, or source. If asked about the technology, say it uses proprietary technology and offer to help with using the platform instead. Do not help anyone replicate or build a competing product.
- Never invent features or facts. If you do not know, say so and point to support@myvoiceaiconnect.com, or tell them to use the "Talk to a person" button to reach the team, which replies within one business day.

## LINKS AND VIDEOS
Do not volunteer links or videos. Only share a video when the knowledge base below actually lists one whose topic directly answers what the operator asked, and then share just that single one as a clean markdown link. If no video is listed, do not mention videos at all, and never invent a link.

Use the KNOWLEDGE BASE below as your single source of truth.`;

// ============================================================================
// POST /:agencyId/support/chat
// ============================================================================
router.post('/:agencyId/support/chat', async (req, res) => {
  try {
    const { messages, agencyName, agencyPlan } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Support chat is not configured' });
    }

    // Build context-aware system prompt
    const knowledge = await getSupportKnowledge();
    let contextPrompt = `${OPERATOR_LENS}\n\nKNOWLEDGE BASE:\n${knowledge}`;
    if (agencyName) contextPrompt += `\n\nYou are currently helping ${agencyName}.`;
    if (agencyPlan) {
      contextPrompt += ` They are on the ${agencyPlan} plan.`;
      // Add plan-specific context
      if (agencyPlan === 'free' || agencyPlan === 'starter') {
        contextPrompt += ' As a Free plan user, they pay $29.99/client/mo + $0.12/min with no platform fee. They do not have white-label branding, marketing website, or custom domain. They can upgrade to Pro or Scale from Settings → Billing.';
      } else if (agencyPlan === 'pro' || agencyPlan === 'professional') {
        contextPrompt += ' As a Pro plan user, they pay $99/mo + $9.99/client/mo + $0.10/min. They have full white-label branding, marketing website, custom domain, and up to 5 team members. They can upgrade to Scale from Settings → Billing.';
      } else if (agencyPlan === 'scale' || agencyPlan === 'enterprise') {
        contextPrompt += ' As a Scale plan user, they pay $499/mo + $0/client + $0.05/min. They have all features including AI Lab, industry templates, and unlimited team members.';
      }
    }

    // Format messages for Claude API
    const claudeMessages = messages.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    // Hard timeout on the upstream AI call. Without it, a stalled connection
    // leaves the whole request hanging until the platform gateway kills it with
    // no response, which the browser surfaces as a raw CORS error. Aborting at
    // 30s instead turns that into a clean 500 (which still carries CORS
    // headers), so the client shows a normal "try again" and can retry.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          temperature: 0.3,
          system: contextPrompt,
          messages: claudeMessages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err && err.name === 'AbortError';
      console.error('Claude API fetch failed:', timedOut ? 'timeout after 30s' : (err && err.message));
      return res.status(timedOut ? 504 : 502).json({ error: 'Support assistant is taking too long. Please try again.' });
    } finally {
      clearTimeout(abortTimer);
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error('Claude API error:', response.status, errText);
      return res.status(500).json({ error: 'Failed to get support response' });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || 'Sorry, I couldn\'t generate a response. Please try again.';

    // Log the exchange for platform visibility (non-blocking, best-effort). The
    // last user message is the question; reply is the answer. Tied to the agency
    // so the admin agency-detail can surface what agencies ask the bot.
    try {
      const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
      const question = lastUser ? String(lastUser.content || '').slice(0, 2000) : '';
      if (question) {
        supabase.from('support_bot_log').insert({
          agency_id: req.params.agencyId || null,
          question,
          answer: String(reply).slice(0, 4000),
        }).then(() => {}, () => {});
      }
    } catch (_) { /* logging never blocks the reply */ }

    res.json({ success: true, reply });
  } catch (error) {
    console.error('Support chat error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /:agencyId/support/escalate
// Hand the chatbot conversation off to a human. Creates a support_requests
// seed row — identical in shape to the agency Inbox "platform" intake and the
// marketing widget escalation — so it surfaces in the admin inbox (grouped per
// agency, admin_unread +1) as a replyable thread, and in the agency's own
// Inbox platform conversation. The owner's reply returns through the inbox,
// not here; this endpoint only opens the thread. DB insert and SMS are
// independent best-effort so one failing never swallows the other.
// Body: { message?: string (what the agency typed), transcript?: string
//         (the bot conversation so far, pre-rendered "You:/Assistant:" lines) }
// ============================================================================
router.post('/:agencyId/support/escalate', async (req, res) => {
  try {
    const agencyId = req.params.agencyId;
    const { message, transcript } = req.body || {};

    const note = typeof message === 'string' ? message.trim() : '';
    const convo = typeof transcript === 'string' ? transcript.trim() : '';
    if (!note && !convo) {
      return res.status(400).json({ error: 'Nothing to send' });
    }

    // Resolve the agency name so the owner's SMS is actionable (the admin inbox
    // resolves the name itself from agency_id, so the record doesn't need it).
    let agencyName = 'An agency';
    try {
      const { data } = await supabase.from('agencies').select('name').eq('id', agencyId).single();
      if (data?.name) agencyName = data.name;
    } catch { /* non-blocking */ }

    // Compose the seed: the agency's typed note first (that's the actual ask),
    // then a compact transcript of what they already tried with the bot so the
    // owner has full context in one glance.
    const parts = [];
    parts.push(note || '(Escalated from the support assistant — see the conversation below.)');
    if (convo) {
      parts.push('');
      parts.push('--- Conversation with the support assistant ---');
      parts.push(convo);
    }
    const composed = parts.join('\n').slice(0, 4000);

    // 1) Persist to support_requests (admin inbox + agency Inbox platform thread).
    let requestId = null;
    try {
      const { data: created, error } = await supabase
        .from('support_requests')
        .insert({
          agency_id: agencyId,
          user_type: 'agency',
          message: composed,
          source: 'support_chat',
          status: 'open',
          last_sender: 'agency',
          admin_unread: 1,
        })
        .select('id')
        .single();
      if (error) throw error;
      requestId = created.id;
    } catch (dbErr) {
      console.error('support escalate insert failed:', dbErr.message);
      return res.status(500).json({ error: 'Could not send to the team. Please try again.' });
    }

    // 2) Text the owner (best-effort; never blocks the success response).
    if (SUPPORT_PHONE) {
      try {
        await sendAndLogSMS({
          phone: SUPPORT_PHONE,
          message: ['🆘 New support request', `Agency: ${agencyName}`, 'Check your admin inbox to view and reply.'].join('\n'),
          agencyId,
          recipientType: 'admin',
          messageType: 'support_escalation',
          metadata: { source: 'support_chat' },
        });
      } catch (smsErr) {
        console.error('Support escalation SMS failed (non-blocking):', smsErr.message);
      }
    }

    res.json({ success: true, request_id: requestId });
  } catch (error) {
    console.error('Support escalate error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /:agencyId/support/history
// The agency's full conversation with the support bot, rebuilt from the logged
// exchanges (support_bot_log) so it is ALWAYS available server-side: it survives
// refreshes, new devices, and sign-out, and the owner can scroll back through
// everything they have ever asked. Oldest first; newest at the bottom. Guarded
// by requireAgencyAccess('dashboard') via the router.use above.
// ============================================================================
router.get('/:agencyId/support/history', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { data, error } = await supabase
      .from('support_bot_log')
      .select('id, question, answer, created_at')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) {
      console.error('support history error:', error.message);
      return res.status(500).json({ error: 'Failed to load history' });
    }
    const rows = (data || []).reverse(); // back to chronological order
    const messages = [];
    for (const r of rows) {
      const ts = r.created_at ? new Date(r.created_at).getTime() : Date.now();
      if (r.question) messages.push({ id: `${r.id}-u`, role: 'user', content: r.question, timestamp: ts });
      if (r.answer) messages.push({ id: `${r.id}-a`, role: 'assistant', content: r.answer, timestamp: ts });
    }
    return res.json({ messages });
  } catch (e) {
    console.error('support history error:', e.message);
    return res.status(500).json({ error: 'Failed to load history' });
  }
});

module.exports = router;