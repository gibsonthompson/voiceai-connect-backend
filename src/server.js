// ============================================================================
// VOICEAI CONNECT - MULTI-TENANT BACKEND SERVER
// UPDATED: Team member routes mounted, Content render service mounted
// UPDATED: 2026-05-07 — Usage tracking cron + usage summary endpoint (Phase 1)
// Destination: src/server.js (or src/index.js) — FULL REPLACEMENT
// ============================================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { supabase } = require('./lib/supabase');

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
  if (req.originalUrl === '/webhook/stripe' || req.originalUrl === '/webhook/stripe-connect') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

// ============================================================================
// IMPORT HANDLERS
// ============================================================================

const { handleAgencySignup, handleAgencyOnboarding } = require('./routes/agency-signup');
const { getAgencyByHost, getAgencySettings, updateAgencySettings, verifyAgencyDomain } = require('./routes/agency-settings');
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

const { handleClientSignup, provisionClient, handleAgencyAddClient } = require('./routes/client-signup');
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
const agencyOnboardingSmsRoutes = require('./routes/agency-onboarding-sms');
const activationSmsRoutes = require('./routes/activation-sms');
const feedbackRoutes = require('./routes/feedback');
const supportRoutes = require('./routes/support');
const teamRoutes = require('./routes/team');
const contentRender = require('./content-render');  // Content render service

// Usage tracking (Phase 1 — metered billing)
const usageReporterRoutes = require('./cron/usage-reporter');
const { getAgencyUsageSummary } = require('./lib/usage-tracker');
const testClientRoutes = require('./routes/test-client');
const bookingRoutes = require('./routes/booking');
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
  disconnectConnectAccount,
  createClientCheckout,
  createClientPortal,
  handleConnectStripeWebhook,
  expireTrials
} = require('./routes/stripe-connect');

const { 
  agencyLogin, 
  clientLogin, 
  verifyToken,
  setPassword,
  changePassword,
  authMiddleware,
  generateToken
} = require('./routes/auth');

const passwordResetRoutes = require('./routes/password-reset');
const { googleAuth, googleCallback } = require('./routes/google-auth');
const calendarRoutes = require('./routes/calendar');
const googleCalendarAuthRoutes = require('./routes/google-calendar-auth');
const { updateAssistantCalendar } = require('./lib/calendar-tools');
const adminRoutes = require('./routes/admin');
const adminAgencyDetail = require('./routes/admin-agency-detail');
const smsLogRoutes = require('./routes/sms-log');
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

// ============================================================================
// AGENCY ROUTES (Platform → Agencies)
// ============================================================================

app.post('/api/agency/signup', handleAgencySignup);
app.post('/api/agency/onboarding', handleAgencyOnboarding);
app.get('/api/agency/by-host', getAgencyByHost);
app.get('/api/agency/:agencyId/settings', getAgencySettings);
app.put('/api/agency/:agencyId/settings', updateAgencySettings);
app.post('/api/agency/:agencyId/domain/verify', verifyAgencyDomain);
app.post('/api/agency/checkout', createAgencyCheckout);
app.post('/api/agency/portal', createAgencyPortal);

