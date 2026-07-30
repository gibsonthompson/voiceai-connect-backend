// ============================================================================
// VOICEAI CONNECT - MULTI-TENANT BACKEND SERVER
// UPDATED: Team member routes mounted, Content render service mounted
// UPDATED: 2026-05-07, Usage tracking cron + usage summary endpoint (Phase 1)
// UPDATED: 2026-05-19, Phase 3A: Staff members + client services routes
// UPDATED: 2026-06-03, /api/agency/cancel now releases the agency demo number
// UPDATED: 2026-06-07, Generic client field update endpoint (business_name, owner_phone, etc.)
// UPDATED: 2026-06-07, Exclude test clients from dashboard/analytics MRR and stats
// UPDATED: 2026-06-10, /api/agency/cancel now captures reason + feedback,
//                       writes to subscription_cancellations, SMS's platform owner.
// UPDATED: 2026-06-30, Telnyx whisper warm transfer: /webhook/telnyx-voice
//                       (raw body) + /api/voice/request-transfer mounted.
// UPDATED: 2026-07-11: Connect financials + account-session endpoints wired
//                      for the agency Payments page, hardened with
//                      requireAgencyAccess (valid token + caller-owns-:agencyId
//                      + 'billing' Page Access for staff).
// UPDATED: 2026-07-19: POST /api/agency/:agencyId/connect/sync-branding pushes
//                      the agency's logo + brand colors to their connected
//                      Stripe account, so their clients' checkout carries the
//                      agency's branding. Backfill for accounts that connected
//                      before branding sync existed; new accounts get it
//                      automatically on first charges-enabled.
//                      GET /api/agency/:agencyId/settings was considered for a
//                      token requirement and deliberately left open: it is also
//                      called anonymously by the onboarding page and the
//                      white-label branding context.
//                      Also mounts POST /api/agency/:agencyId/connect/login-link
//                      (one-time Express dashboard link for the Payments page)
//                      and POST /api/cron/reconcile-subscriptions (self-heals
//                      client rows against real Stripe status).
// UPDATED: 2026-07-29: Mount admin-calls router (calls + demos feeds) that the
//                      redesigned admin Overview and Calls pages read from.
// Destination: src/server.js (or src/index.js), FULL REPLACEMENT
// ============================================================================
require('dotenv').config();

// Force IPv4-first DNS resolution. In the DigitalOcean container, resolving a
// Cloudflare-fronted host (e.g. api.elevenlabs.io) to an IPv6 address that the
// container cannot route makes outbound fetches hang on connect until the
// gateway times out (502/504). IPv4-first avoids that dead IPv6 path.
require('dns').setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const { supabase } = require('./lib/supabase');
const { fullyReleaseNumber } = require('./lib/vapi');
const { releaseBYOTNumber } = require('./routes/byot');
const { expressErrorHandler, setupProcessErrorHandlers } = require('./lib/error-monitor');
const { sendPlatformNotificationSMS, sendAgencySignupNotificationSMS } = require('./lib/notifications');

const app = express();
const PORT = process.env.PORT || 8080;
const fs = require('fs');
const RENDERS_DIR = '/workspace/renders';
if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR, { recursive: true });
const MEDIA_DIR = '/workspace/media';
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
// ============================================================================
// MIDDLEWARE
// ============================================================================

