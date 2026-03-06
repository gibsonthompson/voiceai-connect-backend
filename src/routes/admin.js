// ============================================================================
// PLATFORM ADMIN ROUTES
// Only accessible by whitelisted platform owners
// WITH LEADS MANAGEMENT + CSV IMPORT + PIPELINE QUEUE
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

    if (decoded.role !== 'platform_admin') {
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
// ADMIN LOGIN - Simple PIN
// ============================================================================
router.post('/login', async (req, res) => {
  try {
    const { pin } = req.body;

    if (pin !== '1234') {
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    const token = jwt.sign(
      { 
        id: 'platform-admin',
        email: 'admin@voiceaiconnect.com',
        name: 'Platform Admin',
        role: 'platform_admin'
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('🔐 Platform admin logged in via PIN');

    res.json({
      success: true,
      token,
      admin: {
        id: 'platform-admin',
        email: 'admin@voiceaiconnect.com',
        name: 'Platform Admin',
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
    const { data: agencies, error: agencyError } = await supabase
      .from('agencies')
      .select('id, name, email, plan_type, subscription_status, status, created_at, trial_ends_at');

    if (agencyError) throw agencyError;

    const { data: clients, error: clientError } = await supabase
      .from('clients')
      .select('id, agency_id, subscription_status, plan_type, calls_this_month, created_at');

    if (clientError) throw clientError;

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count: callsThisMonth } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startOfMonth.toISOString());

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

    const PLATFORM_PRICES = {
      starter: 9900,
      professional: 19900,
      enterprise: 49900
    };

    let platformMRR = 0;
    agencies?.forEach(agency => {
      if (agency.subscription_status === 'active') {
        const plan = agency.plan_type || 'starter';
        platformMRR += PLATFORM_PRICES[plan] || PLATFORM_PRICES.starter;
      }
    });

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
// LIST ALL AGENCIES — Enriched with aggregate counts from all tables
// ============================================================================
router.get('/agencies', requireAdmin, async (req, res) => {
  try {
    const { status, plan, search, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from('agencies')
      .select('*')
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status) {
      query = query.eq('subscription_status', status);
    }
    if (plan) {
      query = query.eq('plan_type', plan);
    }
    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,slug.ilike.%${search}%`);
    }

    const { data: agencies, error } = await query;

    if (error) throw error;

    // Fetch aggregate counts for all agencies in parallel
    const agencyIds = (agencies || []).map(a => a.id);

    // Client counts per agency + build client→agency map for call counting
    const { data: clientRows } = await supabase
      .from('clients')
      .select('agency_id, id')
      .in('agency_id', agencyIds);

    const clientCounts = {};
    const clientIdToAgency = {};
    (clientRows || []).forEach(c => {
      clientCounts[c.agency_id] = (clientCounts[c.agency_id] || 0) + 1;
      clientIdToAgency[c.id] = c.agency_id;
    });

    // Call counts per agency (calls are linked to clients, not agencies directly)
    let callCounts = {};
    const allClientIds = Object.keys(clientIdToAgency);
    if (allClientIds.length > 0) {
      const { data: callRows } = await supabase
        .from('calls')
        .select('client_id')
        .in('client_id', allClientIds);

      (callRows || []).forEach(c => {
        const agId = clientIdToAgency[c.client_id];
        if (agId) callCounts[agId] = (callCounts[agId] || 0) + 1;
      });
    }

    // Lead counts per agency
    const { data: leadRows } = await supabase
      .from('leads')
      .select('agency_id')
      .in('agency_id', agencyIds);

    const leadCounts = {};
    (leadRows || []).forEach(l => {
      leadCounts[l.agency_id] = (leadCounts[l.agency_id] || 0) + 1;
    });

    // Revenue per agency (succeeded payments only)
    const { data: paymentRows } = await supabase
      .from('payments')
      .select('agency_id, amount, status')
      .in('agency_id', agencyIds)
      .eq('status', 'succeeded');

    const revenueTotals = {};
    const paymentCounts = {};
    (paymentRows || []).forEach(p => {
      revenueTotals[p.agency_id] = (revenueTotals[p.agency_id] || 0) + (p.amount || 0);
      paymentCounts[p.agency_id] = (paymentCounts[p.agency_id] || 0) + 1;
    });

    // User counts per agency
    const { data: userRows } = await supabase
      .from('users')
      .select('agency_id')
      .in('agency_id', agencyIds);

    const userCounts = {};
    (userRows || []).forEach(u => {
      if (u.agency_id) userCounts[u.agency_id] = (userCounts[u.agency_id] || 0) + 1;
    });

    // Enrich each agency
    const enriched = (agencies || []).map(a => ({
      ...a,
      client_count: clientCounts[a.id] || 0,
      call_count: callCounts[a.id] || 0,
      lead_count: leadCounts[a.id] || 0,
      total_revenue: revenueTotals[a.id] || 0,
      payment_count: paymentCounts[a.id] || 0,
      user_count: userCounts[a.id] || 0,
    }));

    // Platform-wide summary
    const sumValues = (obj) => Object.values(obj).reduce((s, c) => s + c, 0);
    const summary = {
      total_agencies: enriched.length,
      active: enriched.filter(a => a.subscription_status === 'active').length,
      trialing: enriched.filter(a => ['trialing', 'trial'].includes(a.subscription_status)).length,
      past_due: enriched.filter(a => a.subscription_status === 'past_due').length,
      canceled: enriched.filter(a => ['canceled', 'suspended'].includes(a.subscription_status || a.status)).length,
      pending: enriched.filter(a => a.subscription_status === 'pending' || a.status === 'pending_payment').length,
      total_clients: sumValues(clientCounts),
      total_calls: sumValues(callCounts),
      total_leads: sumValues(leadCounts),
      total_revenue: sumValues(revenueTotals),
      stripe_connected: enriched.filter(a => a.stripe_charges_enabled).length,
    };

    console.log(`📋 Admin fetched ${enriched.length} agencies (enriched)`);

    res.json({ agencies: enriched, summary });

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

// ============================================================================
// ADMIN LEADS ROUTES — Platform-level sales pipeline
// These are YOUR leads (prospective agencies to sell to).
// Stored with agency_id = NULL to keep them separate from agency CRM leads.
// ============================================================================

// ============================================================================
// GET /api/admin/leads/pipeline - Follow-up queue + pipeline data
// IMPORTANT: This must be BEFORE /leads/:leadId routes
// ============================================================================
router.get('/leads/pipeline', requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const weekFromNow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();

    const pipelineSelect = 'id, business_name, contact_name, email, phone, website, linkedin_url, status, next_follow_up, last_outreach_at, last_outreach_type, estimated_value, industry, created_at';

    // Overdue follow-ups (follow-up date < today, not won/lost)
    const { data: overdue } = await supabase
      .from('leads')
      .select(pipelineSelect)
      .is('agency_id', null)
      .lt('next_follow_up', todayStart)
      .not('status', 'in', '("won","lost")')
      .order('next_follow_up', { ascending: true })
      .limit(20);

    // Due today
    const { data: today } = await supabase
      .from('leads')
      .select(pipelineSelect)
      .is('agency_id', null)
      .gte('next_follow_up', todayStart)
      .lt('next_follow_up', todayEnd)
      .not('status', 'in', '("won","lost")')
      .order('next_follow_up', { ascending: true })
      .limit(20);

    // Upcoming (next 7 days, excluding today)
    const { data: upcoming } = await supabase
      .from('leads')
      .select(pipelineSelect)
      .is('agency_id', null)
      .gte('next_follow_up', todayEnd)
      .lt('next_follow_up', weekFromNow)
      .not('status', 'in', '("won","lost")')
      .order('next_follow_up', { ascending: true })
      .limit(20);

    // Untouched (status=new, never contacted)
    const { data: untouched } = await supabase
      .from('leads')
      .select(pipelineSelect)
      .is('agency_id', null)
      .eq('status', 'new')
      .is('last_outreach_at', null)
      .order('created_at', { ascending: false })
      .limit(20);

    // Gone cold — contacted but no outreach in 7+ days, no follow-up set, not won/lost/new
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: cold } = await supabase
      .from('leads')
      .select(pipelineSelect)
      .is('agency_id', null)
      .not('status', 'in', '("new","won","lost")')
      .lt('last_outreach_at', sevenDaysAgo)
      .is('next_follow_up', null)
      .order('last_outreach_at', { ascending: true })
      .limit(20);

    // Tab counts
    const { count: activeCount } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .is('agency_id', null)
      .in('status', ['contacted', 'qualified', 'proposal']);

    const { count: closedCount } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .is('agency_id', null)
      .in('status', ['won', 'lost']);

    const actionCount = (overdue?.length || 0) + (today?.length || 0) + (untouched?.length || 0) + (cold?.length || 0);

    res.json({
      queue: {
        overdue: overdue || [],
        today: today || [],
        upcoming: upcoming || [],
        untouched: untouched || [],
        cold: cold || [],
      },
      counts: {
        action: actionCount,
        active: activeCount || 0,
        closed: closedCount || 0,
      }
    });
  } catch (error) {
    console.error('Admin pipeline error:', error);
    res.status(500).json({ error: 'Failed to load pipeline' });
  }
});

// ============================================================================
// GET /api/admin/leads - List platform leads (agency_id IS NULL)
// Updated: supports multi-status params from tab filtering
// ============================================================================
router.get('/leads', requireAdmin, async (req, res) => {
  try {
    const { status, source, search, limit = 200, offset = 0 } = req.query;

    let query = supabase
      .from('leads')
      .select('*', { count: 'exact' })
      .is('agency_id', null)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    // Handle single or multiple status values
    // Frontend sends ?status=contacted&status=qualified for tab filtering
    if (status) {
      if (Array.isArray(status)) {
        query = query.in('status', status);
      } else {
        query = query.eq('status', status);
      }
    }
    if (source) query = query.eq('source', source);
    if (search) {
      query = query.or(`business_name.ilike.%${search}%,contact_name.ilike.%${search}%,email.ilike.%${search}%,industry.ilike.%${search}%`);
    }

    const { data: leads, error, count } = await query;

    if (error) throw error;

    res.json({ leads: leads || [], total: count || (leads || []).length });
  } catch (error) {
    console.error('Admin leads error:', error);
    res.status(500).json({ error: 'Failed to load leads' });
  }
});

// ============================================================================
// GET /api/admin/leads-stats - Platform lead stats
// ============================================================================
router.get('/leads-stats', requireAdmin, async (req, res) => {
  try {
    const { data: leads, error } = await supabase
      .from('leads')
      .select('status, source, estimated_value, created_at')
      .is('agency_id', null);

    if (error) throw error;

    const allLeads = leads || [];
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const stats = {
      total: allLeads.length,
      byStatus: {
        new: allLeads.filter(l => l.status === 'new').length,
        contacted: allLeads.filter(l => l.status === 'contacted').length,
        qualified: allLeads.filter(l => l.status === 'qualified').length,
        proposal: allLeads.filter(l => l.status === 'proposal').length,
        won: allLeads.filter(l => l.status === 'won').length,
        lost: allLeads.filter(l => l.status === 'lost').length,
      },
      bySource: allLeads.reduce((acc, l) => {
        acc[l.source || 'unknown'] = (acc[l.source || 'unknown'] || 0) + 1;
        return acc;
      }, {}),
      totalValue: allLeads
        .filter(l => !['won', 'lost'].includes(l.status))
        .reduce((sum, l) => sum + (l.estimated_value || 0), 0),
      recentlyAdded: allLeads.filter(l => new Date(l.created_at) > weekAgo).length,
    };

    res.json({ stats });
  } catch (error) {
    console.error('Admin leads stats error:', error);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ============================================================================
// POST /api/admin/leads - Create a platform lead (no agency)
// ============================================================================
router.post('/leads', requireAdmin, async (req, res) => {
  try {
    const { business_name, contact_name, email, phone, website, linkedin_url, industry, source, notes, estimated_value } = req.body;

    if (!business_name && !contact_name) {
      return res.status(400).json({ error: 'Business name or contact name is required' });
    }

    // Normalize LinkedIn URL
    let cleanLinkedin = linkedin_url || null;
    if (cleanLinkedin && !cleanLinkedin.startsWith('http')) {
      cleanLinkedin = 'https://' + cleanLinkedin;
    }

    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        agency_id: null,
        business_name: business_name || null,
        contact_name: contact_name || null,
        email: email ? email.toLowerCase().trim() : null,
        phone: phone || null,
        website: website || null,
        linkedin_url: cleanLinkedin,
        industry: industry || null,
        source: source || 'other',
        status: 'new',
        notes: notes || null,
        estimated_value: estimated_value ? parseInt(estimated_value) : null,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    console.log(`✅ Admin created platform lead: ${business_name || contact_name}`);
    res.status(201).json({ success: true, lead });
  } catch (error) {
    console.error('Admin create lead error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/admin/leads/import - Bulk CSV import as platform leads
// No agency needed — these are YOUR prospective agency leads
// ============================================================================
router.post('/leads/import', requireAdmin, async (req, res) => {
  try {
    const { leads: importLeads, columnMapping, defaultSource } = req.body;

    if (!importLeads || !Array.isArray(importLeads) || importLeads.length === 0) {
      return res.status(400).json({ error: 'No leads provided' });
    }

    if (importLeads.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 leads per import' });
    }

    // Map CSV rows to lead objects
    const leadsToInsert = [];
    const errors = [];

    importLeads.forEach((row, index) => {
      const mapped = {};
      for (const [dbField, csvColumn] of Object.entries(columnMapping)) {
        if (csvColumn && row[csvColumn] !== undefined && row[csvColumn] !== null) {
          mapped[dbField] = String(row[csvColumn]).trim();
        }
      }

      if (!mapped.business_name && !mapped.contact_name) {
        errors.push({ row: index + 1, error: 'Missing business name and contact name' });
        return;
      }

      let estimatedValue = null;
      if (mapped.estimated_value) {
        const cleaned = mapped.estimated_value.replace(/[$,\s]/g, '');
        const parsed = parseFloat(cleaned);
        if (!isNaN(parsed)) {
          estimatedValue = parsed < 1000 ? Math.round(parsed * 100) : Math.round(parsed);
        }
      }

      let phone = mapped.phone || null;
      if (phone) {
        phone = phone.replace(/[^\d+]/g, '');
        if (phone.length > 0 && !phone.startsWith('+') && phone.length === 10) {
          phone = '+1' + phone;
        }
      }

      let email = mapped.email || null;
      if (email && !email.includes('@')) email = null;

      let website = mapped.website || null;
      if (website && !website.startsWith('http')) website = 'https://' + website;

      // Normalize LinkedIn URL
      let linkedinUrl = mapped.linkedin_url || null;
      if (linkedinUrl && !linkedinUrl.startsWith('http')) {
        linkedinUrl = 'https://' + linkedinUrl;
      }

      leadsToInsert.push({
        agency_id: null,
        business_name: mapped.business_name || null,
        contact_name: mapped.contact_name || null,
        email: email ? email.toLowerCase() : null,
        phone,
        website,
        linkedin_url: linkedinUrl,
        industry: mapped.industry || null,
        source: defaultSource || 'csv_import',
        status: 'new',
        notes: mapped.notes || null,
        estimated_value: estimatedValue,
        company_size: mapped.company_size || null,
      });
    });

    if (leadsToInsert.length === 0) {
      return res.status(400).json({ error: 'No valid leads to import', errors });
    }

    // Deduplicate by email within import
    const emailSet = new Set();
    const deduped = leadsToInsert.filter(lead => {
      if (!lead.email) return true;
      if (emailSet.has(lead.email)) return false;
      emailSet.add(lead.email);
      return true;
    });

    // Check existing platform leads by email (agency_id IS NULL)
    const emailsToCheck = deduped.map(l => l.email).filter(Boolean);
    let existingEmails = new Set();
    if (emailsToCheck.length > 0) {
      const { data: existing } = await supabase
        .from('leads')
        .select('email')
        .is('agency_id', null)
        .in('email', emailsToCheck);
      existingEmails = new Set((existing || []).map(e => e.email));
    }

    const newLeads = deduped.filter(lead => {
      if (lead.email && existingEmails.has(lead.email)) {
        errors.push({ row: deduped.indexOf(lead) + 1, error: `Already exists: ${lead.email}` });
        return false;
      }
      return true;
    });

    if (newLeads.length === 0) {
      return res.status(200).json({
        success: true, imported: 0, duplicates: errors.length, errors,
        message: 'All leads already exist'
      });
    }

    const { data: inserted, error } = await supabase
      .from('leads')
      .insert(newLeads)
      .select();

    if (error) {
      console.error('Error bulk inserting leads:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Admin CSV Import: ${inserted.length} platform leads`);

    res.status(201).json({
      success: true,
      imported: inserted.length,
      duplicates: errors.filter(e => e.error.includes('Already exists')).length,
      errors: errors.length > 0 ? errors : [],
      message: `Imported ${inserted.length} lead${inserted.length !== 1 ? 's' : ''}`
    });
  } catch (error) {
    console.error('Error admin importing leads:', error);
    res.status(500).json({ error: 'Server error during import' });
  }
});

// ============================================================================
// PUT /api/admin/leads/:leadId - Update a platform lead
// ============================================================================
router.put('/leads/:leadId', requireAdmin, async (req, res) => {
  try {
    const { leadId } = req.params;
    const {
      business_name, contact_name, email, phone, website, linkedin_url,
      industry, source, status, notes, estimated_value, next_follow_up
    } = req.body;

    const updates = {};
    if (business_name !== undefined) updates.business_name = business_name;
    if (contact_name !== undefined) updates.contact_name = contact_name;
    if (email !== undefined) updates.email = email ? email.toLowerCase().trim() : null;
    if (phone !== undefined) updates.phone = phone;
    if (website !== undefined) updates.website = website;
    if (linkedin_url !== undefined) {
      let cleanLinkedin = linkedin_url || null;
      if (cleanLinkedin && !cleanLinkedin.startsWith('http')) {
        cleanLinkedin = 'https://' + cleanLinkedin;
      }
      updates.linkedin_url = cleanLinkedin;
    }
    if (industry !== undefined) updates.industry = industry;
    if (source !== undefined) updates.source = source;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (estimated_value !== undefined) updates.estimated_value = estimated_value ? parseInt(estimated_value) : null;
    if (next_follow_up !== undefined) updates.next_follow_up = next_follow_up || null;

    const { data: lead, error } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', leadId)
      .is('agency_id', null)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    console.log(`✅ Admin updated platform lead: ${lead.business_name}`);
    res.json({ success: true, lead });
  } catch (error) {
    console.error('Admin update lead error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/admin/leads/:leadId/follow-up - Set/clear follow-up date
// ============================================================================
router.post('/leads/:leadId/follow-up', requireAdmin, async (req, res) => {
  try {
    const { leadId } = req.params;
    const { next_follow_up } = req.body;

    const { data: lead, error } = await supabase
      .from('leads')
      .update({ 
        next_follow_up: next_follow_up || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', leadId)
      .is('agency_id', null)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    console.log(`📅 Follow-up ${next_follow_up ? 'set' : 'cleared'} for lead: ${lead.business_name}`);
    res.json({ success: true, lead });
  } catch (error) {
    console.error('Admin follow-up error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// DELETE /api/admin/leads/:leadId - Delete a platform lead
// ============================================================================
router.delete('/leads/:leadId', requireAdmin, async (req, res) => {
  try {
    const { leadId } = req.params;

    const { error } = await supabase
      .from('leads')
      .delete()
      .eq('id', leadId)
      .is('agency_id', null);

    if (error) return res.status(400).json({ error: error.message });

    console.log(`✅ Admin deleted platform lead: ${leadId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Admin delete lead error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// ADMIN OUTREACH ROUTES — Platform-level templates, compose, and logging
// Templates and history stored with agency_id = NULL
// ============================================================================

const ADMIN_TEMPLATE_VARIABLES = {
  lead: [
    { key: '{lead_business_name}', label: 'Business Name', description: 'Prospect company name' },
    { key: '{lead_contact_name}', label: 'Contact Full Name', description: 'Full name of contact' },
    { key: '{lead_contact_first_name}', label: 'Contact First Name', description: 'First name only' },
    { key: '{lead_industry}', label: 'Industry', description: 'Business industry' },
    { key: '{lead_email}', label: 'Email', description: 'Contact email address' },
    { key: '{lead_phone}', label: 'Phone', description: 'Contact phone number' },
    { key: '{lead_website}', label: 'Website', description: 'Business website' },
    { key: '{lead_linkedin_url}', label: 'LinkedIn URL', description: 'LinkedIn profile URL' },
    { key: '{lead_source}', label: 'Source', description: 'How you found them' },
  ],
  sender: [
    { key: '{your_name}', label: 'Your Name', description: 'Your name (Gibson)' },
    { key: '{your_email}', label: 'Your Email', description: 'Your email address' },
    { key: '{platform_name}', label: 'Platform Name', description: 'VoiceAI Connect' },
    { key: '{platform_url}', label: 'Platform URL', description: 'Platform website' },
    { key: '{demo_link}', label: 'Demo Link', description: 'Demo booking / signup link' },
  ],
  dynamic: [
    { key: '{today_date}', label: "Today's Date", description: 'Current date' },
  ]
};

// GET /api/admin/templates - List platform templates
router.get('/templates', requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;

    let query = supabase
      .from('outreach_templates')
      .select('*')
      .is('agency_id', null)
      .order('sequence_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (type) query = query.eq('type', type);

    const { data: templates, error } = await query;
    if (error) throw error;

    const sequences = [...new Set(
      (templates || []).filter(t => t.sequence_name).map(t => t.sequence_name)
    )];

    res.json({ templates: templates || [], sequences, variables: ADMIN_TEMPLATE_VARIABLES });
  } catch (error) {
    console.error('Admin templates error:', error);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// POST /api/admin/templates - Create platform template
router.post('/templates', requireAdmin, async (req, res) => {
  try {
    const { name, description, type = 'email', subject, body, is_follow_up, sequence_name, sequence_order, delay_days } = req.body;

    if (!name || !body) return res.status(400).json({ error: 'Name and body are required' });
    if (type === 'email' && !subject) return res.status(400).json({ error: 'Subject is required for email templates' });

    const { data: template, error } = await supabase
      .from('outreach_templates')
      .insert({
        agency_id: null,
        name, description, type, subject, body,
        is_follow_up: is_follow_up || false,
        sequence_name: sequence_name || null,
        sequence_order: sequence_order ? parseInt(sequence_order) : null,
        delay_days: delay_days ? parseInt(delay_days) : null,
        is_default: false,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    console.log(`✅ Admin template created: ${name}`);
    res.status(201).json({ success: true, template });
  } catch (error) {
    console.error('Admin create template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/templates/:templateId - Get single template
router.get('/templates/:templateId', requireAdmin, async (req, res) => {
  try {
    const { templateId } = req.params;

    const { data: template, error } = await supabase
      .from('outreach_templates')
      .select('*')
      .eq('id', templateId)
      .is('agency_id', null)
      .single();

    if (error || !template) return res.status(404).json({ error: 'Template not found' });

    res.json({ template, variables: ADMIN_TEMPLATE_VARIABLES });
  } catch (error) {
    console.error('Admin get template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/templates/:templateId - Update template
router.put('/templates/:templateId', requireAdmin, async (req, res) => {
  try {
    const { templateId } = req.params;
    const updates = { ...req.body };

    delete updates.id;
    delete updates.agency_id;
    delete updates.created_at;

    if (updates.sequence_order) updates.sequence_order = parseInt(updates.sequence_order);
    if (updates.delay_days) updates.delay_days = parseInt(updates.delay_days);

    const { data: template, error } = await supabase
      .from('outreach_templates')
      .update(updates)
      .eq('id', templateId)
      .is('agency_id', null)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    if (!template) return res.status(404).json({ error: 'Template not found' });

    res.json({ success: true, template });
  } catch (error) {
    console.error('Admin update template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/templates/:templateId
router.delete('/templates/:templateId', requireAdmin, async (req, res) => {
  try {
    const { templateId } = req.params;

    const { error } = await supabase
      .from('outreach_templates')
      .delete()
      .eq('id', templateId)
      .is('agency_id', null);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (error) {
    console.error('Admin delete template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/templates/:templateId/duplicate
router.post('/templates/:templateId/duplicate', requireAdmin, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { name } = req.body;

    const { data: original, error: fetchError } = await supabase
      .from('outreach_templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (fetchError || !original) return res.status(404).json({ error: 'Template not found' });

    const { data: template, error } = await supabase
      .from('outreach_templates')
      .insert({
        agency_id: null,
        name: name || `${original.name} (Copy)`,
        description: original.description,
        type: original.type,
        subject: original.subject,
        body: original.body,
        is_follow_up: original.is_follow_up,
        sequence_name: null,
        sequence_order: null,
        delay_days: original.delay_days,
        is_default: false,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    res.status(201).json({ success: true, template });
  } catch (error) {
    console.error('Admin duplicate template error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/outreach/variables
router.get('/outreach/variables', requireAdmin, (req, res) => {
  res.json({ variables: ADMIN_TEMPLATE_VARIABLES });
});

// POST /api/admin/outreach/compose - Variable substitution
router.post('/outreach/compose', requireAdmin, async (req, res) => {
  try {
    const { templateId, leadId, customSubject, customBody } = req.body;

    let lead = null;
    if (leadId) {
      const { data } = await supabase
        .from('leads')
        .select('*')
        .eq('id', leadId)
        .is('agency_id', null)
        .single();
      lead = data;
    }

    let subject = customSubject || '';
    let body = customBody || '';

    if (templateId) {
      const { data: template } = await supabase
        .from('outreach_templates')
        .select('*')
        .eq('id', templateId)
        .single();

      if (template) {
        subject = customSubject || template.subject || '';
        body = customBody || template.body || '';
      }
    }

    const replacements = {
      '{lead_business_name}': lead?.business_name || '[Business Name]',
      '{lead_contact_name}': lead?.contact_name || '[Contact Name]',
      '{lead_contact_first_name}': lead?.contact_name?.split(' ')[0] || '[First Name]',
      '{lead_industry}': lead?.industry || '[Industry]',
      '{lead_email}': lead?.email || '[Email]',
      '{lead_phone}': lead?.phone || '[Phone]',
      '{lead_website}': lead?.website || '[Website]',
      '{lead_linkedin_url}': lead?.linkedin_url || '[LinkedIn URL]',
      '{lead_source}': lead?.source || '[Source]',
      '{your_name}': 'Gibson Thompson',
      '{your_email}': 'gibson@myvoiceaiconnect.com',
      '{platform_name}': 'VoiceAI Connect',
      '{platform_url}': 'https://myvoiceaiconnect.com',
      '{demo_link}': 'https://myvoiceaiconnect.com/demo',
      '{today_date}': new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      }),
    };

    let composedSubject = subject;
    let composedBody = body;

    for (const [variable, value] of Object.entries(replacements)) {
      composedSubject = composedSubject.replace(new RegExp(variable.replace(/[{}]/g, '\\$&'), 'g'), value);
      composedBody = composedBody.replace(new RegExp(variable.replace(/[{}]/g, '\\$&'), 'g'), value);
    }

    res.json({
      subject: composedSubject,
      body: composedBody,
      toAddress: lead?.email || '',
      toPhone: lead?.phone || '',
      variables: replacements
    });
  } catch (error) {
    console.error('Admin compose error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/outreach/log - Log outreach sent
router.post('/outreach/log', requireAdmin, async (req, res) => {
  try {
    const { leadId, templateId, type, toAddress, toPhone, subject, body } = req.body;

    if (!type || !body) return res.status(400).json({ error: 'type and body are required' });

    const { data: outreach, error } = await supabase
      .from('outreach_history')
      .insert({
        agency_id: null,
        lead_id: leadId || null,
        template_id: templateId || null,
        type,
        recipient_email: toAddress || null,
        recipient_phone: toPhone || null,
        subject: subject || null,
        body,
        status: 'sent',
        sent_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Update lead status to contacted if still new
    if (leadId) {
      const { data: lead } = await supabase
        .from('leads')
        .select('status')
        .eq('id', leadId)
        .single();

      if (lead && lead.status === 'new') {
        await supabase
          .from('leads')
          .update({ status: 'contacted' })
          .eq('id', leadId);
      }
    }

    // Update template use count
    if (templateId) {
      const { data: template } = await supabase
        .from('outreach_templates')
        .select('use_count')
        .eq('id', templateId)
        .single();

      if (template) {
        await supabase
          .from('outreach_templates')
          .update({ use_count: (template.use_count || 0) + 1 })
          .eq('id', templateId);
      }
    }

    // NOTE: last_outreach_at and last_outreach_type are updated automatically
    // by the database trigger (trg_update_lead_last_outreach) on outreach_history INSERT

    console.log(`✅ Admin outreach logged: ${type} to ${toAddress || toPhone}`);
    res.status(201).json({ success: true, outreach });
  } catch (error) {
    console.error('Admin log outreach error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/outreach/history - Platform outreach history
router.get('/outreach/history', requireAdmin, async (req, res) => {
  try {
    const { leadId, type, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('outreach_history')
      .select(`
        *,
        lead:leads (id, business_name, contact_name),
        template:outreach_templates (id, name)
      `, { count: 'exact' })
      .is('agency_id', null)
      .order('sent_at', { ascending: false });

    if (leadId) query = query.eq('lead_id', leadId);
    if (type) query = query.eq('type', type);
    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: history, error, count } = await query;
    if (error) throw error;

    res.json({ history: history || [], total: count });
  } catch (error) {
    console.error('Admin outreach history error:', error);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// GET /api/admin/leads/:leadId/outreach - Outreach stats for a platform lead
router.get('/leads/:leadId/outreach', requireAdmin, async (req, res) => {
  try {
    const { leadId } = req.params;

    const { data: history, error } = await supabase
      .from('outreach_history')
      .select('id, type, sent_at, subject, template_id')
      .is('agency_id', null)
      .eq('lead_id', leadId)
      .order('sent_at', { ascending: true });

    if (error) throw error;

    const emails = (history || []).filter(h => h.type === 'email');
    const sms = (history || []).filter(h => h.type === 'sms');

    res.json({
      outreach: {
        email_count: emails.length,
        sms_count: sms.length,
        total_count: (history || []).length,
        last_email: emails.length > 0 ? emails[emails.length - 1] : null,
        last_sms: sms.length > 0 ? sms[sms.length - 1] : null,
        last_outreach: history && history.length > 0 ? history[history.length - 1] : null,
        next_email_number: emails.length + 1,
        next_sms_number: sms.length + 1,
        history: history || [],
      }
    });
  } catch (error) {
    console.error('Admin lead outreach error:', error);
    res.status(500).json({ error: 'Failed to load outreach stats' });
  }
});

module.exports = router;