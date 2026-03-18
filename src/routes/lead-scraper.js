/**
 * Lead Scraper API Route v2
 * 
 * Fixes applied:
 * - Search queue: only one Puppeteer search runs at a time (prevents OOM on small droplets)
 * - Cross-search dedup cache: tracks companies seen per agency across searches in a session
 * - Concurrent search protection: rejects new searches if one is already running for same agency
 * - Better error propagation: CAPTCHA/block messages reach the frontend clearly
 * - Job cleanup: auto-purge after 1 hour
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('../lib/supabase');
const { runPipeline } = require('../services/enrichment-pipeline');
const { enrichFromPlaces } = require('../services/places-enricher');
const { scrapeWebsite } = require('../services/website-scraper');

// ── Search Queue (prevents concurrent Puppeteer instances) ──────────────
let searchRunning = false;
const searchQueue = [];

function enqueueSearch(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      searchRunning = true;
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        searchRunning = false;
        // Run next in queue
        if (searchQueue.length > 0) {
          const next = searchQueue.shift();
          next();
        }
      }
    };

    if (!searchRunning) {
      task();
    } else {
      searchQueue.push(task);
    }
  });
}

// ── Job tracking ────────────────────────────────────────────────────────
const jobs = new Map();

// ── Cross-search dedup cache (per agency, lasts 1 hour) ────────────────
// Tracks which companies an agency has already seen so repeat searches 
// don't show the same businesses
const dedupCache = new Map(); // agencyId → { companies: Set, timestamp }
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour

function getDedupSet(agencyId) {
  if (!agencyId) return new Set();
  const entry = dedupCache.get(agencyId);
  if (entry && Date.now() - entry.timestamp < DEDUP_TTL_MS) {
    return entry.companies;
  }
  const newSet = new Set();
  dedupCache.set(agencyId, { companies: newSet, timestamp: Date.now() });
  return newSet;
}

function addToDedup(agencyId, companyNames) {
  if (!agencyId) return;
  const set = getDedupSet(agencyId);
  for (const name of companyNames) {
    set.add(name.toLowerCase().trim());
  }
}

function filterDuplicates(leads, agencyId) {
  if (!agencyId) return { filtered: leads, dupCount: 0 };
  const seen = getDedupSet(agencyId);
  const filtered = [];
  let dupCount = 0;

  for (const lead of leads) {
    const key = lead.companyName.toLowerCase().trim();
    if (seen.has(key)) {
      dupCount++;
    } else {
      filtered.push(lead);
    }
  }

  return { filtered, dupCount };
}


// ============================================================================
// POST /api/leads/search — Start full pipeline
// ============================================================================
router.post('/search', async (req, res) => {
  try {
    const { keywords, location, maxPages = 1, maxLeads = 25, agencyId } = req.body;

    if (!keywords || !location) {
      return res.status(400).json({ error: 'keywords and location are required' });
    }

    // Check if this agency already has a running search
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

    const jobId = uuidv4();
    const jobData = {
      id: jobId,
      status: 'running',
      progress: { stage: 'starting', message: 'Initializing...', percent: 0 },
      leads: [],
      stats: null,
      error: null,
      createdAt: new Date().toISOString(),
      params: {
        keywords,
        location,
        maxPages: Math.min(maxPages, 3),
        maxLeads: Math.min(maxLeads, 50),
      },
      agencyId: agencyId || null,
    };
    jobs.set(jobId, jobData);

    res.json({ jobId, status: 'running', message: 'Search started' });

    // Run through queue (only one Puppeteer at a time)
    enqueueSearch(() =>
      runPipeline({
        keywords,
        location,
        maxPages: Math.min(maxPages, 3),
        maxLeads: Math.min(maxLeads, 50),
        onProgress: (progress) => {
          const job = jobs.get(jobId);
          if (job) job.progress = progress;
        },
      })
    )
      .then(({ leads, stats }) => {
        const job = jobs.get(jobId);
        if (!job) return;

        // Filter out companies this agency has already seen in recent searches
        const { filtered, dupCount } = filterDuplicates(leads, agencyId);

        // Add new companies to dedup cache
        addToDedup(agencyId, filtered.map((l) => l.companyName));

        job.status = 'complete';
        job.leads = filtered;
        job.stats = { ...stats, duplicatesRemoved: dupCount };
        job.progress = { stage: 'done', message: 'Complete', percent: 100 };

        console.log(`[LeadScraper] Job ${jobId} complete — ${filtered.length} leads (${dupCount} dupes filtered)`);
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
// GET /api/leads/search/status/:id — Poll for results
// ============================================================================
router.get('/search/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    stats: job.stats,
    leads: job.status === 'complete' ? job.leads : [],
    error: job.error,
  });
});


// ============================================================================
// GET /api/leads/search/stream/:id — SSE for real-time progress
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
    if (!currentJob) {
      clearInterval(interval);
      res.end();
      return;
    }

    res.write(`data: ${JSON.stringify({
      status: currentJob.status,
      progress: currentJob.progress,
      stats: currentJob.stats,
    })}\n\n`);

    if (currentJob.status === 'complete' || currentJob.status === 'error') {
      res.write(`data: ${JSON.stringify({
        status: currentJob.status,
        progress: currentJob.progress,
        stats: currentJob.stats,
        leads: currentJob.leads,
        error: currentJob.error,
      })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on('close', () => clearInterval(interval));
});


// ============================================================================
// POST /api/leads/enrich — Single company enrichment
// ============================================================================
router.post('/enrich', async (req, res) => {
  try {
    const { companyName, location } = req.body;
    if (!companyName || !location) {
      return res.status(400).json({ error: 'companyName and location are required' });
    }

    const placesData = await enrichFromPlaces(companyName, location);
    let websiteData = null;
    if (placesData?.website) {
      websiteData = await scrapeWebsite(placesData.website);
    }

    res.json({ companyName, location, places: placesData, website: websiteData });
  } catch (error) {
    console.error('[LeadScraper] Enrich error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ============================================================================
// POST /api/leads/save-to-crm — Push leads into agency CRM
// ============================================================================
router.post('/save-to-crm', async (req, res) => {
  try {
    const { leads, agencyId } = req.body;
    if (!leads?.length || !agencyId) {
      return res.status(400).json({ error: 'leads array and agencyId are required' });
    }

    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('id')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    let saved = 0, skipped = 0, errors = 0;

    for (const lead of leads) {
      try {
        let isDuplicate = false;

        if (lead.email) {
          const { data: existing } = await supabase
            .from('leads')
            .select('id')
            .eq('agency_id', agencyId)
            .eq('email', lead.email.toLowerCase())
            .maybeSingle();
          if (existing) isDuplicate = true;
        }

        if (!isDuplicate && lead.phone) {
          const cleanPhone = lead.phone.replace(/[^\d+]/g, '');
          const { data: existing } = await supabase
            .from('leads')
            .select('id')
            .eq('agency_id', agencyId)
            .eq('phone', cleanPhone)
            .maybeSingle();
          if (existing) isDuplicate = true;
        }

        // Also check by business name (catch cases with no email/phone)
        if (!isDuplicate && lead.companyName) {
          const { data: existing } = await supabase
            .from('leads')
            .select('id')
            .eq('agency_id', agencyId)
            .ilike('business_name', lead.companyName)
            .maybeSingle();
          if (existing) isDuplicate = true;
        }

        if (isDuplicate) { skipped++; continue; }

        const leadRecord = {
          agency_id: agencyId,
          business_name: lead.companyName || '',
          contact_name: '',
          phone: lead.phone || '',
          email: (lead.email || '').toLowerCase(),
          website: lead.website || '',
          industry: lead.industry || '',
          source: 'lead_finder',
          status: 'new',
          estimated_value: 0,
          notes: [
            `🎯 Lead Finder Import (Fit Score: ${lead.fitScore}/100)`,
            `Hiring: ${lead.jobTitle || 'N/A'}`,
            lead.address ? `Address: ${lead.address}` : '',
            lead.rating ? `Google Rating: ${lead.rating} (${lead.reviewCount} reviews)` : '',
            lead.techStack?.length ? `Tech: ${lead.techStack.join(', ')}` : '',
            lead.businessStatus ? `Status: ${lead.businessStatus}` : '',
            lead.jobSnippet ? `Job Description: ${lead.jobSnippet}` : '',
            lead.warnings?.length ? `⚠️ ${lead.warnings.join(', ')}` : '',
            Object.keys(lead.socialLinks || {}).length
              ? `Social: ${Object.entries(lead.socialLinks).map(([k, v]) => `${k}: ${v}`).join(', ')}`
              : '',
          ].filter(Boolean).join('\n'),
        };

        const { error: insertError } = await supabase.from('leads').insert(leadRecord);
        if (insertError) { errors++; } else { saved++; }
      } catch (e) {
        console.error(`[LeadScraper] Save error for ${lead.companyName}:`, e.message);
        errors++;
      }
    }

    console.log(`[LeadScraper] CRM save: ${saved} saved, ${skipped} dupes, ${errors} errors`);
    res.json({ success: true, saved, skipped, errors, total: leads.length });
  } catch (error) {
    console.error('[LeadScraper] Save to CRM error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ============================================================================
// POST /api/leads/export — CSV generation
// ============================================================================
router.post('/export', (req, res) => {
  try {
    const { leads } = req.body;
    if (!leads?.length) return res.status(400).json({ error: 'No leads to export' });

    const headers = [
      'Company Name', 'Phone', 'Email', 'Website', 'Address',
      'Industry', 'Fit Score', 'Rating', 'Reviews', 'Hiring For',
      'Job Location', 'Salary', 'Tech Stack', 'Google Maps',
      'Facebook', 'Instagram', 'LinkedIn', 'Warnings',
    ];

    const rows = leads.map((l) => [
      l.companyName || '', l.phone || '', l.email || '',
      l.website || '', l.address || '', l.industry || '',
      l.fitScore || 0, l.rating || '', l.reviewCount || '',
      l.jobTitle || '', l.jobLocation || '', l.jobSalary || '',
      (l.techStack || []).join(', '), l.googleMapsUrl || '',
      l.socialLinks?.facebook || '', l.socialLinks?.instagram || '',
      l.socialLinks?.linkedin || '', (l.warnings || []).join('; '),
    ]);

    const escape = (v) => {
      const str = String(v);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const csv = [
      headers.map(escape).join(','),
      ...rows.map((r) => r.map(escape).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=leads.csv');
    res.send(csv);
  } catch (error) {
    console.error('[LeadScraper] Export error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ── Cleanup ─────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  // Clean old jobs
  for (const [id, job] of jobs.entries()) {
    if (now - new Date(job.createdAt).getTime() > 60 * 60 * 1000) jobs.delete(id);
  }
  // Clean old dedup caches
  for (const [agencyId, entry] of dedupCache.entries()) {
    if (now - entry.timestamp > DEDUP_TTL_MS) dedupCache.delete(agencyId);
  }
}, 30 * 60 * 1000);


module.exports = router;