// ============================================================================
// GLOBAL OPTIONS PREFLIGHT HANDLER (runs before async CORS check)
// ============================================================================
app.options('*', (req, res) => {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://myvoiceaiconnect.com',
    'https://www.myvoiceaiconnect.com',
    'https://callbirdai.com',
    'https://www.callbirdai.com',
    'https://social-automation.vercel.app',
  ];
  
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes(origin) || /^https:\/\/[^.]+\.myvoiceaiconnect\.com$/.test(origin) || /\.vercel\.app$/.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Render-Key');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

// DYNAMIC CORS - Allows subdomains AND verified custom domains
// ============================================================================
const corsOptions = {
  origin: async function (origin, callback) {
    if (!origin) return callback(null, true);

    const staticAllowed = [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://myvoiceaiconnect.com',
      'https://www.myvoiceaiconnect.com',
      'https://callbirdai.com',
      'https://www.callbirdai.com',
      'https://social-automation.vercel.app',
    ];

    if (staticAllowed.includes(origin)) return callback(null, true);
    if (/^https:\/\/[^.]+\.myvoiceaiconnect\.com$/.test(origin)) return callback(null, true);
    if (/\.vercel\.app$/.test(origin)) return callback(null, true);

    try {
      const originHost = new URL(origin).hostname.replace('www.', '');
      const { data } = await supabase
        .from('agencies')
        .select('id')
        .eq('marketing_domain', originHost)
        .eq('domain_verified', true)
        .single();

      if (data) return callback(null, true);
    } catch (err) {
      console.error('CORS domain check error:', err.message);
    }

    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Render-Key'],
  credentials: true
};

app.use(cors(corsOptions));

app.use((req, res, next) => {
  if (req.originalUrl === '/webhook/stripe' || req.originalUrl === '/webhook/stripe-connect' || req.originalUrl === '/webhook/telnyx-sms' || req.originalUrl === '/webhook/telnyx-voice') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

// ============================================================================
// IMPORT HANDLERS
// ============================================================================

const { handleAgencySignup, handleAgencyOnboarding } = require('./routes/agency-signup');
const { getAgencyByHost, getAgencyByIdPublic, getAgencySettings, updateAgencySettings, verifyAgencyDomain } = require('./routes/agency-settings');
const demoPhoneRoutes = require('./routes/demo-phone');
const referralRoutes = require('./routes/referrals');

let domainRoutes;
try {
  domainRoutes = require('./routes/domains');
  console.log('✅ Domain routes module loaded');
} catch (err) {
  console.error('❌ Failed to require domain routes:', err.message);
  const express = require('express');
  domainRoutes = express.Router();
  domainRoutes.all('*', (req, res) => {
    res.status(500).json({ error: 'Domain routes failed to load', details: err.message });
  });
}

const { handleClientSignup, provisionClient, handleAgencyAddClient, signupRateLimiter } = require('./routes/client-signup');
const clientRoutes = require('./routes/client');
const clientContactsRoutes = require('./routes/client-contacts');
const clientPromptRoutes = require('./routes/client-prompt');
const clientKnowledgeBaseRoutes = require('./routes/client-knowledge-base');
const toolConfigRoutes = require('./routes/tool-config');
const pwaTrackingRoutes = require('./routes/pwa-tracking');
const leadRoutes = require('./routes/leads');
const activityRoutes = require('./routes/activity');
const outreachRoutes = require('./routes/outreach');
const agencyTemplatesRoutes = require('./routes/agency-templates');
const aiPlaygroundRoutes = require('./routes/ai-playground');
const leadScraperRoutes = require('./routes/lead-scraper');
const byotRoutes = require('./routes/byot');
const abandonedCartRoutes = require('./routes/abandoned-cart');
const abandonedCheckoutCleanupRoutes = require('./routes/abandoned-checkout-cleanup');
const agencyOnboardingSmsRoutes = require('./routes/agency-onboarding-sms');
const activationSmsRoutes = require('./routes/activation-sms');
const feedbackRoutes = require('./routes/feedback');
const supportRoutes = require('./routes/support');
const helpRoutes = require('./routes/help');
const ytContentRoutes = require('./routes/yt-content');
const teamRoutes = require('./routes/team');
const contentRender = require('./content-render');  // Content render service
const restoRoutes = require('./routes/resto');  // Restoration platform routes

// Usage tracking (Phase 1, metered billing)
const usageReporterRoutes = require('./cron/usage-reporter');
const { getAgencyUsageSummary } = require('./lib/usage-tracker');
const testClientRoutes = require('./routes/test-client');
const bookingRoutes = require('./routes/booking');
const staffMembersRoutes = require('./routes/staff-members');
const clientServicesRoutes = require('./routes/client-services');
const cleanupOrphanedTestClients = require('./routes/cleanup-orphaned-test-clients');
// VAPI Webhook (multi-tenant aware)
const { handleVapiWebhook } = require('./webhooks/vapi-webhook');

// SUPPORT LINE ADDITION: Voice support webhook (shared number, dynamic agency context)
const { handleSupportWebhook } = require('./webhooks/vapi-support-webhook');

const { 
  createAgencyCheckout, 
  createAgencyPortal,
  handlePlatformStripeWebhook,
  warnExpiringAgencyTrials
} = require('./routes/stripe-platform');

const {
  createConnectAccountLink,
  getConnectStatus,
  getConnectFinancials,
  createConnectAccountSession,
  createConnectLoginLink,
  disconnectConnectAccount,
  createClientCheckout,
  createClientPortal,
  changeClientPlan,
  syncConnectBrandingHandler,
  handleConnectStripeWebhook,
  expireTrials,
  reconcileClientSubscriptions,
  setMinutePassThrough
} = require('./routes/stripe-connect');

const { 
  agencyLogin, 
  clientLogin, 
  verifyToken,
  setPassword,
  changePassword,
  authMiddleware,
  requirePermission,
  requirePermissionIfAuthed,
  requireAgencyAccess,
  generateToken
} = require('./routes/auth');

const passwordResetRoutes = require('./routes/password-reset');
const { googleAuth, googleCallback } = require('./routes/google-auth');
const calendarRoutes = require('./routes/calendar');
const googleCalendarAuthRoutes = require('./routes/google-calendar-auth');
const { updateAssistantCalendar } = require('./lib/calendar-tools');
const adminRoutes = require('./routes/admin');
const adminCallsRoutes = require('./routes/admin-calls');
const adminAgencyDetail = require('./routes/admin-agency-detail');
const smsLogRoutes = require('./routes/sms-log');
const errorReportRoutes = require('./routes/error-report');
const previewTokenRoutes = require('./routes/preview-token');
const smsRoutes = require('./routes/sms');
const { handleTelnyxSMSWebhook } = require('./routes/sms');
// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    platform: 'voiceai-connect',
    features: {
      multiTenant: true,
      stripeConnect: true,
      vapiIntegration: true,
      automatedDomains: true,
      referralProgram: true,
      googleOAuth: true,
      googleCalendar: true,
      aiTemplates: true,
      aiPlayground: true,
      byot: true,
      teamMembers: true,
      contentRender: true,
      usageBilling: true
    },
    cron: {
      expireTrials: true,
      abandonedCart: true,
      agencyOnboardingSms: true,
      usageReporter: true
    }
  });
});

// ============================================================================
// CONTENT RENDER SERVICE (Social Media Image Generation)
// ============================================================================
app.use('/renders', express.static(RENDERS_DIR, { maxAge: '1d' }));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '30d' }));
app.use('/thumbnails', express.static('/workspace/thumbnails', { maxAge: '1d' }));
const mediaUpload = require('./media-upload');
app.use('/api/media', mediaUpload);

app.use('/api/content-render', contentRender);
app.use('/api/resto', restoRoutes);

// ============================================================================
// AGENCY ROUTES (Platform → Agencies)
// ============================================================================

app.post('/api/agency/signup', handleAgencySignup);
app.post('/api/agency/onboarding', handleAgencyOnboarding);

// ============================================================================
// AGENCY ACTIVATED NOTIFICATION (free path)
// ----------------------------------------------------------------------------
// The Free plan activates in the Next route app/api/agency/start-trial, which
// runs on Vercel and cannot call the notifications lib here directly. On a
// successful pending -> active transition it POSTs here so the platform owner
// gets the "New Agency Activated" SMS with the chosen plan (Free). Paid
// activations fire the same notification inline in handleAgencyCheckoutCompleted
// (routes/stripe-platform.js). This is NOT the premature step-1 signup SMS,
// which was removed from handleAgencyOnboarding.
//
// Registered here, before the app.use('/api/agency', ...) routers below, so the
// exact-path match wins. Guards: only sends for a genuinely activated agency,
// plus a short in-memory dedupe so an accidental double POST cannot text twice.
// start-trial rejects non-pending agencies, so in practice this is called once.
// ============================================================================
const _activationNotified = new Map();