app.post('/api/agency/cancel', async (req, res) => {
  const { agency_id } = req.body;
  
  if (!agency_id) {
    return res.status(400).json({ error: 'agency_id required' });
  }

  try {
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, name, stripe_subscription_id')
      .eq('id', agency_id)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    console.log('🛑 Canceling subscription for:', agency.name);

    if (agency.stripe_subscription_id) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      try {
        await stripe.subscriptions.cancel(agency.stripe_subscription_id);
        console.log('✅ Stripe subscription canceled');
      } catch (stripeErr) {
        console.error('Stripe cancel error (continuing):', stripeErr.message);
      }
    }

    await supabase
      .from('agencies')
      .update({ 
        subscription_status: 'canceled', 
        status: 'canceled',
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

    console.log('✅ Agency subscription canceled:', agency.name);
    res.json({ success: true, message: 'Subscription canceled' });

  } catch (err) {
    console.error('❌ Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

app.post('/api/agency/connect/onboard', createConnectAccountLink);
app.get('/api/agency/connect/status/:agencyId', getConnectStatus);
app.post('/api/agency/:agencyId/connect/disconnect', disconnectConnectAccount);

// ============================================================================
// AGENCY DASHBOARD & CLIENTS ROUTES
// ============================================================================

app.get('/api/agency/:agencyId/dashboard', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, business_name, plan_type, subscription_status, status, calls_this_month, created_at')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching agency clients:', error);
      return res.status(400).json({ error: error.message });
    }

    const clientList = clients || [];

    const { data: agency } = await supabase
      .from('agencies')
      .select('price_starter, price_pro, price_growth')
      .eq('id', agencyId)
      .single();

    let mrr = 0;
    clientList.forEach(client => {
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

    console.log(`📊 Dashboard loaded for agency ${agencyId}: ${clientList.length} clients, $${mrr/100} MRR`);

    res.json({ clientCount: clientList.length, mrr, totalCalls, recentClients });
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
      .select('id, business_name, plan_type, subscription_status, status, created_at')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });

    if (clientsError) {
      console.error('Error fetching clients for analytics:', clientsError);
      return res.status(400).json({ error: clientsError.message });
    }

    const clientList = clients || [];
    const activeClients = clientList.filter(c => c.subscription_status === 'active').length;
    const trialClients = clientList.filter(c => c.subscription_status === 'trial' || c.subscription_status === 'trialing').length;
    const totalClients = clientList.length;

    let mrr = 0;
    clientList.forEach(client => {
      if (client.subscription_status === 'active') {
        switch (client.plan_type) {
          case 'starter': mrr += agency?.price_starter || 4900; break;
          case 'pro': mrr += agency?.price_pro || 9900; break;
          case 'growth': mrr += agency?.price_growth || 14900; break;
        }
      }
    });

    const clientIds = clientList.map(c => c.id);
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
// AGENCY USAGE SUMMARY (Phase 1 — metered billing)
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

app.use('/api/agency', demoPhoneRoutes);
app.use('/api/agency', testClientRoutes);
app.use('/api/agency', agencyTemplatesRoutes);
app.use('/api/agency', aiPlaygroundRoutes);
app.use('/api/agency', byotRoutes);
app.use('/api/agency', feedbackRoutes);
app.use('/api/agency', supportRoutes);
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

// ============================================================================
// CLIENT ROUTES (Agencies → Clients)
// ============================================================================

app.post('/api/client/signup', handleClientSignup);
app.use('/api/client', clientRoutes);
app.use('/api/client', require('./routes/call-mode'));
app.use('/api/client', clientContactsRoutes);
app.use('/api/client', toolConfigRoutes);
app.use('/api/client', pwaTrackingRoutes);
app.post('/api/client/checkout', createClientCheckout);
app.post('/api/client/portal', createClientPortal);

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

    const { data: client, error } = await supabase
      .from('clients')
      .select(`
        *,
        agencies (
          id, name, slug, logo_url, primary_color, secondary_color, accent_color,
          support_email, branding_overrides,
          price_starter, price_pro, price_growth,
          limit_starter, limit_pro, limit_growth,
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
app.use('/api/admin', adminAgencyDetail);
app.use('/api/admin', smsLogRoutes);

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

// Usage reporting cron (reports voice minutes to Stripe metered billing)
app.use('/api/cron', usageReporterRoutes);



// ============================================================================
// WEBHOOK ROUTES
// ============================================================================

// VAPI call webhooks (multi-tenant)
app.post('/webhook/vapi', handleVapiWebhook);

// SUPPORT LINE ADDITION: Voice support webhook (shared number, dynamic agency context + whisper)
app.post('/webhook/vapi-support', handleSupportWebhook);

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
// BOOKING SYSTEM (Custom scheduling — replaces Calendly)
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