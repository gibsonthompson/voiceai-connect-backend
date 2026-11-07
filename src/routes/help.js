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
// UPDATED: 2026-08-03 - Expanded KB_CONTEXT: client app/PWA access, per-call
//          notifications (SMS + email summary with urgency), voice library
//          selection (no cloning), feedback path. Added a hard compliance rule:
//          the bot must NOT claim HIPAA compliance or a BAA (neither exists
//          today); healthcare questions are directed to the team.
// UPDATED: 2026-08-17 - /message now accepts an ANONYMOUS marketing-site
//          prospect. The platform support widget (components/SupportWidget.tsx)
//          on myvoiceaiconnect.com forwards { name, contact, message,
//          conversationSummary } here via /api/widget/escalate with no auth
//          token. Previously this endpoint only read identity from a token, so
//          a token-less prospect logged as "Unknown" (and the widget used to
//          hit the agency inbox intake, which 404'd on the platform host). Now
//          a token-less request carrying name/contact is treated as a prospect:
//          the record is populated from those fields (user_type kept at the
//          proven-safe 'agency' value so the queue insert can never be rejected
//          by an enum/CHECK constraint, and tagged as a prospect in the message
//          body), and the owner SMS shows the prospect name + contact so a
//          callback request is actionable. The logged-in dashboard widget path
//          (token + { message }) is unchanged.

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { sendAndLogSMS } = require('../lib/sms-logger');
const { supabase } = require('../lib/supabase');

// Best-effort logging of marketing FAQ-bot conversations (see widget_chat_log).
// Never blocks or fails the chat/escalation response.
async function logWidgetChat(sessionId, role, content, origin = {}, createdAt = null) {
  try {
    if (!sessionId || typeof sessionId !== 'string') return;
    if (!content || typeof content !== 'string' || !content.trim()) return;
    const base = {
      session_id: sessionId.slice(0, 100),
      role,
      content: content.trim().slice(0, 8000),
      // Explicit timestamp when given, so the user turn is stamped strictly
      // before the assistant turn (two fire-and-forget inserts with the default
      // now() can tie/race and flip the order in the admin inbox).
      ...(createdAt ? { created_at: createdAt } : {}),
    };
    // Record WHERE the chat came from so the admin inbox can tell a marketing
    // prospect from a logged-in agency/client, and so questions can be triaged
    // correctly. Defensive: if the origin columns are not present yet (migration
    // not applied), fall back to the original 3-column insert so logging never
    // breaks.
    const full = {
      ...base,
      user_type: origin.userType || null,       // prospect | agency | client
      agency_id: origin.agencyId || null,
      source: origin.source || null,            // marketing | agency_dashboard | client_dashboard
    };
    const { error } = await supabase.from('widget_chat_log').insert(full);
    if (error) {
      await supabase.from('widget_chat_log').insert(base);
    }
  } catch (e) {
    console.error('widget chat log failed (non-blocking):', e.message);
  }
}

// Notify the platform owner when a LOGGED-IN agency or client starts a help-bot
// chat, so a confused customer never asks the bot three questions in silence.
// Fires once per session (the first user message only), never for anonymous
// prospects, and never blocks the chat response. The chat itself is merged into
// that agency's conversation in the admin inbox, so this text just flags it.
async function notifyHelpChat({ sessionId, aud, agencyId, message }) {
  try {
    if (aud !== 'agency' && aud !== 'client') return; // logged-in users only
    if (!agencyId || !sessionId) return;              // must know who it was
    if (!SUPPORT_PHONE) return;
    // Debounce: if this session already has rows, this is not the first message.
    const { data: prior } = await supabase
      .from('widget_chat_log').select('id').eq('session_id', sessionId).limit(1);
    if (prior && prior.length) return;
    const { data: agency } = await supabase.from('agencies').select('name').eq('id', agencyId).maybeSingle();
    const who = (agency && agency.name) || 'An agency';
    const roleLabel = aud === 'client' ? 'client' : 'agency';
    const preview = String(message || '').trim().slice(0, 140);
    await sendAndLogSMS({
      phone: SUPPORT_PHONE,
      message: `New help-bot chat from ${who} (${roleLabel}): "${preview}". It's in their conversation in the admin inbox.`,
      agencyId,
      recipientType: 'admin',
      messageType: 'help_chat_alert',
      metadata: { sessionId, userType: aud },
    });
  } catch (e) {
    console.error('help chat notify failed (non-blocking):', e.message);
  }
}

// Audience framing appended to the knowledge base per who is asking. Same KB,
// different lens: a prospect on the marketing site needs to understand how the
// product works (not dashboard navigation they can't follow), while a logged-in
// agency needs concrete in-dashboard steps, and an end client has none of the
// agency features at all.
const AUDIENCE_PROMPTS = {
  prospect: `
=== WHO YOU ARE TALKING TO ===
You are on the PUBLIC VoiceAI Connect marketing website, talking to a PROSPECT who does NOT have an account and cannot see any dashboard. Explain how the product WORKS and what they GET, never step-by-step dashboard navigation they cannot follow. Frame everything as what happens after they sign up.
For "how do I edit my website" and similar: explain that every VoiceAI Connect agency gets its own white-label marketing website that is auto-generated and fully hosted for them, and that after signing up they control it entirely from their dashboard (logo, colors, content, pricing, demo phone line, and a custom domain). There is nothing to hand-code or host themselves. Keep it benefit-oriented and inviting, and offer to point them to start a free trial or talk to the team for specifics.`,
  agency: `
=== WHO YOU ARE TALKING TO ===
You are inside the dashboard of a logged-in AGENCY owner. Give concrete, accurate in-dashboard directions (which page or tab to open). Assume they have the full agency toolset: clients, their white-label marketing website editor, branding, billing, leads, and outreach.`,
  client: `
=== WHO YOU ARE TALKING TO ===
You are inside the dashboard of an END CLIENT: a local business using an agency's AI receptionist. They do NOT have agency features, a marketing website, pricing controls, or billing. Only help with their own dashboard: their calls, recordings, messages, greeting and knowledge, and their own settings. If they ask about anything agency-level (a marketing website, pricing, adding clients, white-label), explain that their provider manages that and they should reach out to them.`,
};