app.post('/api/agency/:agencyId/notify-activated', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, name, email, phone, referral_source, country, plan_type, status, subscription_status, onboarding_completed')
      .eq('id', agencyId)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Only notify for a genuinely activated agency (guards a stray/early call).
    const activated =
      agency.onboarding_completed === true ||
      agency.status === 'active' ||
      agency.subscription_status === 'active';
    if (!activated) {
      return res.json({ success: false, skipped: 'not_activated' });
    }

    // Short in-memory dedupe so an accidental double POST (retry, refresh)
    // does not text the owner twice. The start-trial route already calls this
    // once on a successful pending -> active transition.
    const now = Date.now();
    const last = _activationNotified.get(agencyId) || 0;
    if (now - last < 10 * 60 * 1000) {
      return res.json({ success: true, skipped: 'recently_notified' });
    }
    _activationNotified.set(agencyId, now);

    try {
      await sendAgencySignupNotificationSMS(agency);
    } catch (smsErr) {
      console.error('notify-activated SMS failed (non-blocking):', smsErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('notify-activated error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});
app.get('/api/agency/by-host', getAgencyByHost);
// Embed-widget Path A: iframe loads myvoiceaiconnect.com/get-started?agency=UUID
// and looks the agency up by ID since there's no host-based context to derive.
app.get('/api/agency/by-id', getAgencyByIdPublic);
// Dashboard bootstrap, but ALSO called with no token by app/onboarding/page.tsx
// (agency onboarding, before a session exists) and lib/branding-context.tsx
// (white-label branding for logged-out visitors on public pages). It therefore
// stays open: adding a token requirement here breaks agency onboarding and
// public branding. Session-expiry detection is handled in the frontend context
// against /api/auth/verify instead. Note this route is publicly readable by
// agency id, which is a separate item worth closing later.
app.get('/api/agency/:agencyId/settings', getAgencySettings);
// Page Access gating: a logged-in agency_staff member without the 'settings'
// toggle can't write settings. Unauthenticated/owner calls pass through (the
// guard is a no-op without a staff token), so no existing caller breaks.
app.put('/api/agency/:agencyId/settings', requirePermissionIfAuthed('settings'), updateAgencySettings);
app.post('/api/agency/:agencyId/domain/verify', verifyAgencyDomain);
// 'billing' gates the agency's own subscription actions. checkout is also hit
// during signup before a token exists, so the soft guard is required here -
// it only blocks an authenticated staff member who lacks 'billing'.
app.post('/api/agency/checkout', requirePermissionIfAuthed('billing'), createAgencyCheckout);
app.post('/api/agency/portal', requirePermissionIfAuthed('billing'), createAgencyPortal);

// ============================================================================
// AGENCY CANCELLATION
// ----------------------------------------------------------------------------
// Reads { agency_id, reason, feedback } from the body. reason is the Stripe
// cancellation_details.feedback enum value (too_expensive, missing_features,
// switched_service, unused, too_complex, customer_service, low_quality, other)
// chosen from the dropdown in app/agency/settings/page.tsx. feedback is the
// optional free-text comment from the textarea below the dropdown.
//
// Side effects in order:
//   1. Cancel the Stripe subscription (passing reason+feedback as
//      cancellation_details so Stripe Dashboard shows them and the resulting
//      customer.subscription.deleted webhook fires with the same data).
//   2. Release the VAPI demo number + Telnyx rental + demo assistant.
//   3. Mark the agency canceled and null out demo fields.
//   4. Cascade-suspend all clients (status='cancelled',
//      subscription_status='agency_canceled').
//   5. Upsert a row in subscription_cancellations keyed on
//      stripe_subscription_id. The webhook handler
//      (handleAgencySubscriptionDeleted in routes/stripe-platform.js) checks
//      for an existing row before sending its own SMS, so this path owns
//      the admin notification for app-initiated cancellations.
//   6. SMS the platform owner with reason, feedback, plan, MRR lost.
// ============================================================================
app.post('/api/agency/cancel', requirePermissionIfAuthed('billing'), async (req, res) => {
  const { agency_id, reason, feedback } = req.body;

  if (!agency_id) {
    return res.status(400).json({ error: 'agency_id required' });
  }

  try {
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, name, email, plan_type, subscription_status, stripe_subscription_id, demo_vapi_phone_id, demo_phone_number, demo_assistant_id, twilio_account_sid, twilio_api_key_encrypted, twilio_api_secret_encrypted')
      .eq('id', agency_id)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    console.log('🛑 Canceling subscription for:', agency.name);

    const isTrialing =
      agency.subscription_status === 'trial' ||
      agency.subscription_status === 'trialing';

    if (agency.stripe_subscription_id) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      try {
        await stripe.subscriptions.cancel(agency.stripe_subscription_id, {
          cancellation_details: {
            feedback: reason || undefined,    // Stripe enum
            comment:  feedback || undefined,  // free-text
          },
        });
        console.log('✅ Stripe subscription canceled');
      } catch (stripeErr) {
        console.error('Stripe cancel error (continuing):', stripeErr.message);
      }
    }

    // Release the agency demo number (VAPI object + underlying Telnyx rental)
    // so it stops billing once the agency is canceled.
    if (agency.demo_vapi_phone_id || agency.demo_phone_number) {
      try {
        const release = await fullyReleaseNumber(agency.demo_vapi_phone_id, agency.demo_phone_number);
        console.log(`📞 Demo released for ${agency.name}: VAPI=${release.vapiDeleted} Telnyx=${release.telnyxReleased}`);
        if (!release.telnyxReleased) {
          console.error(`⚠️ Telnyx demo NOT released for ${agency.name} (${agency.demo_phone_number}), orphan sweep will catch it`);
        }
        // BYOT: a non-US agency's demo number was provisioned on the agency's
        // OWN Twilio, so fullyReleaseNumber (VAPI + Telnyx) cannot release it.
        // Release it from the agency's Twilio too. Never throws, and no-ops
        // when the agency has no Twilio creds (US agencies).
        if (agency.twilio_account_sid && agency.twilio_api_key_encrypted && agency.demo_phone_number) {
          try { await releaseBYOTNumber(agency, agency.demo_phone_number); }
          catch (byotErr) { console.error('BYOT demo release failed (continuing):', byotErr.message); }
        }
        if (agency.demo_assistant_id && process.env.VAPI_API_KEY) {
          try {
            await fetch(`https://api.vapi.ai/assistant/${agency.demo_assistant_id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` },
            });
          } catch (e) { /* non-blocking */ }
        }
      } catch (relErr) {
        console.error('Demo release failed (continuing):', relErr.message);
      }
    }

    await supabase
      .from('agencies')
      .update({ 
        subscription_status: 'canceled', 
        status: 'canceled',
        demo_phone_number: null,
        demo_assistant_id: null,
        demo_vapi_phone_id: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', agency_id);

    const { data: clients } = await supabase
      .from('clients')
      .select('id')
      .eq('agency_id', agency_id);

    if (clients && clients.length > 0) {
      await supabase
        .from('clients')
        .update({ 
          status: 'cancelled', 
          subscription_status: 'agency_canceled' 
        })
        .eq('agency_id', agency_id);
      
      console.log(`⚠️ Suspended ${clients.length} clients`);
    }

    // Record cancellation with reason + feedback. Upsert keyed on
    // stripe_subscription_id so the subsequent webhook won't duplicate.
    const mrrLost =
      agency.plan_type === 'pro'   ? 9900  :
      agency.plan_type === 'scale' ? 49900 :
      0;

    try {
      await supabase
        .from('subscription_cancellations')
        .upsert(
          {
            agency_id: agency.id,
            stripe_subscription_id: agency.stripe_subscription_id || null,
            source: 'app',
            reason: reason || null,
            feedback: feedback || null,
            plan_type: agency.plan_type,
            mrr_lost: mrrLost,
            canceled_at: new Date().toISOString(),
            effective_at: new Date().toISOString(),
          },
          { onConflict: 'stripe_subscription_id', ignoreDuplicates: false }
        );
    } catch (recordErr) {
      console.error('Failed to record cancellation:', recordErr.message);
    }

    // SMS the platform owner with structured cancellation details.
    try {
      const REASON_LABELS = {
        too_expensive:     'Too expensive',
        missing_features:  'Missing features',
        switched_service:  'Switched to another service',
        unused:            'Not using it enough',
        customer_service:  'Customer service issues',
        too_complex:       'Too complex',
        low_quality:       'Quality issues',
        other:             'Other',
      };
      const reasonLabel = REASON_LABELS[reason] || reason || 'No reason given';
      const planLabel =
        agency.plan_type === 'pro'   ? 'Pro ($99/mo)' :
        agency.plan_type === 'scale' ? 'Scale ($499/mo)' :
        agency.plan_type || 'Free';

      let msg = `❌ Agency Cancellation\n`;
      msg += `Agency: ${agency.name}\n`;
      msg += `Email: ${agency.email}\n`;
      msg += `Plan: ${planLabel}\n`;
      msg += `Status: ${isTrialing ? 'TRIAL' : 'PAID'}\n`;
      msg += `Reason: ${reasonLabel}\n`;
      if (feedback && feedback.trim()) {
        msg += `\n"${feedback.trim()}"\n`;
      }
      if (mrrLost > 0) {
        msg += `\nMRR lost: $${(mrrLost / 100).toFixed(0)}/mo`;
      }

      await sendPlatformNotificationSMS(msg);
    } catch (smsErr) {
      console.error('Failed to send cancellation SMS to platform owner:', smsErr.message);
    }

    console.log('✅ Agency subscription canceled:', agency.name);
    res.json({ success: true, message: 'Subscription canceled' });

  } catch (err) {
    console.error('❌ Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Stripe Connect = the Payments tab, which is grouped under the 'settings'
// permission in the settings page tab gating. status (GET) stays open.
app.post('/api/agency/connect/onboard', requirePermissionIfAuthed('settings'), createConnectAccountLink);
app.get('/api/agency/connect/status/:agencyId', getConnectStatus);
app.post('/api/agency/:agencyId/connect/disconnect', requirePermissionIfAuthed('settings'), disconnectConnectAccount);

// Payments page data. Read-only against the connected Express account (balance,
// payouts, recent charges). account-session mints an embedded-components secret
// (phase 2). requireAgencyAccess REQUIRES a valid token, confirms the caller
// owns :agencyId (super_admin and admin-impersonation tokens pass), and for an
// agency_staff member enforces the 'billing' Page Access permission. Balance is
// sensitive, so unlike the other connect routes these reject anonymous callers.
app.get('/api/agency/connect/financials/:agencyId', requireAgencyAccess('billing'), getConnectFinancials);
app.post('/api/agency/connect/account-session/:agencyId', requireAgencyAccess('billing'), createConnectAccountSession);

// Push the agency's logo + brand colors onto their connected Stripe account, so
// their clients' hosted checkout, receipts, invoices, and customer portal carry
// the agency's branding instead of an unbranded default. New accounts get this
// automatically when charges are first enabled (handleAccountUpdated in
// routes/stripe-connect.js); this route exists to backfill accounts that
// connected earlier and to re-push after a branding change. 'settings' Page
// Access because it mirrors the Payments/branding surface in the settings page.
app.post('/api/agency/:agencyId/connect/sync-branding', requireAgencyAccess('settings'), syncConnectBrandingHandler);

// One-time login link into the agency's Express Stripe dashboard (payouts, bank
// account, transactions). requireAgencyAccess('billing') because it exposes the
// agency's own financial dashboard; only a verified owner of :agencyId passes.
app.post('/api/agency/:agencyId/connect/login-link', requireAgencyAccess('billing'), createConnectLoginLink);

// Toggle client-facing per-minute billing on or off for the agency. On enable
// it validates a rate is set and Connect is chargeable (rejects otherwise),
// ensures the connected-account meter, and sweeps existing clients to attach
// the metered item. On disable it flips the flag; reporting stops immediately
// and inert items are cleaned up at each client's next renewal. Body:
// { enabled: true|false }. requireAgencyAccess('billing') because it changes
// what the agency's clients are charged; only a verified owner of :agencyId
// (or super_admin) passes.
app.post('/api/agency/:agencyId/minute-pass-through', requireAgencyAccess('billing'), setMinutePassThrough);

// ============================================================================
// AGENCY DASHBOARD & CLIENTS ROUTES
// ============================================================================

app.get('/api/agency/:agencyId/dashboard', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, business_name, plan_type, subscription_status, status, calls_this_month, created_at, is_test_client')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching agency clients:', error);
      return res.status(400).json({ error: error.message });
    }

    const clientList = clients || [];
    // Test clients don't count toward revenue or paying-client metrics
    const realClients = clientList.filter(c => !c.is_test_client);

    const { data: agency } = await supabase
      .from('agencies')
      .select('price_starter, price_pro, price_growth')
      .eq('id', agencyId)
      .single();

    let mrr = 0;
    realClients.forEach(client => {
      if (client.subscription_status === 'active') {
        switch (client.plan_type) {
          case 'starter': mrr += agency?.price_starter || 4900; break;
          case 'pro': mrr += agency?.price_pro || 9900; break;
          case 'growth': mrr += agency?.price_growth || 14900; break;
        }
      }
    });

    const totalCalls = clientList.reduce((sum, c) => sum + (c.calls_this_month || 0), 0);
    const recentClients = clientList.slice(0, 5);

    console.log(`📊 Dashboard loaded for agency ${agencyId}: ${clientList.length} clients (${realClients.length} real), $${mrr/100} MRR`);

    res.json({ clientCount: realClients.length, mrr, totalCalls, recentClients });
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/agency/:agencyId/clients', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: clients, error } = await supabase
      .from('clients')
      .select('*')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching agency clients:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`📋 Fetched ${(clients || []).length} clients for agency ${agencyId}`);
    res.json({ clients: clients || [] });
  } catch (error) {
    console.error('Error fetching agency clients:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/agency/:agencyId/clients/add', handleAgencyAddClient);

app.use('/api/agency', clientPromptRoutes);
app.use('/api/agency', clientKnowledgeBaseRoutes);

app.get('/api/agency/:agencyId/clients/:clientId', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client not found' });

    // Attach the primary client login (username = email, plus any agency-set
    // visible password) so the client page can show and manage credentials.
    // visible_password is only ever populated for passwords the agency set; it
    // is nulled the moment the client changes their own (see auth.js). If the
    // column does not exist yet, this degrades gracefully to email-only.
    try {
      const { data: loginUsers } = await supabase
        .from('users')
        .select('email, visible_password')
        .eq('client_id', clientId)
        .eq('role', 'client')
        .order('created_at', { ascending: true })
        .limit(1);
      const loginUser = (loginUsers && loginUsers[0]) || null;
      client.login_email = loginUser?.email || client.email || null;
      client.login_password = loginUser?.visible_password || null;
    } catch (e) {
      client.login_email = client.email || null;
      client.login_password = null;
    }

    res.json({ client });
  } catch (error) {
    console.error('Error fetching client:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/agency/:agencyId/clients/:clientId/calls', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data: calls, error } = await supabase
      .from('calls')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching calls:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ calls: calls || [] });
  } catch (error) {
    console.error('Error fetching client calls:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/agency/:agencyId/clients/:clientId/calls/:callId', async (req, res) => {
  try {
    const { agencyId, clientId, callId } = req.params;

    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data: call, error } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .eq('client_id', clientId)
      .single();

    if (error || !call) return res.status(404).json({ error: 'Call not found' });

    console.log(`📞 Call detail loaded: ${callId} for client ${clientId}`);
    res.json({ call });
  } catch (error) {
    console.error('Error fetching call detail:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/agency/:agencyId/clients/:clientId/industry', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const { industry } = req.body;
    if (!industry) return res.status(400).json({ error: 'industry required' });
    const { data: client } = await supabase.from('clients').select('id').eq('id', clientId).eq('agency_id', agencyId).single();
    if (!client) return res.status(404).json({ error: 'Client not found' });
    await supabase.from('clients').update({ industry, updated_at: new Date().toISOString() }).eq('id', clientId);
    console.log('✅ Industry updated for client ' + clientId + ': ' + industry);
    res.json({ success: true, industry });
  } catch (error) {
    console.error('Error updating industry:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GENERIC CLIENT FIELD UPDATE (business_name, owner_phone, etc.)
// Whitelisted fields only. Used by the client detail page inline-edit UI.
// ============================================================================
app.put('/api/agency/:agencyId/clients/:clientId', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    const ALLOWED_FIELDS = [
      'business_name',
      'owner_phone',
      'owner_name',
      'business_city',
      'business_state',
      'business_website',
    ];

    const updates = {};
    for (const key of ALLOWED_FIELDS) {
      if (req.body[key] !== undefined) {
        const v = req.body[key];
        updates[key] = typeof v === 'string' ? v.trim() : v;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // business_name cannot be cleared to empty string
    if (updates.business_name !== undefined && updates.business_name === '') {
      return res.status(400).json({ error: 'Business name cannot be empty' });
    }

    // Verify client belongs to this agency before updating
    const { data: existing, error: lookupErr } = await supabase
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (lookupErr || !existing) {
      return res.status(404).json({ error: 'Client not found' });
    }

    updates.updated_at = new Date().toISOString();

    const { data: client, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', clientId)
      .select()
      .single();

    if (error) {
      console.error('Error updating client:', error);
      return res.status(500).json({ error: 'Failed to update client' });
    }

    console.log(`✅ Client ${clientId} updated: ${Object.keys(updates).filter(k => k !== 'updated_at').join(', ')}`);
    res.json({ success: true, client });
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// RESET CLIENT LOGIN PASSWORD (agency-initiated)
// ----------------------------------------------------------------------------
// Sets a NEW password on the client's primary login user (role='client').
// Stores the bcrypt hash for login AND a plaintext visible_password so the
// agency can read it back on the client page. The visible copy is nulled the
// moment the client changes their own password (auth.js changePassword /
// setPassword). Mirrors the team-member reset-password pattern. Requires the
// users.visible_password column (see migration). Auto-generates a readable
// password unless the body supplies one (>= 6 chars).
// ============================================================================
app.post('/api/agency/:agencyId/clients/:clientId/reset-password', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    // Verify the client belongs to this agency
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select('id, email, business_name')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();
    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });

    // Find the primary client login user
    const { data: users } = await supabase
      .from('users')
      .select('id, email')
      .eq('client_id', clientId)
      .eq('role', 'client')
      .order('created_at', { ascending: true })
      .limit(1);
    const loginUser = (users && users[0]) || null;
    if (!loginUser) return res.status(404).json({ error: 'No login account found for this client' });

    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    function generatePassword() {
      // No ambiguous characters (0/O/1/l/I) so it's easy to read and dictate.
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      const bytes = crypto.randomBytes(14);
      let p = '';
      for (let i = 0; i < 14; i++) p += chars[bytes[i] % chars.length];
      return p;
    }
    const provided = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    const newPassword = provided.length >= 6 ? provided : generatePassword();

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    const { error: updErr } = await supabase
      .from('users')
      .update({ password_hash: passwordHash, visible_password: newPassword })
      .eq('id', loginUser.id);
    if (updErr) {
      console.error('❌ Client password reset error:', updErr);
      return res.status(500).json({ error: 'Failed to reset password' });
    }

    console.log(`✅ Client login password reset by agency for ${client.business_name} (${loginUser.email})`);
    res.json({ success: true, username: loginUser.email, password: newPassword });
  } catch (error) {
    console.error('Error resetting client password:', error);
    res.status(500).json({ error: 'Server error' });
  }
});



app.get('/api/agency/:agencyId/analytics', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: agency } = await supabase
      .from('agencies')
      .select('price_starter, price_pro, price_growth')
      .eq('id', agencyId)
      .single();

    const { data: clients, error: clientsError } = await supabase
      .from('clients')
      .select('id, business_name, plan_type, subscription_status, status, created_at, is_test_client')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });

    if (clientsError) {
      console.error('Error fetching clients for analytics:', clientsError);
      return res.status(400).json({ error: clientsError.message });
    }

    const clientList = clients || [];
    // Test clients don't count toward revenue or paying-client metrics
    const realClients = clientList.filter(c => !c.is_test_client);
    const activeClients = realClients.filter(c => c.subscription_status === 'active').length;
    const trialClients = realClients.filter(c => c.subscription_status === 'trial' || c.subscription_status === 'trialing').length;
    const totalClients = realClients.length;

    let mrr = 0;
    realClients.forEach(client => {
      if (client.subscription_status === 'active') {
        switch (client.plan_type) {
          case 'starter': mrr += agency?.price_starter || 4900; break;
          case 'pro': mrr += agency?.price_pro || 9900; break;
          case 'growth': mrr += agency?.price_growth || 14900; break;
        }
      }
    });

    // Only query payments for real (non-test) clients
    const clientIds = realClients.map(c => c.id);
    let payments = [];
    let totalEarned = 0;
    let pendingPayout = 0;

    if (clientIds.length > 0) {
      const { data: paymentsData, error: paymentsError } = await supabase
        .from('payments')
        .select('*')
        .in('client_id', clientIds)
        .order('created_at', { ascending: false })
        .limit(50);

      if (!paymentsError && paymentsData) {
        payments = paymentsData;
        payments.forEach(p => {
          if (p.status === 'succeeded') {
            totalEarned += p.amount || 0;
            if (!p.paid_out) pendingPayout += p.amount || 0;
          }
        });
      }
    }

    const revenueByMonth = [];
    const now = new Date();
    
    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthStr = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
      
      const monthRevenue = payments
        .filter(p => {
          if (p.status !== 'succeeded') return false;
          const paymentDate = new Date(p.created_at);
          return paymentDate.getFullYear() === monthDate.getFullYear() && paymentDate.getMonth() === monthDate.getMonth();
        })
        .reduce((sum, p) => sum + (p.amount || 0), 0);
      
      revenueByMonth.push({ month: monthStr, amount: monthRevenue });
    }

    console.log(`📊 Analytics loaded for agency ${agencyId}: ${activeClients} active, $${mrr/100} MRR`);

    res.json({
      stats: { mrr, totalEarned, pendingPayout, activeClients, trialClients, totalClients },
      revenueByMonth,
      payments,
      clients: clientList,
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// AGENCY USAGE SUMMARY (Phase 1, metered billing)
// ============================================================================

app.get('/api/agency/:agencyId/usage', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const summary = await getAgencyUsageSummary(agencyId);
    if (!summary) {
      return res.status(404).json({ error: 'Agency not found or no usage data' });
    }
    res.json({ success: true, usage: summary });
  } catch (error) {
    console.error('Error fetching usage:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// REFERRAL PROGRAM ROUTES
// ============================================================================

app.use('/api/agency', referralRoutes);

// ============================================================================
// DOMAIN MANAGEMENT ROUTES (Automated Vercel Provisioning)
// ============================================================================

let domainRoutesLoaded = false;
try {
  app.use('/api/agency', domainRoutes);
  app.use('/api/domain', domainRoutes);
  domainRoutesLoaded = true;
  console.log('✅ Domain routes loaded successfully');
} catch (err) {
  console.error('❌ Failed to load domain routes:', err.message);
}

app.get('/api/domain-test', (req, res) => {
  res.json({ 
    domainRoutesLoaded,
    timestamp: new Date().toISOString(),
    message: domainRoutesLoaded ? 'Domain routes are loaded' : 'Domain routes failed to load'
  });
});

// ============================================================================
// DEMO PHONE, TEMPLATES, AI PLAYGROUND, BYOT, FEEDBACK, SUPPORT, LEADS
// ============================================================================
setupProcessErrorHandlers();
app.use('/api/agency', demoPhoneRoutes);
app.use('/api/agency', testClientRoutes);
app.use('/api/agency', agencyTemplatesRoutes);
app.use('/api/agency', aiPlaygroundRoutes);
app.use('/api/agency', byotRoutes);
app.use('/api/agency', feedbackRoutes);
app.use('/api/agency', supportRoutes);
app.use('/api/help', helpRoutes);
app.use('/api/yt', ytContentRoutes);
app.use('/api/agency', leadRoutes);
app.use('/api/agency', activityRoutes);
app.use('/api/agency', outreachRoutes);
app.use('/api/leads', leadScraperRoutes);

// ============================================================================
// TEAM MEMBER ROUTES (Agency-level)
// GET/POST   /api/agency/:agencyId/team
// PUT/DELETE  /api/agency/:agencyId/team/:memberId
// POST       /api/agency/:agencyId/team/:memberId/reset-password
// ============================================================================
app.use('/api/agency', teamRoutes);
app.use('/api/agency', previewTokenRoutes);

// ============================================================================
// CLIENT ROUTES (Agencies → Clients)
// ============================================================================

// Phase 5: signupRateLimiter caps /api/client/signup at 5 requests per IP
// per hour. Embed widget makes this endpoint internet-exposed without auth,
// so a bare-minimum throttle is needed before CAPTCHA / fraud detection.
// Middleware is a no-op in non-production envs (NODE_ENV !== 'production').
app.post('/api/client/signup', signupRateLimiter, handleClientSignup);
app.post('/api/client/checkout', createClientCheckout);
app.post('/api/client/portal', createClientPortal);
// In-app plan switch for an active connected subscription. Swaps the sub item
// with proration and writes plan_type + monthly_call_limit together. Like
// checkout/portal it carries no route middleware because changeClientPlan does
// its own bearer-token ownership check (super_admin, the client itself, or the
// managing agency) inside the handler.
app.post('/api/client/change-plan', changeClientPlan);
app.use('/api/client', clientRoutes);
app.use('/api/client', require('./routes/call-mode'));
app.use('/api/client', clientContactsRoutes);
app.use('/api/client', staffMembersRoutes);
app.use('/api/client', clientServicesRoutes);
app.use('/api/client', toolConfigRoutes);
app.use('/api/client', pwaTrackingRoutes);
app.use('/api/sms', smsRoutes);

// ============================================================================
// TEAM MEMBER ROUTES (Client-level)
// GET/POST   /api/client/:clientId/team
// PUT/DELETE  /api/client/:clientId/team/:memberId
// POST       /api/client/:clientId/team/:memberId/reset-password
// ============================================================================
app.use('/api', teamRoutes);

app.get('/api/client/:clientId/details', async (req, res) => {
  try {
    const { clientId } = req.params;

    // Pulls in the agency-level plan rebranding columns (added Phase 3),
    // plan_features JSONB (powers buildClientPlans), and the theme/currency
    // fields that /client/upgrade-required and the client dashboard expect.
    // Without these, the upgrade-required page would fall back to hardcoded
    // names and USD even after agencies set custom plan_*_name values.
    const { data: client, error } = await supabase
      .from('clients')
      .select(`
        *,
        agencies!clients_agency_id_fkey (
          id, name, slug, logo_url, primary_color, secondary_color, accent_color,
          support_email, branding_overrides,
          price_starter, price_pro, price_growth,
          limit_starter, limit_pro, limit_growth,
          plan_starter_name, plan_pro_name, plan_growth_name,
          plan_starter_description, plan_pro_description, plan_growth_description,
          plan_features,
          website_theme, country, currency, display_currency,
          stripe_account_id, stripe_charges_enabled
        )
      `)
      .eq('id', clientId)
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (error) {
    console.error('Get client details error:', error);
    res.status(500).json({ error: 'Failed to get client details' });
  }
});

// ============================================================================
// VOICES ENDPOINT (Public)
// ============================================================================

app.get('/api/voices', (req, res) => {
  const { VOICE_OPTIONS } = require('./routes/client');
  const sortVoices = (voices) => voices.sort((a, b) => {
    if (a.recommended && !b.recommended) return -1;
    if (!a.recommended && b.recommended) return 1;
    return a.name.localeCompare(b.name);
  });
  const femaleVoices = sortVoices(VOICE_OPTIONS.filter(v => v.gender === 'female'));
  const maleVoices = sortVoices(VOICE_OPTIONS.filter(v => v.gender === 'male'));
  res.json({ success: true, total: VOICE_OPTIONS.length, grouped: { female: femaleVoices, male: maleVoices }, voices: VOICE_OPTIONS });
});

// ============================================================================
// VOICE PREVIEW, greeting spoken in the selected voice via ElevenLabs TTS.
// Inline because GET /api/voices is inline here and routes/voices.js is NOT
// mounted. POST /api/voices/preview  body { voice_id, text }  -> audio/mpeg
// Uses node-fetch (the same egress path proven in lib/vapi.js) plus a hard
// timeout, so a stalled ElevenLabs connection fails fast with a clean error
// instead of hanging until DigitalOcean's gateway kills it (502/504).
// ============================================================================
const _ttsFetch = require('node-fetch');
const _ttsCrypto = require('crypto');
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TTS_MODEL_ID = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';
const _ttsCache = new Map();   // voiceId+hash -> mp3 Buffer
const _ttsRate = new Map();    // ip -> [timestamps]
const _TTS_CACHE_MAX = 200, _TTS_RATE_MAX = 40, _TTS_RATE_WINDOW = 60 * 1000;

app.post('/api/voices/preview', async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) return res.status(503).json({ success: false, error: 'Voice preview not configured' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const now = Date.now();
    const recent = (_ttsRate.get(ip) || []).filter(t => now - t < _TTS_RATE_WINDOW);
    recent.push(now); _ttsRate.set(ip, recent);
    if (recent.length > _TTS_RATE_MAX) return res.status(429).json({ success: false, error: 'Too many previews' });

    const { voice_id, text } = req.body || {};
    if (!voice_id || typeof voice_id !== 'string') return res.status(400).json({ success: false, error: 'voice_id required' });
    const clean = String(text || '').trim().slice(0, 500);
    if (clean.length < 2) return res.status(400).json({ success: false, error: 'text required' });

    const cacheKey = `${voice_id}:${_ttsCrypto.createHash('sha1').update(clean).digest('hex')}`;
    const hit = _ttsCache.get(cacheKey);
    if (hit) { res.set('Content-Type', 'audio/mpeg'); res.set('Cache-Control', 'public, max-age=86400'); return res.send(hit); }

    // Hard timeout via AbortController so the request can never hang to the
    // gateway timeout, regardless of fetch implementation. Aborts at 8s.
    const _ttsController = new AbortController();
    const _ttsTimeout = setTimeout(() => _ttsController.abort(), 8000);
    let ttsRes;
    try {
      ttsRes = await _ttsFetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}?output_format=mp3_44100_128`,
        { method: 'POST',
          signal: _ttsController.signal,
          headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify({ text: clean, model_id: TTS_MODEL_ID, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }) }
      );
    } finally {
      clearTimeout(_ttsTimeout);
    }
    if (!ttsRes.ok) { const e = await ttsRes.text().catch(() => ''); console.error(`ElevenLabs TTS failed (HTTP ${ttsRes.status}): ${e.slice(0,200)}`); return res.status(502).json({ success: false, error: 'Voice synthesis failed' }); }

    const audio = Buffer.from(await ttsRes.arrayBuffer());
    _ttsCache.set(cacheKey, audio);
    if (_ttsCache.size > _TTS_CACHE_MAX) _ttsCache.delete(_ttsCache.keys().next().value);

    res.set('Content-Type', 'audio/mpeg'); res.set('Cache-Control', 'public, max-age=86400');
    return res.send(audio);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('Voice preview timed out reaching ElevenLabs (8s), outbound connect likely blocked');
      return res.status(504).json({ success: false, error: 'Voice synthesis timed out' });
    }
    console.error('Voice preview error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.post('/api/auth/agency/login', agencyLogin);
app.post('/api/auth/client/login', clientLogin);
app.post('/api/auth/verify', verifyToken);
app.post('/api/auth/set-password', setPassword);
app.post('/api/auth/change-password', changePassword);
app.use('/api/auth', passwordResetRoutes);
app.get('/api/auth/google', googleAuth);
app.get('/api/auth/google/callback', googleCallback);

// ============================================================================
// PLATFORM ADMIN ROUTES
// ============================================================================

app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminCallsRoutes);
app.use('/api/admin', adminAgencyDetail);
app.use('/api/admin', smsLogRoutes);
app.use('/api/admin', errorReportRoutes);
app.use('/api/admin', require('./routes/admin-expenses'));
app.use('/api/admin', require('./routes/admin-margin'));
// ============================================================================
// CRON ROUTES (Trial Expiration)
// ============================================================================

app.post('/api/cron/expire-trials', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await expireTrials();
    res.json({ success: true, message: 'Trial expiration check completed', ...result });
  } catch (error) {
    console.error('Cron error:', error);
    res.status(500).json({ error: 'Failed to run trial expiration' });
  }
});

// Reconcile client subscription_status against real Stripe status on the
// connected account. Self-heals rows a missed webhook left wrong: cancels +
// releases clients whose Stripe sub is actually dead (the dashboard-cancel case
// that left rows stuck 'active'), and corrects past_due rows that recovered.
// Pass ?dryRun=true to preview. Run daily as a backstop.
app.post('/api/cron/reconcile-subscriptions', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
    const result = await reconcileClientSubscriptions({ dryRun });
    res.json(result);
  } catch (error) {
    console.error('Reconcile cron error:', error);
    res.status(500).json({ error: 'Failed to run subscription reconciliation' });
  }
});

app.post('/api/cron/warn-agency-trials', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await warnExpiringAgencyTrials();
    res.json({ success: true, message: 'Agency trial warning check completed', ...result });
  } catch (error) {
    console.error('Cron error:', error);
    res.status(500).json({ error: 'Failed to run agency trial warnings' });
  }
});

app.use('/api/cron', abandonedCartRoutes);


// Agency onboarding engagement SMS (called by cron-job.org every hour)
app.use('/api/cron', agencyOnboardingSmsRoutes);
app.use('/api/cron', activationSmsRoutes);

app.use('/api/cron', cleanupOrphanedTestClients);

// Abandoned card-required checkout sweep: releases the number and deletes the
// VAPI assistant for pending_payment clients that never completed Stripe
// checkout. POST /api/cron/cleanup-abandoned-checkouts
app.use('/api/cron', abandonedCheckoutCleanupRoutes);

// Usage reporting cron (reports voice minutes to Stripe metered billing)
app.use('/api/cron', usageReporterRoutes);



// ============================================================================
// WEBHOOK ROUTES
// ============================================================================

// VAPI call webhooks (multi-tenant)
app.post('/webhook/vapi', handleVapiWebhook);

// SUPPORT LINE ADDITION: Voice support webhook (shared number, dynamic agency context + whisper)
app.post('/webhook/vapi-support', handleSupportWebhook);
app.post('/webhook/telnyx-sms', express.raw({ type: '*/*', limit: '2mb' }), handleTelnyxSMSWebhook);

// Telnyx Call Control (whisper warm transfer) for telnyx_cc clients.
//   /webhook/telnyx-voice       -> raw body (Ed25519 signature verification)
//   /api/voice/request-transfer -> normal JSON (VAPI function-tool target)
// The raw parser is scoped to the webhook path only, so the transfer endpoint
// still gets the JSON body parsed by the global middleware above.
app.use('/webhook/telnyx-voice', express.raw({ type: '*/*', limit: '5mb' }));
app.use('/', require('./routes/telnyx-voice'));

// Stripe platform webhooks (agency subscriptions)
app.post('/webhook/stripe', 
  express.raw({ type: 'application/json' }), 
  handlePlatformStripeWebhook
);

// Stripe Connect webhooks (client subscriptions)
app.post('/webhook/stripe-connect', 
  express.raw({ type: 'application/json' }), 
  handleConnectStripeWebhook
);
// ============================================================================
// BOOKING SYSTEM (Custom scheduling, replaces Calendly)
// ============================================================================
app.use('/api/booking', bookingRoutes);
// ============================================================================
// KNOWLEDGE BASE ROUTES
// ============================================================================

app.post('/api/knowledge-base/update', async (req, res) => {
  const { updateKnowledgeBase } = require('./routes/knowledge-base');
  return updateKnowledgeBase(req, res);
});

// ============================================================================
// GOOGLE CALENDAR INTEGRATION
// ============================================================================

app.use('/api/auth/google-calendar', googleCalendarAuthRoutes);
app.use('/api/calendar', calendarRoutes);

app.post('/api/assistant/update-calendar', async (req, res) => {
  try {
    const { assistantId, clientId, enabled } = req.body;
    
    if (!assistantId || !clientId) {
      return res.status(400).json({ error: 'Missing assistantId or clientId' });
    }

    const result = await updateAssistantCalendar(assistantId, clientId, enabled);
    
    if (result.success) {
      res.json({ success: true, message: `Calendar ${enabled ? 'enabled' : 'disabled'}` });
    } else {
      res.status(500).json({ error: result.error || 'Failed to update assistant' });
    }
  } catch (error) {
    console.error('Update calendar error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// START SERVER
// ============================================================================
app.use(expressErrorHandler);
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🎤 VOICEAI CONNECT BACKEND                                  ║
║   Multi-Tenant White-Label Voice AI Platform                  ║
║                                                               ║
║   Server running on port ${PORT}                                ║
║   Environment: ${process.env.NODE_ENV || 'development'}                              ║
║   Content Render: /api/content-render                         ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;