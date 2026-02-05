// ============================================================================
// VOICEAI CONNECT - MULTI-TENANT BACKEND SERVER
// ============================================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { supabase } = require('./lib/supabase');

const app = express();
const PORT = process.env.PORT || 8080;

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
  ];
  
  const origin = req.headers.origin;
  
  // Allow if static match or subdomain of myvoiceaiconnect.com
  if (allowedOrigins.includes(origin) || /^https:\/\/[^.]+\.myvoiceaiconnect\.com$/.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', origin); // Allow for now, actual request will be checked
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

// DYNAMIC CORS - Allows subdomains AND verified custom domains
// ============================================================================
const corsOptions = {
  origin: async function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    // Static allowed origins
    const staticAllowed = [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://myvoiceaiconnect.com',
      'https://www.myvoiceaiconnect.com',
    ];

    if (staticAllowed.includes(origin)) {
      return callback(null, true);
    }

    // Check if it's a subdomain of myvoiceaiconnect.com
    if (/^https:\/\/[^.]+\.myvoiceaiconnect\.com$/.test(origin)) {
      return callback(null, true);
    }

    // Check if it's a verified custom domain
    try {
      const originHost = new URL(origin).hostname.replace('www.', '');
      const { data } = await supabase
        .from('agencies')
        .select('id')
        .eq('marketing_domain', originHost)
        .eq('domain_verified', true)
        .single();

      if (data) {
        return callback(null, true);
      }
    } catch (err) {
      console.error('CORS domain check error:', err.message);
    }

    // Reject unknown origins
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
};

app.use(cors(corsOptions));

// Parse JSON for most routes
app.use((req, res, next) => {
  // Skip JSON parsing for Stripe webhooks (needs raw body)
  if (req.originalUrl === '/webhook/stripe' || req.originalUrl === '/webhook/stripe-connect') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

// ============================================================================
// IMPORT HANDLERS
// ============================================================================

// Agency Management
const { handleAgencySignup, handleAgencyOnboarding } = require('./routes/agency-signup');
const { getAgencyByHost, getAgencySettings, updateAgencySettings, verifyAgencyDomain } = require('./routes/agency-settings');

// Referral Program
const referralRoutes = require('./routes/referrals');

// Domain Management (Automated Vercel Provisioning)
let domainRoutes;
try {
  domainRoutes = require('./routes/domains');
  console.log('✅ Domain routes module loaded');
} catch (err) {
  console.error('❌ Failed to require domain routes:', err.message);
  // Create a dummy router that returns 500
  const express = require('express');
  domainRoutes = express.Router();
  domainRoutes.all('*', (req, res) => {
    res.status(500).json({ error: 'Domain routes failed to load', details: err.message });
  });
}

// Client Provisioning (adapted from CallBird)
const { handleClientSignup, provisionClient, handleAgencyAddClient } = require('./routes/client-signup');

// Client Dashboard Routes
const clientRoutes = require('./routes/client');

// Leads & Outreach Routes
const leadRoutes = require('./routes/leads');
const activityRoutes = require('./routes/activity');
const outreachRoutes = require('./routes/outreach');

// Agency Templates Routes (Enterprise Feature - Custom AI Prompts)
const agencyTemplatesRoutes = require('./routes/agency-templates');

// VAPI Webhook (multi-tenant aware)
const { handleVapiWebhook } = require('./webhooks/vapi-webhook');

// Stripe Platform Billing (agencies pay platform)
const { 
  createAgencyCheckout, 
  createAgencyPortal,
  handlePlatformStripeWebhook 
} = require('./routes/stripe-platform');

// Stripe Connect (clients pay agencies)
const {
  createConnectAccountLink,
  getConnectStatus,
  disconnectConnectAccount,
  createClientCheckout,
  createClientPortal,
  handleConnectStripeWebhook,
  expireTrials
} = require('./routes/stripe-connect');

// Auth
const { 
  agencyLogin, 
  clientLogin, 
  verifyToken,
  setPassword,
  changePassword,
  requestPasswordReset
} = require('./routes/auth');

// Google OAuth
const { googleAuth, googleCallback } = require('./routes/google-auth');

// Platform Admin Routes
const adminRoutes = require('./routes/admin');

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
      aiTemplates: true
    }
  });
});

