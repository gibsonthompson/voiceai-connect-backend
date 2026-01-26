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
// Client Provisioning (adapted from CallBird)
const { handleClientSignup, provisionClient } = require('./routes/client-signup');

// Client Dashboard Routes
const clientRoutes = require('./routes/client');

// Leads & Outreach Routes
const leadRoutes = require('./routes/leads');
const activityRoutes = require('./routes/activity');
const outreachRoutes = require('./routes/outreach');

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
  createClientCheckout,
  createClientPortal,
  handleConnectStripeWebhook
} = require('./routes/stripe-connect');

// Auth
const { 
  agencyLogin, 
  clientLogin, 
  verifyToken,
  setPassword,
  requestPasswordReset
} = require('./routes/auth');

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
      vapiIntegration: true
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
app.post('/api/agency/:agencyId/domain/verify', verifyAgencyDomain);
// Agency billing (pays platform)
app.post('/api/agency/checkout', createAgencyCheckout);
app.post('/api/agency/portal', createAgencyPortal);

// Stripe Connect onboarding
app.post('/api/agency/connect/onboard', createConnectAccountLink);
app.get('/api/agency/connect/status/:agencyId', async (req, res) => {
  // Check Connect account status
  const { getConnectStatus } = require('./routes/stripe-connect');
  return getConnectStatus(req, res);
});

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

// ============================================================================
// VOICES ENDPOINT (Public)
// ============================================================================

app.get('/api/voices', (req, res) => {
  const VOICE_OPTIONS = [
    // Female voices
    { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', gender: 'female', description: 'Warm and friendly' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', gender: 'female', description: 'Soft and professional' },
    { id: 'pMsXgVXv3BLzUgSXRplE', name: 'Serena', gender: 'female', description: 'Calm and reassuring' },
    { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', gender: 'female', description: 'Bright and energetic' },
    { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', gender: 'female', description: 'Young and cheerful' },
    { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', gender: 'female', description: 'Clear and articulate' },
    { id: 'LcfcDJNUP1GQjkzn1xUU', name: 'Emily', gender: 'female', description: 'Warm and welcoming' },
    // Male voices
    { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', gender: 'male', description: 'Friendly and casual' },
    { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', gender: 'male', description: 'Professional and confident' },
    { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', gender: 'male', description: 'Authoritative and clear' },
    { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', gender: 'male', description: 'Deep and trustworthy' },
    { id: '29vD33N1CtxCmqQRPOHJ', name: 'Drew', gender: 'male', description: 'Warm and approachable' },
    { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', gender: 'male', description: 'Calm and measured' },
    { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh', gender: 'male', description: 'Energetic and upbeat' },
    { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', gender: 'male', description: 'Mature and refined' },
    { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', gender: 'male', description: 'Young and dynamic' },
  ];
  res.json(VOICE_OPTIONS);
});

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.post('/api/auth/agency/login', agencyLogin);
app.post('/api/auth/client/login', clientLogin);
app.post('/api/auth/verify', verifyToken);
app.post('/api/auth/set-password', setPassword);
app.post('/api/auth/reset-password', requestPasswordReset);

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