// Initialize Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Gibson's phone number for escalation
const SUPPORT_PHONE = process.env.SUPPORT_PHONE_NUMBER || process.env.PLATFORM_OWNER_PHONE || '+16783161454';
// Platform notification number for sending
const PLATFORM_NUMBER = process.env.TELNYX_SMS_FROM_NUMBER || process.env.TELNYX_PHONE_NUMBER || process.env.PLATFORM_PHONE_NUMBER || '';

// -- Knowledge Base Context (embedded for AI) ------------------------
const KB_CONTEXT = `
You are the VoiceAI Connect support assistant. Answer questions about the platform accurately and helpfully, using only what you actually know about VoiceAI Connect from the details below. Never invent features, steps, or pricing.

Never mention a "knowledge base", "documentation", or "the information provided", and never say something "isn't documented" - that sounds robotic. If you are not sure about something, or it is not covered here, just say plainly that you are not totally sure, then point them to the team: they can tap "Contact Support" in this help widget to send a message straight to the team (it lands in their inbox and someone replies there), or email support@myvoiceaiconnect.com. Keep it warm and human, like a helpful teammate.

Be concise - keep answers under 3-4 sentences unless the question requires more detail. Use a friendly, professional tone. Never make up features or pricing that aren't listed below.

Reply in plain conversational text only. Do not use markdown or any formatting symbols. No asterisks, bold, italics, bullet points, numbered lists, headers, or hashes. The chat widget shows your reply exactly as written, so any symbols appear as literal characters.

HARD RULES (never break these):
- Never claim VoiceAI Connect is HIPAA compliant, HIPAA certified, or "HIPAA ready," and never say a Business Associate Agreement (BAA) is available. Those are not offered today. If someone asks about HIPAA, healthcare compliance, PHI, or a BAA, do NOT confirm compliance. Say that the platform is used by healthcare offices for scheduling and messages and is set up to avoid collecting medical detail, but that you can't speak to specific compliance requirements, and the best step is to contact the team so they can walk through their situation before onboarding a healthcare client.
- Do not claim voice cloning. Voices are selected from a premade library.
- API and webhooks DO exist on the Scale plan (and for call-center agencies on any plan): a REST API with API keys plus signed outbound webhooks. Do not deny them. But do NOT overpromise calendar booking: the AI only books automatically into Google Calendar. For any other calendar (Outlook, Microsoft 365, Acuity, Calendly, and so on) there is no native automated booking today, so never tell someone the AI will book into a non-Google calendar out of the box. For those, the AI captures the request on the call and the agency wires it into their own system via the API or webhooks.
- Do not invent SLAs, certifications, or guarantees that aren't listed here.

=== VOICEAI CONNECT KNOWLEDGE BASE ===

WHAT IS VOICEAI CONNECT:
VoiceAI Connect is a white-label AI receptionist platform for agencies. Agencies brand it as their own, onboard local businesses as clients, and collect monthly recurring revenue. The platform handles voice AI, phone numbers, billing, and dashboards.

TRY THE AI / DEMO LINE:
- Anyone can hear the AI live right now by calling the VoiceAI Connect demo line: (404) 201-7505. It is the fastest way to experience how the receptionist sounds and handles a real call, encourage prospects to call it.
- When a PROSPECT asks how to test the demo, how to try the AI, or for the demo number, GIVE THEM THIS NUMBER directly: (404) 201-7505. You have it, so never tell them to email the team to get the number.
- CAUTION: (404) 201-7505 is the shared, public platform demo line, NOT any one agency's own demo number. For a logged-in agency asking about THEIR demo line or THEIR number, use the number in the live account context, never this shared one. Never imply this shared number is theirs.
- This is VoiceAI Connect's own demo of the product. Separately, Pro and Scale agencies get their OWN branded demo line (a different, auto-provisioned number) that they set up in their dashboard and share with their own prospects.

PLANS & PRICING:
- Free: $0/mo platform, $29.99/client/mo, $0.12/min. Core features, VoiceAI Connect branding (not white-labeled). No trial.
- Pro: $99/mo platform, $9.99/client/mo, $0.10/min. 14-day free trial (credit card required to start - not charged until the trial ends, cancel anytime before then). Includes white-label, AI Lab, lead finder, marketing site, demo line, outreach templates, referrals, 5 agency + 2 client team members.
- Scale: $499/mo platform, $0/client, $0.05/min. 14-day free trial (credit card required to start - not charged until the trial ends, cancel anytime before then). Everything in Pro + unlimited team, BYOT (Twilio), industry templates, priority support.

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
- Voice selection from a premade ElevenLabs library (male/female, various accents/styles, preview playback before choosing). Voice cloning (recording a custom voice) is not offered.

KNOWLEDGE BASE:
- Per-client business info the AI uses: services, pricing, FAQs, hours, policies.
- Editable in AI Lab or by clients in their dashboard.
- More detail = better AI performance. Include services, hours, policies, payment methods, emergency procedures.

PHONE NUMBERS:
- Auto-provisioned US numbers via Telnyx. No A2P registration needed.
- Each client gets their OWN dedicated number. SMS to and from a client's customers always sends from that client's own dedicated number (the same number their callers see), never a shared pool or a shared sender.
- During a call, the AI receptionist can text the caller directly (a booking link, confirmation, address, or reminder) when this is turned on for the client in the AI settings. It sends to the number the caller is calling from.
- CALL FORWARDING (how an existing number reaches the AI): the client keeps their current business number and forwards it to their dedicated AI number. This is GUIDED inside the client's dashboard, there is a call-forwarding card that shows the EXACT code to dial for their carrier, so no one has to search their carrier's support site or call the carrier.
  - They pick their carrier (Verizon / US Cellular, AT&T / T-Mobile, or Other) and a mode: forward ALL calls to the AI, or only MISSED calls (they answer first and the AI catches the ones they miss).
  - The card shows the exact code to dial from the business phone. Verizon / US Cellular: *72 then the AI number to forward all calls, *71 for missed-only, turn it off with *73. AT&T / T-Mobile: **21* then the AI number then # for all calls, **61* then the number then # for missed-only, turn it off with ##21# or ##61#. "Other" carriers see those codes to try with a note to confirm with the carrier if one does not take.
  - It takes about 30 seconds. Either the agency or the business owner can do it, right from the business phone. To answer calls themselves again, they just dial the off-code.
  - Do NOT tell people the steps "vary by carrier" and to look it up themselves or call their carrier, the dashboard card already gives them the exact code. Do NOT invent other codes.
- International numbers via BYOT/Twilio (Scale plan). When an agency connects its own Twilio account, Twilio bills the agency directly for the number, call minutes, and SMS at Twilio's own rates. VoiceAI Connect does NOT add a markup or a separate international surcharge; the agency's VoiceAI Connect charges stay exactly as their plan describes (platform fee, per-client, per-minute), the same as for US numbers.

DEMO PHONE (agency's own line for showing prospects):
- US agencies: the demo number is provisioned automatically on the platform's own telephony, chosen by area code. No Twilio needed.
- Non-US agencies: the demo number is created on the agency's OWN connected Twilio account. Steps: connect Twilio in Settings first, then create the demo line; the platform provisions a local number in the agency's country and points it at the AI demo.
- A non-US demo number requires a PAID Twilio account. Twilio does not let trial accounts provision numbers automatically ("Trial subaccounts cannot purchase phone numbers"), so the agency must upgrade Twilio to paid first.
- Many countries (the UK included) require an approved Twilio regulatory bundle with a registered address before the number can be activated. Set it up in the Twilio Console under Regulatory Compliance; approval takes time, so start early. Without it, Twilio refuses the number and the platform surfaces the reason.
- The agency does NOT buy the number manually. Once Twilio is connected and eligible, the platform searches and provisions it automatically on demo creation.
- KEEPING THE DEMO NUMBER ON UPGRADE: the Free plan's first demo line is free for 30 days, then it expires and the number is released. Upgrading to Pro or Scale KEEPS the exact same demo number the agency already has: it is never changed or re-assigned when they upgrade. Upgrading simply removes the 30-day expiry so the number becomes permanent. A demo number is only released if the agency CANCELS. So an agency worried about losing a demo number they have already shared or printed should be reassured: upgrade before it expires and they keep that exact number for good. (For a logged-in agency, their own current demo number is in the live account context; quote that, never the shared platform demo line.)

CONNECTING TWILIO (BYOT):
- Twilio is only needed for numbers OUTSIDE the US. US numbers are provisioned automatically via Telnyx with nothing to set up.
- Connecting is a credentials paste in Settings, not a coding task: the agency enters its Twilio credentials and the platform handles searching for and provisioning numbers. No API wiring or webhooks on the agency's side.
- Requirements on Twilio's side: a paid (upgraded) Twilio account, and for some countries (e.g. the UK) an approved regulatory bundle in the Twilio Console before a number can go live.

CLIENT APP & ACCESS:
- The client dashboard is a web app (PWA). There is nothing to download from an app store. It opens in any phone or computer browser, and clients can add it to their home screen in one tap for an app-like experience.
- Each client gets their own login to see calls, recordings, transcripts, and AI summaries, manage their business info and AI settings, and text callers back.
- The only step done outside the software is call forwarding, a quick one-time setup with the client's phone carrier to forward their existing business number to the AI number.

NOTIFICATIONS:
- After every call, the business owner gets a text (SMS) with the caller name, phone, the AI's summary, and an urgency flag, plus an email summary with fuller details and a transcript preview.
- High-urgency and emergency calls are flagged in the text so owners know to call back right away.
- Spam-blocked calls send a separate heads-up SMS and are not counted against the monthly limit.
- Note: notifications go out per call with an urgency flag. There is no per-client "summary only" or "urgent only" toggle today, so do not describe one.

WHITE-LABEL & BRANDING (Pro/Scale):
- Logo, colors, theme (light/dark) customizable in Settings > Profile.
- Colors auto-extracted from logo upload.
- Client dashboard header can show agency name or client business name.
- Free plan is NOT white-labeled: VoiceAI Connect branding appears in the surfaces the agency and its clients log in to and get alerts from (the agency dashboard, the client dashboards, the sign-up pages on a VoiceAI Connect subdomain, and the per-call notifications clients receive by text and email). What the clients' OWN customers experience is never VoiceAI-branded on any plan: the AI answers each call as the client's business, texts to callers come from the client's own dedicated number, and appointments book under the business's name. Pro and Scale white-label those log-in and notification surfaces under the agency's own brand and domain.
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
- Delete leads: on the Leads page, tap "Manage" in the top right. In there you can search and filter by industry, status, source, or when a lead was added, tick the ones you want (or Select all), and delete them in bulk. Each row also has its own trash icon for a single delete. You can export the selected or filtered leads to CSV from that same Manage panel.

OUTREACH (Pro/Scale):
- MARKETING KIT: the Outreach tab includes a ready-made Marketing Kit so agencies do NOT have to design their own sales material. It has branded QR codes, a one-page flyer, and a leave-behind to hand a local business, plus the cold-call and text scripts. If an agency is making their own flyer or asks for sales/marketing material, point them to the Marketing Kit in the Outreach tab first (it is branded to them automatically).
- 13 templates: 6 email, 3 SMS, 4 cold call scripts.
- Merge variables for personalization.
- Sequence tracking with follow-up queue.
- Create custom templates.
- IMPORTANT, HOW OUTREACH ACTUALLY SENDS: VoiceAI Connect does NOT send lead outreach emails or SMS for you. It is not an email or text sender. For a lead, it writes the message (subject and body from your templates), copies it to your clipboard, and logs it so the follow-up queue and the lead's history know where you are in the sequence. You then send it yourself from your own email account (Gmail, Outlook, etc.) or your own phone, and come back and mark it logged. So: nothing goes out from VoiceAI Connect, nothing will appear in your Sent folder unless you sent it from your own email, and "Log as sent" / the email and SMS counts on a lead mean "you recorded that you reached out," not that the platform delivered anything. If someone asks why they can't find a sent email, or whether outreach goes out through VoiceAI Connect: it does not, they send from their own email and the platform only drafts and tracks. (This is different from the AI receptionist on a live phone CALL, which can text the caller directly from the client's own number. That is the only outbound messaging the platform does, and it is per call, not lead outreach.)

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

MEDICAL & HEALTHCARE USE:
- Healthcare offices use the AI for answering calls, taking messages, and scheduling.
- The AI is set up to collect only scheduling information (name, phone, new vs existing patient, general reason for visit) and is instructed not to ask about or discuss specific medical details. If a caller shares medical info, it redirects them to the provider.
- Emergency language triggers a 911 / nearest-ER redirect; the AI does not give medical advice.
- Call data is never used to train AI models.
- Do NOT claim HIPAA compliance or a BAA (see HARD RULES). For any HIPAA/PHI question, direct the person to contact the team.

GOOGLE CALENDAR INTEGRATION:
- Built-in Google Calendar integration - AI can check real-time availability and book appointments during calls.
- Caller says they want an appointment -> AI checks Google Calendar -> offers available slots -> books it automatically.
- Calendar events include caller name, phone, and reason for appointment.
- Agencies control which client plan tiers get calendar access (Settings > Pricing, toggle "Google Calendar" per plan).
- Clients connect their own Google account via OAuth (secure, agency never sees credentials).
- Works with shared team calendars - connect the Google account that owns the calendar.
- Troubleshooting: verify Google account connected, correct calendar selected, feature enabled for client's plan tier.
- This automated booking is specific to Google Calendar. Other calendars are not booked automatically today (see INTEGRATIONS for the API/webhook path).

INTEGRATIONS (WHAT IS AND ISN'T AVAILABLE):
- Available: Google Calendar (automated appointment booking, agency chooses which plan tiers get it), Stripe Connect (payments), CSV export of calls, contacts, and analytics, and a developer REST API plus outbound webhooks on the Scale plan (also included for call-center agencies on any plan).
- Developer API (Scale plan): a REST API at /api/v1, authenticated with an API key created in the agency dashboard under Settings (the full key is shown once). Scopes are read or read_write. It can list and manage clients, read calls and recordings, read appointments, manage the receptionist config and knowledge base, pull usage and analytics, and manage webhook subscriptions. It is read plus management: there is no endpoint to create or reschedule an appointment.
- Webhooks (Scale plan): signed outbound webhooks (HMAC, header X-VoiceAI-Signature) for events including call.started, call.completed, call.transferred, call.escalated, appointment.booked, client.provisioned, client.provisioning_failed, and the billing lifecycle events. call.completed carries the full call outcome (caller, summary, transcript, captured details), so it is the main way to push a captured appointment request into any outside calendar or CRM.
- Non-Google calendars: automated booking (checking live availability and writing the event during the call) works only with Google Calendar today. For a client on another calendar, the AI captures the appointment request on the call, and the agency uses the call.completed webhook or the REST API to push it into their own calendar or CRM. True native automated booking into Outlook, Microsoft 365, Acuity, or Calendly is not available yet; if a client needs it, log it as a feature request.
- There are no other native third-party app integrations beyond the ones listed above. If asked about one that is not listed, say it is not available natively today, but note that the Scale-plan API and webhooks let a developer build a custom integration.

DEMO MODE:
- Toggle in Settings > Demo Mode. Shows sample data (14 clients, calls, leads, revenue). Display only, doesn't affect real data.

TROUBLESHOOTING:
- AI not answering: Check AI assistant configured, phone provisioned, subscription active, greeting/prompt not empty.
- Wrong answers: Update knowledge base and system prompt with correct info.
- Can't add client: Set up payment (Free plan needs card for per-client charges).
- Locked features: Requires Pro or Scale upgrade.
- Stripe incomplete: Complete verification in Stripe.
- Sample data showing: Demo Mode is on - toggle off in Settings.

SUPPORT & FEEDBACK:
- Use the help widget for FAQs, the AI assistant, or contacting the team directly.
- Settings > Feedback to send feature requests or feedback.
- Email support@myvoiceaiconnect.com. Support responds within a few hours.
`;