// ============================================================================
// AGENCY ROUTES (Platform → Agencies)
// ============================================================================

// Agency signup flow
app.post('/api/agency/signup', handleAgencySignup);
app.post('/api/agency/onboarding', handleAgencyOnboarding);

// Agency settings
app.get('/api/agency/by-host', getAgencyByHost);
app.get('/api/agency/:agencyId/settings', getAgencySettings);
app.put('/api/agency/:agencyId/settings', updateAgencySettings);

// Legacy domain verify endpoint (keeping for backwards compatibility)
app.post('/api/agency/:agencyId/domain/verify', verifyAgencyDomain);

// Agency billing (pays platform)
app.post('/api/agency/checkout', createAgencyCheckout);
app.post('/api/agency/portal', createAgencyPortal);

// Agency cancel subscription (during trial)
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

    // Cancel Stripe subscription if exists
    if (agency.stripe_subscription_id) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      try {
        await stripe.subscriptions.cancel(agency.stripe_subscription_id);
        console.log('✅ Stripe subscription canceled');
      } catch (stripeErr) {
        console.error('Stripe cancel error (continuing):', stripeErr.message);
      }
    }

    // Update agency status
    await supabase
      .from('agencies')
      .update({ 
        subscription_status: 'canceled', 
        status: 'canceled',
        updated_at: new Date().toISOString()
      })
      .eq('id', agency_id);

    // Suspend all agency's clients
    const { data: clients } = await supabase
      .from('clients')
      .select('id')
      .eq('agency_id', agency_id);

    if (clients && clients.length > 0) {
      await supabase
        .from('clients')
        .update({ 
          status: 'suspended', 
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

// Stripe Connect onboarding
app.post('/api/agency/connect/onboard', createConnectAccountLink);

// Stripe Connect status
app.get('/api/agency/connect/status/:agencyId', getConnectStatus);

// Stripe Connect disconnect
app.post('/api/agency/:agencyId/connect/disconnect', disconnectConnectAccount);

// ============================================================================
// AGENCY DASHBOARD & CLIENTS ROUTES (for agency dashboard frontend)
// ============================================================================

// GET /api/agency/:agencyId/dashboard - Dashboard stats
app.get('/api/agency/:agencyId/dashboard', async (req, res) => {
  try {
    const { agencyId } = req.params;

    // Get all clients for this agency
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

    // Calculate MRR from active clients
    const { data: agency } = await supabase
      .from('agencies')
      .select('price_starter, price_pro, price_growth')
      .eq('id', agencyId)
      .single();

    let mrr = 0;
    clientList.forEach(client => {
      if (client.subscription_status === 'active') {
        switch (client.plan_type) {
          case 'starter':
            mrr += agency?.price_starter || 4900;
            break;
          case 'pro':
            mrr += agency?.price_pro || 9900;
            break;
          case 'growth':
            mrr += agency?.price_growth || 14900;
            break;
        }
      }
    });

    // Calculate total calls this month
    const totalCalls = clientList.reduce((sum, c) => sum + (c.calls_this_month || 0), 0);

    // Recent clients (last 5)
    const recentClients = clientList.slice(0, 5);

    console.log(`📊 Dashboard loaded for agency ${agencyId}: ${clientList.length} clients, $${mrr/100} MRR`);

    res.json({
      clientCount: clientList.length,
      mrr,
      totalCalls,
      recentClients,
    });
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/agency/:agencyId/clients - List all clients for agency
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

// POST /api/agency/:agencyId/clients/add - Agency adds a new client
app.post('/api/agency/:agencyId/clients/add', handleAgencyAddClient);

// GET /api/agency/:agencyId/clients/:clientId - Get single client
app.get('/api/agency/:agencyId/clients/:clientId', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ client });
  } catch (error) {
    console.error('Error fetching client:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/agency/:agencyId/clients/:clientId/calls - Get client calls
app.get('/api/agency/:agencyId/clients/:clientId/calls', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    // Verify client belongs to agency
    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

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

// GET /api/agency/:agencyId/clients/:clientId/calls/:callId - Get single call detail
app.get('/api/agency/:agencyId/clients/:clientId/calls/:callId', async (req, res) => {
  try {
    const { agencyId, clientId, callId } = req.params;

    // Verify client belongs to agency
    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Fetch the call, scoped to this client
    const { data: call, error } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .eq('client_id', clientId)
      .single();

    if (error || !call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    console.log(`📞 Call detail loaded: ${callId} for client ${clientId}`);
    res.json({ call });
  } catch (error) {
    console.error('Error fetching call detail:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/agency/:agencyId/analytics - Analytics & Revenue data
app.get('/api/agency/:agencyId/analytics', async (req, res) => {
  try {
    const { agencyId } = req.params;

    // Get agency pricing
    const { data: agency } = await supabase
      .from('agencies')
      .select('price_starter, price_pro, price_growth')
      .eq('id', agencyId)
      .single();

    // Get all clients for this agency
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

    // Calculate client counts
    const activeClients = clientList.filter(c => c.subscription_status === 'active').length;
    const trialClients = clientList.filter(c => 
      c.subscription_status === 'trial' || c.subscription_status === 'trialing'
    ).length;
    const totalClients = clientList.length;

    // Calculate MRR from active clients
    let mrr = 0;
    clientList.forEach(client => {
      if (client.subscription_status === 'active') {
        switch (client.plan_type) {
          case 'starter':
            mrr += agency?.price_starter || 4900;
            break;
          case 'pro':
            mrr += agency?.price_pro || 9900;
            break;
          case 'growth':
            mrr += agency?.price_growth || 14900;
            break;
        }
      }
    });

    // Get payments for this agency's clients
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
        
        // Calculate totals
        payments.forEach(p => {
          if (p.status === 'succeeded') {
            totalEarned += p.amount || 0;
            if (!p.paid_out) {
              pendingPayout += p.amount || 0;
            }
          }
        });
      }
    }

    // Calculate revenue by month (last 6 months)
    const revenueByMonth = [];
    const now = new Date();
    
    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthStr = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
      
      const monthRevenue = payments
        .filter(p => {
          if (p.status !== 'succeeded') return false;
          const paymentDate = new Date(p.created_at);
          return paymentDate.getFullYear() === monthDate.getFullYear() &&
                 paymentDate.getMonth() === monthDate.getMonth();
        })
        .reduce((sum, p) => sum + (p.amount || 0), 0);
      
      revenueByMonth.push({ month: monthStr, amount: monthRevenue });
    }

    console.log(`📊 Analytics loaded for agency ${agencyId}: ${activeClients} active, $${mrr/100} MRR`);

    res.json({
      stats: {
        mrr,
        totalEarned,
        pendingPayout,
        activeClients,
        trialClients,
        totalClients,
      },
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
// REFERRAL PROGRAM ROUTES
// ============================================================================

app.use('/api/agency', referralRoutes);

// ============================================================================
// DOMAIN MANAGEMENT ROUTES (Automated Vercel Provisioning)
// ============================================================================

let domainRoutesLoaded = false;
try {
  // Domain routes for agencies: POST/DELETE /:agencyId/domain, GET /:agencyId/domain/status
  app.use('/api/agency', domainRoutes);
  
  // Public DNS config endpoint: GET /api/domain/dns-config
  app.use('/api/domain', domainRoutes);
  
  domainRoutesLoaded = true;
  console.log('✅ Domain routes loaded successfully');
} catch (err) {
  console.error('❌ Failed to load domain routes:', err.message);
}

// Test endpoint to verify domain routes are working
app.get('/api/domain-test', (req, res) => {
  res.json({ 
    domainRoutesLoaded,
    timestamp: new Date().toISOString(),
    message: domainRoutesLoaded ? 'Domain routes are loaded' : 'Domain routes failed to load'
  });
});

// ============================================================================
// AGENCY TEMPLATES ROUTES (Enterprise Feature - Custom AI Prompts)
// IMPORTANT: Must be BEFORE outreach routes to avoid /templates conflict
// ============================================================================

app.use('/api/agency', agencyTemplatesRoutes);

// ============================================================================
// LEADS & OUTREACH ROUTES (Agency CRM)
// ============================================================================

app.use('/api/agency', leadRoutes);
app.use('/api/agency', activityRoutes);
app.use('/api/agency', outreachRoutes);

// ============================================================================
// CLIENT ROUTES (Agencies → Clients)
// ============================================================================

// Client signup (via agency's marketing site)
app.post('/api/client/signup', handleClientSignup);

// Client dashboard routes (settings, voice, greeting, knowledge base)
app.use('/api/client', clientRoutes);

// Client billing (pays agency via Connect)
app.post('/api/client/checkout', createClientCheckout);
app.post('/api/client/portal', createClientPortal);

// Client details with agency info (for upgrade page pricing)
app.get('/api/client/:clientId/details', async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select(`
        *,
        agencies (
          id,
          name,
          slug,
          logo_url,
          primary_color,
          secondary_color,
          accent_color,
          support_email,
          price_starter,
          price_pro,
          price_growth,
          limit_starter,
          limit_pro,
          limit_growth,
          stripe_account_id,
          stripe_charges_enabled
        )
      `)
      .eq('id', clientId)
      .single();

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json(client);

  } catch (error) {
    console.error('Get client details error:', error);
    res.status(500).json({ error: 'Failed to get client details' });
  }
});

// ============================================================================
// VOICES ENDPOINT (Public) - UPDATED with complete metadata & correct format
// ============================================================================

app.get('/api/voices', (req, res) => {
  const VOICE_OPTIONS = [
    // Female voices
    { 
      id: '21m00Tcm4TlvDq8ikWAM', 
      name: 'Rachel', 
      gender: 'female', 
      accent: 'American',
      style: 'Calm',
      description: 'Warm and professional. Perfect all-purpose receptionist voice.',
      previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/21m00Tcm4TlvDq8ikWAM/df6788f9-5c96-470d-8312-aab3b3d8f50a.mp3',
      recommended: true
    },
    { 
      id: 'EXAVITQu4vr4xnSDxMaL', 
      name: 'Sarah', 
      gender: 'female', 
      accent: 'American',
      style: 'Soft',
      description: 'Gentle and reassuring. Great for medical and professional services.',
      previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/6851ec91-9950-471f-8586-357c52539069.mp3',
      recommended: true
    },
    { 
      id: 'pMsXgVXv3BLzUgSXRplE', 
      name: 'Serena', 
      gender: 'female', 
      accent: 'American',
      style: 'Pleasant',
      description: 'Engaging and interactive. Built for back-and-forth conversations.',
      previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pMsXgVXv3BLzUgSXRplE/d61f18ed-e5b0-4d0b-a33c-5c6e7e33b053.mp3',
      recommended: true
    },
    { 
      id: 'XrExE9yKIg1WjnnlVkGX', 
      name: 'Matilda', 
      gender: 'female', 
      accent: 'American',
      style: 'Warm',
      description: 'Friendly and approachable. Perfect for retail and hospitality.',
      previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3',
      recommended: false
    },
    
    // Male voices
    { 
      id: 'iP95p4xoKVk53GoZ742B', 
      name: 'Chris', 
      gender: 'male', 
      accent: 'American',
      style: 'Casual',
      description: 'Natural and easygoing. Officially tagged for conversational AI.',
      previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/iP95p4xoKVk53GoZ742B/c1bda571-7123-418e-a796-a2b464b373b4.mp3',
      recommended: true
    },
    { 
      id: 'nPczCjzI2devNBz1zQrb', 
      name: 'Brian', 
      gender: 'male', 
      accent: 'American',
      style: 'Deep',
      description: 'Deep and trustworthy. Great for professional and corporate.',
      previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/nPczCjzI2devNBz1zQrb/f4dbda0c-aff0-45c0-93fa-f5d5ec95a2eb.mp3',
      recommended: true
    },
    { 
      id: 'TxGEqnHWrfWFTfGW9XjX', 
      name: 'Josh', 
      gender: 'male', 
      accent: 'American',
      style: 'Deep',
      description: 'Younger professional voice. Great for tech and modern businesses.',
      previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/TxGEqnHWrfWFTfGW9XjX/3ae2fc71-d5f9-4769-bb71-2a43633cd186.mp3',
      recommended: false
    },
    { 
      id: 'TX3LPaxmHKxFdv7VOQHJ', 
      name: 'Liam', 
      gender: 'male', 
      accent: 'American',
      style: 'Young',
      description: 'Energetic younger voice. Perfect for trendy businesses.',
      previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3',
      recommended: false
    },
  ];

  // Sort: recommended first, then alphabetically
  const sortVoices = (voices) => {
    return voices.sort((a, b) => {
      if (a.recommended && !b.recommended) return -1;
      if (!a.recommended && b.recommended) return 1;
      return a.name.localeCompare(b.name);
    });
  };

  // Group by gender
  const femaleVoices = sortVoices(VOICE_OPTIONS.filter(v => v.gender === 'female'));
  const maleVoices = sortVoices(VOICE_OPTIONS.filter(v => v.gender === 'male'));

  // Return in format frontend expects
  res.json({
    success: true,
    total: VOICE_OPTIONS.length,
    grouped: {
      female: femaleVoices,
      male: maleVoices
    },
    voices: VOICE_OPTIONS
  });
});

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.post('/api/auth/agency/login', agencyLogin);
app.post('/api/auth/client/login', clientLogin);
app.post('/api/auth/verify', verifyToken);
app.post('/api/auth/set-password', setPassword);
app.post('/api/auth/change-password', changePassword);
app.post('/api/auth/reset-password', requestPasswordReset);

// Google OAuth
app.get('/api/auth/google', googleAuth);
app.get('/api/auth/google/callback', googleCallback);

// ============================================================================
// PLATFORM ADMIN ROUTES
// ============================================================================

app.use('/api/admin', adminRoutes);

// ============================================================================
// CRON ROUTES (Trial Expiration)
// ============================================================================

// Manual trigger for trial expiration (can be called by cron service)
// POST /api/cron/expire-trials
app.post('/api/cron/expire-trials', async (req, res) => {
  // Verify cron secret (optional security)
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

// ============================================================================
// WEBHOOK ROUTES
// ============================================================================

// VAPI call webhooks (multi-tenant)
app.post('/webhook/vapi', handleVapiWebhook);

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
// KNOWLEDGE BASE ROUTES
// ============================================================================

app.post('/api/knowledge-base/update', async (req, res) => {
  const { updateKnowledgeBase } = require('./routes/knowledge-base');
  return updateKnowledgeBase(req, res);
});

// ============================================================================
// CALENDAR ROUTES (for VAPI tool calls)
// ============================================================================

app.post('/api/calendar/availability/:clientId', async (req, res) => {
  // Handle calendar availability check from VAPI
  res.json({ available_times: ['9:00 AM', '10:00 AM', '2:00 PM', '3:00 PM'] });
});

app.post('/api/calendar/book/:clientId', async (req, res) => {
  // Handle booking from VAPI
  res.json({ success: true, message: 'Appointment booked' });
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

// 404 handler
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
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;