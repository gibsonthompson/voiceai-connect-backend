// ============================================================================
// PLATFORM ADMIN ROUTES
// Only accessible by whitelisted platform owners
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const jwt = require('jsonwebtoken');

// ============================================================================
// ADMIN WHITELIST - Add your email(s) here
// ============================================================================
const ADMIN_EMAILS = [
  'gibsonthompson1@gmail.com',
  // Add more admin emails as needed
];

// ============================================================================
// ADMIN AUTH MIDDLEWARE
// ============================================================================
function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if email is in admin whitelist
    if (!decoded.email || !ADMIN_EMAILS.includes(decoded.email.toLowerCase())) {
      return res.status(403).json({ error: 'Not authorized as platform admin' });
    }

    req.admin = decoded;
    next();
  } catch (error) {
    console.error('Admin auth error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============================================================================
// ADMIN LOGIN
// ============================================================================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const normalizedEmail = email.toLowerCase();

    // Check if email is in admin whitelist
    if (!ADMIN_EMAILS.includes(normalizedEmail)) {
      return res.status(403).json({ error: 'Not authorized as platform admin' });
    }

    // Find agency with this email to verify password
    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, name, email, password_hash')
      .eq('email', normalizedEmail)
      .single();

    if (error || !agency) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const bcrypt = require('bcryptjs');
    const validPassword = await bcrypt.compare(password, agency.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate admin JWT
    const token = jwt.sign(
      { 
        id: agency.id,
        email: normalizedEmail,
        name: agency.name,
        role: 'platform_admin'
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('🔐 Platform admin logged in:', normalizedEmail);

    res.json({
      success: true,
      token,
      admin: {
        id: agency.id,
        email: normalizedEmail,
        name: agency.name,
        role: 'platform_admin'
      }
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================================================
// VERIFY ADMIN TOKEN
// ============================================================================
router.get('/verify', requireAdmin, (req, res) => {
  res.json({ valid: true, admin: req.admin });
});

// ============================================================================
// DASHBOARD OVERVIEW STATS
// ============================================================================
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    // Get all agencies
    const { data: agencies, error: agencyError } = await supabase
      .from('agencies')
      .select('id, name, email, plan_type, subscription_status, status, created_at, trial_ends_at');

    if (agencyError) throw agencyError;

    // Get all clients
    const { data: clients, error: clientError } = await supabase
      .from('clients')
      .select('id, agency_id, subscription_status, plan_type, calls_this_month, created_at');

    if (clientError) throw clientError;

    // Get total calls this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count: callsThisMonth } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startOfMonth.toISOString());

    // Calculate stats
    const totalAgencies = agencies?.length || 0;
    const activeAgencies = agencies?.filter(a => 
      a.subscription_status === 'active' || a.subscription_status === 'trialing'
    ).length || 0;
    const trialAgencies = agencies?.filter(a => 
      a.subscription_status === 'trialing' || a.status === 'trial'
    ).length || 0;

    const totalClients = clients?.length || 0;
    const activeClients = clients?.filter(c => 
      c.subscription_status === 'active' || c.subscription_status === 'trial'
    ).length || 0;

    // Calculate platform MRR (what agencies pay us)
    const PLATFORM_PRICES = {
      starter: 9900,      // $99
      professional: 19900, // $199
      enterprise: 49900    // $499
    };

    let platformMRR = 0;
    agencies?.forEach(agency => {
      if (agency.subscription_status === 'active') {
        const plan = agency.plan_type || 'starter';
        platformMRR += PLATFORM_PRICES[plan] || PLATFORM_PRICES.starter;
      }
    });

    // Recent signups (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const recentAgencies = agencies?.filter(a => 
      new Date(a.created_at) > weekAgo
    ).length || 0;

    const recentClients = clients?.filter(c => 
      new Date(c.created_at) > weekAgo
    ).length || 0;

    console.log(`📊 Admin dashboard: ${totalAgencies} agencies, ${totalClients} clients, $${platformMRR/100} MRR`);

    res.json({
      stats: {
        totalAgencies,
        activeAgencies,
        trialAgencies,
        totalClients,
        activeClients,
        platformMRR,
        callsThisMonth: callsThisMonth || 0,
        recentAgencies,
        recentClients,
      },
      // Recent 5 agencies for quick view
      recentAgencyList: agencies
        ?.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 5) || [],
    });

  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ============================================================================
// LIST ALL AGENCIES
// ============================================================================
router.get('/agencies', requireAdmin, async (req, res) => {
  try {
    const { status, plan, search, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('agencies')
      .select(`
        id, name, email, slug, phone,
        plan_type, subscription_status, status,
        stripe_account_id, stripe_charges_enabled,
        created_at, trial_ends_at, updated_at
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (status) {
      query = query.eq('subscription_status', status);
    }
    if (plan) {
      query = query.eq('plan_type', plan);
    }
    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,slug.ilike.%${search}%`);
    }

    const { data: agencies, error, count } = await query;

    if (error) throw error;

    // Get client counts for each agency
    const agencyIds = agencies?.map(a => a.id) || [];
    
    let clientCounts = {};
    if (agencyIds.length > 0) {
      const { data: clients } = await supabase
        .from('clients')
        .select('agency_id')
        .in('agency_id', agencyIds);

      clients?.forEach(c => {
        clientCounts[c.agency_id] = (clientCounts[c.agency_id] || 0) + 1;
      });
    }

    // Attach client counts
    const agenciesWithCounts = agencies?.map(a => ({
      ...a,
      client_count: clientCounts[a.id] || 0
    })) || [];

    console.log(`📋 Admin fetched ${agenciesWithCounts.length} agencies`);

    res.json({ 
      agencies: agenciesWithCounts,
      total: count || agenciesWithCounts.length
    });

  } catch (error) {
    console.error('Admin agencies error:', error);
    res.status(500).json({ error: 'Failed to load agencies' });
  }
});

// ============================================================================
// GET SINGLE AGENCY DETAILS
// ============================================================================
router.get('/agencies/:agencyId', requireAdmin, async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Get agency's clients
    const { data: clients } = await supabase
      .from('clients')
      .select('id, business_name, email, subscription_status, plan_type, calls_this_month, created_at')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });

    res.json({ agency, clients: clients || [] });

  } catch (error) {
    console.error('Admin agency detail error:', error);
    res.status(500).json({ error: 'Failed to load agency' });
  }
});

// ============================================================================
// LIST ALL CLIENTS (across all agencies)
// ============================================================================
router.get('/clients', requireAdmin, async (req, res) => {
  try {
    const { status, agency_id, search, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('clients')
      .select(`
        id, business_name, email, owner_name, owner_phone,
        vapi_phone_number, industry,
        plan_type, subscription_status, status,
        calls_this_month, monthly_call_limit,
        trial_ends_at, created_at,
        agency_id,
        agencies (id, name, slug)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (status) {
      query = query.eq('subscription_status', status);
    }
    if (agency_id) {
      query = query.eq('agency_id', agency_id);
    }
    if (search) {
      query = query.or(`business_name.ilike.%${search}%,email.ilike.%${search}%,owner_name.ilike.%${search}%`);
    }

    const { data: clients, error, count } = await query;

    if (error) throw error;

    console.log(`📋 Admin fetched ${clients?.length || 0} clients`);

    res.json({ 
      clients: clients || [],
      total: count || clients?.length || 0
    });

  } catch (error) {
    console.error('Admin clients error:', error);
    res.status(500).json({ error: 'Failed to load clients' });
  }
});

// ============================================================================
// GET SINGLE CLIENT DETAILS
// ============================================================================
router.get('/clients/:clientId', requireAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select(`
        *,
        agencies (id, name, slug, email)
      `)
      .eq('id', clientId)
      .single();

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Get recent calls
    const { data: calls } = await supabase
      .from('calls')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(20);

    res.json({ client, calls: calls || [] });

  } catch (error) {
    console.error('Admin client detail error:', error);
    res.status(500).json({ error: 'Failed to load client' });
  }
});

// ============================================================================
// UPDATE AGENCY STATUS (suspend/activate)
// ============================================================================
router.patch('/agencies/:agencyId/status', requireAdmin, async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { status, subscription_status } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (status) updates.status = status;
    if (subscription_status) updates.subscription_status = subscription_status;

    const { data, error } = await supabase
      .from('agencies')
      .update(updates)
      .eq('id', agencyId)
      .select()
      .single();

    if (error) throw error;

    console.log(`🔧 Admin updated agency ${agencyId} status:`, updates);

    res.json({ success: true, agency: data });

  } catch (error) {
    console.error('Admin update agency error:', error);
    res.status(500).json({ error: 'Failed to update agency' });
  }
});

// ============================================================================
// UPDATE CLIENT STATUS (suspend/activate)
// ============================================================================
router.patch('/clients/:clientId/status', requireAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { status, subscription_status } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (status) updates.status = status;
    if (subscription_status) updates.subscription_status = subscription_status;

    const { data, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', clientId)
      .select()
      .single();

    if (error) throw error;

    console.log(`🔧 Admin updated client ${clientId} status:`, updates);

    res.json({ success: true, client: data });

  } catch (error) {
    console.error('Admin update client error:', error);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

// ============================================================================
// IMPERSONATE AGENCY (get a token to log in as them)
// ============================================================================
router.post('/agencies/:agencyId/impersonate', requireAdmin, async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: agency, error } = await supabase
      .from('agencies')
      .select('id, email, name, slug')
      .eq('id', agencyId)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Generate a token for this agency
    const token = jwt.sign(
      { 
        id: agency.id,
        email: agency.email,
        name: agency.name,
        type: 'agency',
        impersonated_by: req.admin.email
      },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    console.log(`👤 Admin ${req.admin.email} impersonating agency: ${agency.name}`);

    res.json({
      success: true,
      token,
      agency: {
        id: agency.id,
        name: agency.name,
        slug: agency.slug
      },
      loginUrl: `https://myvoiceaiconnect.com/agency/dashboard?token=${token}`
    });

  } catch (error) {
    console.error('Admin impersonate error:', error);
    res.status(500).json({ error: 'Failed to impersonate' });
  }
});

module.exports = router;