/**
 * Lead Scraper API Route v3
 * 
 * Supports: source = "indeed" | "google_maps"
 * Indeed: { source, keywords, location, maxPages, maxLeads }
 * Google Maps: { source, query?, location, industry?, maxPages, maxLeads }
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('../lib/supabase');
const { runPipeline } = require('../../services/enrichment-pipeline');
const { enrichFromPlaces } = require('../../services/places-enricher');
const { scrapeWebsite } = require('../../services/website-scraper');
const { INDUSTRY_QUERIES } = require('../../services/google-maps-source');

// ── Search Queue (1 Puppeteer at a time) ────────────────────────────────
let searchRunning = false;
const searchQueue = [];

function enqueueSearch(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      searchRunning = true;
      try { resolve(await fn()); }
      catch (err) { reject(err); }
      finally {
        searchRunning = false;
        if (searchQueue.length > 0) searchQueue.shift()();
      }
    };
    if (!searchRunning) task();
    else searchQueue.push(task);
  });
}

// ── Job tracking ────────────────────────────────────────────────────────
const jobs = new Map();

// ── Lead-scrape metering (monthly, per agency) ──────────────────
// Scale = unlimited; Pro = capped. Counted at scrape time (every unique
// enriched business), which is where the Google spend actually happens.
const PLAN_LEAD_CAPS = { free: 100, pro: 1000, scale: Infinity };
const FIND_ALL_JOB_CAP = 1000; // per-job ceiling, including Scale fair-use

function planLeadCap(agency) {
  const isTrialing = ['trialing', 'trial'].includes(agency && agency.subscription_status);
  const plan = isTrialing ? 'scale' : ((agency && agency.plan_type) || 'free');
  return PLAN_LEAD_CAPS[plan] != null ? PLAN_LEAD_CAPS[plan] : PLAN_LEAD_CAPS.free;
}

function currentBillingMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

async function getMonthlyLeadUsage(agencyId) {
  try {
    const { data, error } = await supabase
      .from('lead_scrape_usage')
      .select('leads_scraped')
      .eq('agency_id', agencyId)
      .eq('billing_month', currentBillingMonth())
      .maybeSingle();
    if (error) { console.error('[LeadScraper] usage read failed:', error.message); return 0; }
    return (data && data.leads_scraped) || 0;
  } catch (e) {
    console.error('[LeadScraper] usage read threw:', e.message);
    return 0; // fail open: never block a scrape on a transient counter error
  }
}

async function incrementMonthlyLeadUsage(agencyId, count) {
  if (!agencyId || !count || count <= 0) return;
  try {
    const { error } = await supabase.rpc('increment_lead_scrape_usage', {
      p_agency_id: agencyId, p_month: currentBillingMonth(), p_count: count,
    });
    if (error) console.error('[LeadScraper] usage increment failed:', error.message);
  } catch (e) {
    console.error('[LeadScraper] usage increment threw:', e.message);
  }
}


// ============================================================================
// POST /api/leads/search — Start pipeline (Indeed or Google Maps)
// ============================================================================
router.post('/search', async (req, res) => {
  try {
    const {
      source = "indeed",
      keywords, query, location, industry,
      maxPages = 1, maxLeads = 25, agencyId,
      findAll = false,
    } = req.body;

    if (!location) {
      return res.status(400).json({ error: 'location is required' });
    }

    if (source === "indeed" && !keywords) {
      return res.status(400).json({ error: 'keywords are required for Indeed search' });
    }

    if (source === "google_maps" && !industry && !query) {
      return res.status(400).json({ error: 'industry or query is required for Google Maps search' });
    }

    if (findAll && source !== "google_maps") {
      return res.status(400).json({ error: 'Find-all is only available for Google Maps search' });
    }

    // Prevent concurrent searches per agency
    if (agencyId) {
      for (const [, job] of jobs) {
        if (job.agencyId === agencyId && job.status === 'running') {
          return res.status(429).json({
            error: 'A search is already running. Please wait for it to complete.',
            existingJobId: job.id,
          });
        }
      }
    }

    // Monthly lead metering (only when the agency is known)
    let leadCap = Infinity, usedThisMonth = 0, meteredAgency = null;
    if (agencyId) {
      const { data: agency } = await supabase
        .from('agencies').select('id, plan_type, subscription_status').eq('id', agencyId).maybeSingle();
      if (agency) {
        meteredAgency = agency;
        leadCap = planLeadCap(agency);
        usedThisMonth = await getMonthlyLeadUsage(agencyId);
        if (leadCap !== Infinity && usedThisMonth >= leadCap) {
          return res.json({
            limitReached: true, used: usedThisMonth, cap: leadCap,
            message: `You've used all ${leadCap} leads on your plan this month. Upgrade to Scale for unlimited leads.`,
          });
        }
      }
    }
    const remaining = leadCap === Infinity ? Infinity : Math.max(leadCap - usedThisMonth, 0);
    const perJobCap = findAll ? FIND_ALL_JOB_CAP
      : (source === "google_maps" ? 60 : Math.max(Number(maxLeads) || 25, 1));
    const scrapeMaxLeads = remaining === Infinity ? perJobCap : Math.min(perJobCap, remaining);

    const jobId = uuidv4();
    const jobData = {
      id: jobId,
      status: 'running',
      progress: { stage: 'starting', message: 'Initializing...', percent: 0 },
      leads: [],
      stats: null,
      error: null,
      createdAt: new Date().toISOString(),
      params: { source, keywords, query, location, industry, maxPages, maxLeads, findAll },
      agencyId: agencyId || null,
    };
    jobs.set(jobId, jobData);

    res.json({ jobId, status: 'running', message: 'Search started' });

    // Standard Maps search hard-caps at 60 / 3 pages; derive pages from the
    // requested lead count so "Max 60" pulls all three pages. Find-all ignores
    // maxPages (the tiling engine paginates each tile itself).
    const pipelineParams = {
      source,
      mode: findAll ? "find_all" : "standard",
      keywords, query, location, industry,
      maxPages: source === "google_maps"
        ? Math.min(Math.ceil(Math.min(scrapeMaxLeads, 60) / 20), 3)
        : Math.min(maxPages, 3),
      maxLeads: scrapeMaxLeads,
      onProgress: (progress) => {
        const job = jobs.get(jobId);
        if (job) job.progress = progress;
      },
    };

    const runFn = source === "indeed"
      ? () => enqueueSearch(() => runPipeline(pipelineParams))
      : () => runPipeline(pipelineParams);

    runFn()
      .then(async ({ leads, stats }) => {
        const job = jobs.get(jobId);
        if (!job) return;

        if (meteredAgency) {
          await incrementMonthlyLeadUsage(agencyId, leads.length);
          const newUsed = usedThisMonth + leads.length;
          if (stats) {
            stats.usage = {
              used: newUsed,
              cap: leadCap === Infinity ? null : leadCap,
              remaining: leadCap === Infinity ? null : Math.max(leadCap - newUsed, 0),
              limitReached: leadCap !== Infinity && (newUsed >= leadCap || stats.capped === true),
            };
          }
        }

        job.status = 'complete';
        job.leads = leads;
        job.stats = stats;
        job.progress = { stage: 'done', message: 'Complete', percent: 100 };

        console.log(`[LeadScraper] Job ${jobId} [${source}${findAll ? ':find_all' : ''}] complete, ${leads.length} leads`);
      })
      .catch((error) => {
        console.error(`[LeadScraper] Job ${jobId} failed:`, error);
        const job = jobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = error.message;
          job.progress = { stage: 'error', message: error.message, percent: 0 };
        }
      });
  } catch (error) {
    console.error('[LeadScraper] Search endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ============================================================================
// GET /api/leads/industries — Return available industry presets
// ============================================================================
router.get('/industries', (req, res) => {
  const industries = Object.keys(INDUSTRY_QUERIES).map((key) => ({
    value: key,
    label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  }));
  res.json({ industries });
});


// ============================================================================
// GET /api/leads/search/status/:id
// ============================================================================
router.get('/search/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    id: job.id, status: job.status, progress: job.progress,
    stats: job.stats, leads: job.status === 'complete' ? job.leads : [],
    error: job.error,
  });
});


// ============================================================================
// GET /api/leads/search/stream/:id — SSE
// ============================================================================
router.get('/search/stream/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const interval = setInterval(() => {
    const currentJob = jobs.get(jobId);
    if (!currentJob) { clearInterval(interval); res.end(); return; }

    if (currentJob.status === 'complete' || currentJob.status === 'error') {
      // Send ONE message with leads included, then close
      res.write(`data: ${JSON.stringify({
        status: currentJob.status, progress: currentJob.progress,
        stats: currentJob.stats, leads: currentJob.leads || [], error: currentJob.error,
      })}\n\n`);
      clearInterval(interval);
      res.end();
    } else {
      // Progress updates only while still running
      res.write(`data: ${JSON.stringify({
        status: currentJob.status, progress: currentJob.progress, stats: currentJob.stats,
      })}\n\n`);
    }
  }, 500);

  req.on('close', () => clearInterval(interval));
});


// ============================================================================
// POST /api/leads/enrich — Single company
// ============================================================================
router.post('/enrich', async (req, res) => {
  try {
    const { companyName, location } = req.body;
    if (!companyName || !location) return res.status(400).json({ error: 'companyName and location required' });

    const placesData = await enrichFromPlaces(companyName, location);
    let websiteData = null;
    if (placesData?.website) websiteData = await scrapeWebsite(placesData.website);
    res.json({ companyName, location, places: placesData, website: websiteData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ============================================================================
// POST /api/leads/save-to-crm
// ============================================================================
router.post('/save-to-crm', async (req, res) => {
  try {
    const { leads, agencyId } = req.body;
    if (!leads?.length || !agencyId) return res.status(400).json({ error: 'leads and agencyId required' });

    const { data: agency, error: agencyError } = await supabase
      .from('agencies').select('id').eq('id', agencyId).single();
    if (agencyError || !agency) return res.status(404).json({ error: 'Agency not found' });

    let saved = 0, skipped = 0, errors = 0;

    for (const lead of leads) {
      try {
        let isDuplicate = false;

        if (lead.email) {
          const { data } = await supabase.from('leads').select('id')
            .eq('agency_id', agencyId).eq('email', lead.email.toLowerCase()).maybeSingle();
          if (data) isDuplicate = true;
        }
        if (!isDuplicate && lead.phone) {
          const clean = lead.phone.replace(/[^\d+]/g, '');
          const { data } = await supabase.from('leads').select('id')
            .eq('agency_id', agencyId).eq('phone', clean).maybeSingle();
          if (data) isDuplicate = true;
        }
        if (!isDuplicate && lead.companyName) {
          const { data } = await supabase.from('leads').select('id')
            .eq('agency_id', agencyId).ilike('business_name', lead.companyName).maybeSingle();
          if (data) isDuplicate = true;
        }

        if (isDuplicate) { skipped++; continue; }

        const sourceLabel = lead.leadSource === "google_maps" ? "lead_finder_maps" : "lead_finder";

        const notes = [
          `🎯 Lead Finder Import`,
          lead.leadSource === "google_maps" ? "Source: Google Maps" : `Hiring: ${lead.jobTitle || 'N/A'}`,
          lead.address ? `Address: ${lead.address}` : '',
          lead.rating ? `Google Rating: ${lead.rating} (${lead.reviewCount} reviews)` : '',
          lead.techStack?.length ? `Tech: ${lead.techStack.join(', ')}` : '',
          lead.businessStatus ? `Status: ${lead.businessStatus}` : '',
          lead.jobSnippet ? `Job Description: ${lead.jobSnippet}` : '',
          lead.warnings?.length ? `⚠️ ${lead.warnings.join(', ')}` : '',
          Object.keys(lead.socialLinks || {}).length
            ? `Social: ${Object.entries(lead.socialLinks).map(([k, v]) => `${k}: ${v}`).join(', ')}`
            : '',
        ].filter(Boolean).join('\n');

        const { error: insertError } = await supabase.from('leads').insert({
          agency_id: agencyId,
          business_name: lead.companyName || '',
          contact_name: '',
          phone: lead.phone || '',
          email: (lead.email || '').toLowerCase(),
          website: lead.website || '',
          industry: lead.industry || '',
          source: sourceLabel,
          status: 'new',
          estimated_value: 0,
          notes,
        });

        if (insertError) errors++;
        else saved++;
      } catch (e) {
        errors++;
      }
    }

    res.json({ success: true, saved, skipped, errors, total: leads.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ============================================================================
// POST /api/leads/export — CSV
// ============================================================================
router.post('/export', (req, res) => {
  try {
    const { leads } = req.body;
    if (!leads?.length) return res.status(400).json({ error: 'No leads' });

    const headers = [
      'Company Name', 'Phone', 'Email', 'Website', 'Address',
      'Industry', 'Rating', 'Reviews', 'Hiring For',
      'Job Location', 'Source', 'Tech Stack', 'Google Maps',
      'Facebook', 'Instagram', 'LinkedIn', 'Warnings',
    ];

    const rows = leads.map((l) => [
      l.companyName || '', l.phone || '', l.email || '',
      l.website || '', l.address || '', l.industry || '',
      l.rating || '', l.reviewCount || '',
      l.jobTitle || '', l.jobLocation || '', l.leadSource || 'indeed',
      (l.techStack || []).join(', '), l.googleMapsUrl || '',
      l.socialLinks?.facebook || '', l.socialLinks?.instagram || '',
      l.socialLinks?.linkedin || '', (l.warnings || []).join('; '),
    ]);

    const esc = (v) => {
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=leads.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ── Cleanup ─────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - new Date(job.createdAt).getTime() > 60 * 60 * 1000) jobs.delete(id);
  }
}, 30 * 60 * 1000);


module.exports = router;