// -- POST /api/help/chat ---------------------------------------------
// AI chatbot powered by Claude
// Build a compact LIVE ACCOUNT CONTEXT block for a logged-in agency or client,
// so the bot answers plan / trial / demo-line questions from this account's real
// data instead of guessing (which previously led it to quote the shared platform
// demo line as if it were the agency's own, and to say it could not see trial
// status). Best-effort: any failure just omits the block and the bot falls back
// to the general knowledge base.
async function buildAccountContext({ userType, agencyId, clientId }) {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return String(d); } };
  const fmtDateTime = (d) => { try { return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return String(d); } };
  const sinceIso = (days) => new Date(now - days * DAY).toISOString();
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const cnt = (r) => (r && typeof r.count === 'number') ? r.count : 0;

  try {
    if (userType === 'agency' && agencyId) {
      const { data: a } = await supabase
        .from('agencies')
        .select('name, plan_type, subscription_status, status, trial_ends_at, demo_phone_number, demo_expires_at, created_at')
        .eq('id', agencyId)
        .maybeSingle();
      if (!a) return '';

      const plan = String(a.plan_type || 'free').toLowerCase();
      const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);

      // All of this agency's clients (bounded). Calls/appointments hang off their ids.
      const { data: clientsRaw } = await supabase
        .from('clients')
        .select('id, business_name, status, subscription_status, plan_type, vapi_phone_number, industry, created_at, trial_ends_at, calls_this_month, is_test_client')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false })
        .limit(200);
      const allClients = clientsRaw || [];
      const realClients = allClients.filter((c) => !c.is_test_client);
      const testCount = allClients.length - realClients.length;
      const clientIds = allClients.map((c) => c.id);
      const nameById = {};
      allClients.forEach((c) => { nameById[c.id] = c.business_name || 'Unnamed'; });

      // Everything else in parallel, scoped to this agency.
      const noIds = clientIds.length === 0;
      const [totalCallsR, calls30R, calls7R, recentCallsR, apptR, leadsR, teamR] = await Promise.all([
        noIds ? Promise.resolve({ count: 0 }) : supabase.from('calls').select('id', { count: 'exact', head: true }).in('client_id', clientIds),
        noIds ? Promise.resolve({ count: 0 }) : supabase.from('calls').select('id', { count: 'exact', head: true }).in('client_id', clientIds).gte('created_at', sinceIso(30)),
        noIds ? Promise.resolve({ count: 0 }) : supabase.from('calls').select('id', { count: 'exact', head: true }).in('client_id', clientIds).gte('created_at', sinceIso(7)),
        noIds ? Promise.resolve({ data: [] }) : supabase.from('calls').select('client_id, created_at, caller_phone, customer_name, service_requested, summary, ai_summary, appointment_booked, urgency_level, is_spam, call_status, duration_seconds').in('client_id', clientIds).order('created_at', { ascending: false }).limit(8),
        noIds ? Promise.resolve({ count: 0 }) : supabase.from('appointments').select('id', { count: 'exact', head: true }).in('client_id', clientIds).gte('appointment_time', new Date(now).toISOString()),
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('agency_id', agencyId),
        supabase.from('team_members').select('id', { count: 'exact', head: true }).eq('entity_type', 'agency').eq('entity_id', agencyId).neq('status', 'disabled'),
      ]);

      const lines = [];
      // Profile + plan + trial + status
      if (a.name) lines.push(`Agency: ${a.name}`);
      lines.push(`Plan: ${planLabel}.`);
      if (a.trial_ends_at) {
        const d = Math.ceil((new Date(a.trial_ends_at).getTime() - now) / DAY);
        lines.push(d > 0
          ? `On a ${planLabel} free trial: ${d} day${d === 1 ? '' : 's'} left (ends ${fmtDate(a.trial_ends_at)}; card not charged until then).`
          : `Their ${planLabel} trial has ended.`);
      } else if (plan === 'free') {
        lines.push(`On the Free plan (no trial period; Free needs no card and activates immediately).`);
      }
      if (a.subscription_status) lines.push(`Subscription status: ${a.subscription_status}.`);

      // Demo line
      if (a.demo_phone_number) {
        if (plan === 'free' && a.demo_expires_at) {
          const d = Math.ceil((new Date(a.demo_expires_at).getTime() - now) / DAY);
          const left = d > 0 ? `, ${d} day${d === 1 ? '' : 's'} left` : '';
          lines.push(`Their OWN demo line: ${a.demo_phone_number} (free 30-day demo, expires ${fmtDate(a.demo_expires_at)}${left}). Upgrading to Pro or Scale KEEPS this exact number and removes the expiry so it is permanent; it is only released if they cancel. Safe to keep on flyers once on a paid plan.`);
        } else {
          lines.push(`Their OWN demo line: ${a.demo_phone_number} (permanent on a paid plan; only released if they cancel).`);
        }
      } else {
        lines.push(`No demo line provisioned yet (they can create one on the Demo Phone page).`);
      }

      // Clients
      const byStatus = {};
      realClients.forEach((c) => { const s = c.status || 'unknown'; byStatus[s] = (byStatus[s] || 0) + 1; });
      const statusStr = Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ') || 'none yet';
      lines.push(`\nCLIENTS: ${realClients.length} real client${realClients.length === 1 ? '' : 's'} (${statusStr})${testCount > 0 ? ` plus ${testCount} test client${testCount === 1 ? '' : 's'}` : ''}.`);
      const listed = realClients.slice(0, 20);
      listed.forEach((c) => {
        const bits = [c.business_name || 'Unnamed'];
        if (c.status) bits.push(c.status);
        if (c.industry) bits.push(c.industry);
        if (c.vapi_phone_number) bits.push(`AI# ${c.vapi_phone_number}`);
        if (typeof c.calls_this_month === 'number') bits.push(`${c.calls_this_month} call${c.calls_this_month === 1 ? '' : 's'} this month`);
        lines.push(`  - ${bits.join(' | ')}`);
      });
      if (realClients.length > listed.length) lines.push(`  (and ${realClients.length - listed.length} more not listed here)`);

      // Calls
      lines.push(`\nCALLS (across all their clients): ${cnt(totalCallsR)} all-time, ${cnt(calls30R)} in the last 30 days, ${cnt(calls7R)} in the last 7 days.`);
      const recent = recentCallsR.data || [];
      if (recent.length) {
        lines.push(`Most recent calls:`);
        recent.forEach((c) => {
          const who = nameById[c.client_id] || 'a client';
          const sum = clip(c.ai_summary || c.summary || c.service_requested, 90);
          const flags = [c.appointment_booked ? 'booked appt' : null, c.is_spam ? 'spam' : null, (c.urgency_level && c.urgency_level !== 'normal') ? c.urgency_level : null].filter(Boolean).join(', ');
          lines.push(`  - ${fmtDateTime(c.created_at)} | ${who}${c.caller_phone ? ` | from ${c.caller_phone}` : ''}${sum ? ` | ${sum}` : ''}${flags ? ` [${flags}]` : ''}`);
        });
      }

      // Appointments / leads / team
      lines.push(`\nUpcoming appointments booked across clients: ${cnt(apptR)}.`);
      lines.push(`Leads in the CRM: ${cnt(leadsR)}${plan === 'free' ? ' (lead finder is a Pro/Scale feature)' : ''}.`);
      lines.push(`Active agency team members: ${cnt(teamR)}.`);

      return `\n\n=== LIVE ACCOUNT CONTEXT (this specific agency, authoritative) ===\n` +
        `Use this for ANY question about their own account: plan, trial, billing status, demo number, their clients, call activity, appointments, leads, or team. Answer from these exact values rather than generalities, and feel free to name specific clients or quote the counts. Never state a demo number other than the one listed here. The shared VoiceAI Connect demo line (404) 201-7505 in the knowledge base is a different, public number anyone can call to hear the AI; it is NOT this agency's own demo line. This snapshot lists up to 20 clients and the 8 most recent calls; if they ask about a client or call not shown, say you can see the totals but point them to the relevant dashboard page for the full list rather than guessing.\n` +
        lines.join('\n');
    }

    if (userType === 'client' && clientId) {
      const { data: c } = await supabase
        .from('clients')
        .select('business_name, industry, plan_type, status, subscription_status, trial_ends_at, vapi_phone_number, calls_this_month, google_calendar_connected')
        .eq('id', clientId)
        .maybeSingle();
      if (!c) return '';

      const [totalCallsR, calls7R, recentCallsR, apptR] = await Promise.all([
        supabase.from('calls').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
        supabase.from('calls').select('id', { count: 'exact', head: true }).eq('client_id', clientId).gte('created_at', sinceIso(7)),
        supabase.from('calls').select('created_at, caller_phone, customer_name, service_requested, summary, ai_summary, appointment_booked, urgency_level, is_spam').eq('client_id', clientId).order('created_at', { ascending: false }).limit(8),
        supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('client_id', clientId).gte('appointment_time', new Date(now).toISOString()),
      ]);

      const lines = [];
      if (c.business_name) lines.push(`Business: ${c.business_name}${c.industry ? ` (${c.industry})` : ''}.`);
      lines.push(`Account status: ${c.subscription_status || c.status || 'unknown'}.`);
      if (c.trial_ends_at) {
        const d = Math.ceil((new Date(c.trial_ends_at).getTime() - now) / DAY);
        if (d > 0) lines.push(`On a trial: ${d} day${d === 1 ? '' : 's'} left (ends ${fmtDate(c.trial_ends_at)}).`);
      }
      if (c.vapi_phone_number) lines.push(`Their AI receptionist number: ${c.vapi_phone_number}.`);
      lines.push(`Google Calendar: ${c.google_calendar_connected ? 'connected' : 'not connected'}.`);
      lines.push(`\nCALLS: ${cnt(totalCallsR)} all-time, ${cnt(calls7R)} in the last 7 days.`);
      const recent = recentCallsR.data || [];
      if (recent.length) {
        lines.push(`Most recent calls:`);
        recent.forEach((rc) => {
          const sum = clip(rc.ai_summary || rc.summary || rc.service_requested, 90);
          const flags = [rc.appointment_booked ? 'booked appt' : null, rc.is_spam ? 'spam' : null, (rc.urgency_level && rc.urgency_level !== 'normal') ? rc.urgency_level : null].filter(Boolean).join(', ');
          lines.push(`  - ${fmtDateTime(rc.created_at)}${rc.caller_phone ? ` | from ${rc.caller_phone}` : ''}${sum ? ` | ${sum}` : ''}${flags ? ` [${flags}]` : ''}`);
        });
      }
      lines.push(`\nUpcoming appointments: ${cnt(apptR)}.`);

      return `\n\n=== LIVE ACCOUNT CONTEXT (this specific client business, authoritative) ===\n` +
        `Use this for ANY question about their own account, AI number, calls, or appointments. Answer from these exact values. This lists the 8 most recent calls; for the full history point them to their Calls page.\n` +
        lines.join('\n');
    }
  } catch (e) {
    console.warn('help: buildAccountContext failed (non-fatal):', e.message);
  }
  return '';
}

router.post('/chat', async (req, res) => {
  try {
    const { message, history = [], sessionId, audience, agencyId } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'AI service not configured' });
    }

    // Who is asking decides how to frame the same knowledge base. Default to
    // prospect (the public bot) when the caller did not say.
    const aud = ['prospect', 'agency', 'client'].includes(audience) ? audience : 'prospect';
    let systemPrompt = `${KB_CONTEXT}\n\n${AUDIENCE_PROMPTS[aud]}`;

    // Attribution for the admin inbox comes from the auth token, not the
    // client-supplied body: an in-app help chat must always carry its agency,
    // and a client's chat resolves to the client's agency so it is never
    // orphaned. Falls back to the body values only for an anonymous prospect.
    let originUserType = aud;
    let originAgencyId = agencyId || null;
    let originClientId = null;
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const role = decoded.role || null;
        const tokAgency = decoded.agencyId || decoded.agency_id || null;
        const tokClient = decoded.clientId || decoded.client_id || null;
        if (tokClient && !tokAgency) {
          originUserType = 'client';
          originClientId = tokClient;
          const { data: c } = await supabase.from('clients').select('agency_id').eq('id', tokClient).single();
          originAgencyId = (c && c.agency_id) || null;
        } else if (tokAgency) {
          originUserType = (role && String(role).startsWith('client')) ? 'client' : 'agency';
          originAgencyId = tokAgency;
          if (tokClient) originClientId = tokClient;
        }
      }
    } catch { /* no/invalid token: anonymous prospect, keep body values */ }

    // Fold in this account's live data (plan, trial, their own demo number) so
    // the bot answers account-specific questions accurately instead of guessing.
    systemPrompt += await buildAccountContext({ userType: originUserType, agencyId: originAgencyId, clientId: originClientId });
    const sourceMap = { prospect: 'marketing', agency: 'agency_dashboard', client: 'client_dashboard' };
    const origin = { userType: originUserType, agencyId: originAgencyId, source: sourceMap[originUserType] || sourceMap[aud] };

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
      system: systemPrompt,
      messages,
    });

    const assistantResponse = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    res.json({ response: assistantResponse });

    // Alert the owner on the FIRST message of a logged-in agency/client chat.
    // Awaited (after the response is already sent) so its "is this a new session"
    // check runs before the log inserts below, never seeing its own rows.
    await notifyHelpChat({ sessionId, aud, agencyId: origin.agencyId, message: message.trim() });

    // Log the exchange with its origin (fire-and-forget, non-blocking). Stamp the
    // user turn strictly before the assistant turn so the admin inbox always
    // renders the question above its answer.
    const turnMs = Date.now();
    logWidgetChat(sessionId, 'user', message.trim(), origin, new Date(turnMs).toISOString());
    logWidgetChat(sessionId, 'assistant', assistantResponse, origin, new Date(turnMs + 1000).toISOString());
  } catch (err) {
    console.error('Support chat error:', err);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// -- POST /api/help/message ------------------------------------------
// Support escalation. Persists to support_requests (admin Support queue) AND
// texts the platform owner. Both are independent best-effort: a DB failure must
// not lose the SMS, and an SMS failure must not lose the DB record. Returns
// success as long as the request was captured in at least one place.
//
// Two callers:
//   1. Logged-in dashboard widget (components/support-widget.tsx): sends a
//      Bearer token + { message }. Identity comes from the token.
//   2. Anonymous marketing-site prospect (components/SupportWidget.tsx via
//      /api/widget/escalate): no token, sends { name, contact, message,
//      conversationSummary }. Treated as a prospect; the record + SMS are built
//      from those fields.
router.post('/message', async (req, res) => {
  try {
    const { message, name, contact, conversationSummary, sessionId } = req.body || {};

    // Pull identity from the auth token FIRST (moved above the escalation log so
    // the log row carries the agency, instead of landing as an orphan). generateToken
    // mints { userId, email, role, agencyId, clientId } (camelCase); fall back to
    // snake_case defensively. role distinguishes agency vs client callers.
    let userEmail = 'Unknown';
    let agencyId = null;
    let clientId = null;
    let role = null;
    let hasToken = false;
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        hasToken = true;
        userEmail = decoded.email || 'Unknown';
        agencyId = decoded.agencyId || decoded.agency_id || null;
        clientId = decoded.clientId || decoded.client_id || null;
        role = decoded.role || null;
      }
    } catch {
      // Token parsing failed, continue as anonymous.
    }
    // A client escalation resolves to the client's agency so it is never orphaned.
    if (clientId && !agencyId) {
      try { const { data: c } = await supabase.from('clients').select('agency_id').eq('id', clientId).single(); agencyId = (c && c.agency_id) || null; } catch {}
    }
    const escUserType = hasToken ? ((role && String(role).startsWith('client')) ? 'client' : 'agency') : null;
    const escSource = hasToken ? (escUserType === 'client' ? 'client_dashboard' : 'agency_dashboard') : 'marketing';

    // Flag the originating FAQ-bot session as escalated, WITH attribution so an
    // in-app escalation merges into the right agency's conversation. (The admin
    // inbox also filters these marker rows out of the visible thread.)
    logWidgetChat(sessionId, 'escalation', `Escalated to support. Name: ${(typeof name === 'string' && name.trim()) || '(none)'} / Contact: ${(typeof contact === 'string' && contact.trim()) || '(none)'}`, { userType: escUserType, agencyId, source: escSource });

    // Anonymous marketing-site prospect: no valid token but name/contact given
    // by the /api/widget/escalate forwarder. Contact is required upstream.
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const trimmedContact = typeof contact === 'string' ? contact.trim() : '';
    const isProspect = !hasToken && (trimmedName.length > 0 || trimmedContact.length > 0);

    // Compose the effective message. For a prospect we fold the typed message
    // and the chat transcript into one body and tag it so it is unmistakable in
    // the admin queue. A prospect who typed nothing still counts as a valid
    // callback request (contact was required upstream).
    let composed = typeof message === 'string' ? message.trim() : '';

    if (isProspect) {
      const parts = [];
      parts.push('[Marketing site prospect - requested a person]');
      parts.push(`Name: ${trimmedName || 'Not given'}`);
      parts.push(`Contact: ${trimmedContact || 'Not given'}`);
      parts.push('');
      parts.push(composed || '(No message typed - prospect asked to be contacted.)');
      const transcript = typeof conversationSummary === 'string' ? conversationSummary.trim() : '';
      if (transcript) {
        parts.push('');
        parts.push('--- Chat history ---');
        parts.push(transcript);
      }
      composed = parts.join('\n');
    }

    if (!composed) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Derive identity fields for the record and SMS.
    let userType;
    let displayName;
    if (isProspect) {
      // Keep user_type at a proven-safe value so a queue-table enum/CHECK
      // constraint can never reject the insert; the prospect is identified by
      // the message tag above and the SMS label below.
      userType = 'agency';
      displayName = trimmedName || 'Website visitor';
      userEmail = trimmedContact || 'Unknown';
    } else {
      userType =
        (role && String(role).startsWith('client')) || (clientId && !agencyId)
          ? 'client'
          : 'agency';
      displayName = 'Unknown';
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
    }

    const cleanMessage = composed.substring(0, 2000);

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
        admin_unread: 1,
      });
      if (insertErr) console.error('support_requests insert failed (non-blocking):', insertErr.message);
      else persisted = true;
    } catch (dbErr) {
      console.error('support_requests insert threw (non-blocking):', dbErr.message);
    }

    // 2) Text the platform owner.
    let smsSent = false;
    if (SUPPORT_PHONE) {
      try {
        const whoLabel = isProspect ? 'Prospect' : (userType === 'client' ? 'Client' : 'Agency');
        // No preview; just a heads-up to go handle it in the admin dashboard.
        const smsBody = [
          isProspect ? '📞 New callback request' : '🆘 New support request',
          `${whoLabel}: ${displayName}`,
          'Check your admin dashboard to view and reply.',
        ].join('\n');

        await sendAndLogSMS({
          phone: SUPPORT_PHONE,
          message: smsBody,
          agencyId: agencyId,
          recipientType: 'admin',
          messageType: 'support_escalation',
          metadata: { name: displayName, contact: userEmail, userType: isProspect ? 'prospect' : userType },
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

// ============================================================================
// GET /api/help/history
// The agency's full help-widget conversation, rebuilt from widget_chat_log so
// it is ALWAYS available server-side: it survives refreshes, new devices, and
// sign-out, and the owner can scroll back through everything they have asked.
// Scoped to the authenticated agency via the token (never another agency's),
// and to the agency-dashboard widget. Marketing visitors have no token / no
// persistent identity, so they stay session-only. Oldest first. Never throws:
// returns an empty history on any problem so the widget never breaks.
// ============================================================================
router.get('/history', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.json({ messages: [] });
    let agencyId = null;
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      agencyId = decoded.agencyId || decoded.agency_id || null;
    } catch { return res.json({ messages: [] }); }
    if (!agencyId) return res.json({ messages: [] });

    const { data, error } = await supabase
      .from('widget_chat_log')
      .select('role, content, created_at')
      .eq('agency_id', agencyId)
      .eq('source', 'agency_dashboard')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) { console.error('help history error:', error.message); return res.json({ messages: [] }); }

    const messages = (data || [])
      .reverse()
      .filter((r) => (r.role === 'user' || r.role === 'assistant') && r.content)
      .map((r) => ({ role: r.role, content: r.content }));
    return res.json({ messages });
  } catch (e) {
    console.error('help history error:', e.message);
    return res.json({ messages: [] });
  }
});

module.exports = router;