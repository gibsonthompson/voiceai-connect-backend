/**
 * Lead Enrichment Pipeline v2
 * 
 * Fixes applied:
 * - Location match validation (flags low-confidence Google Places matches)
 * - Smarter fit scoring that accounts for location match quality
 * - Better industry inference with more patterns
 * - Pipeline timing per-company for performance visibility
 * - Graceful degradation (returns partial data instead of failing)
 */

const { scrapeIndeed } = require("./indeed-scraper");
const { enrichFromPlaces } = require("./places-enricher");
const { scrapeWebsite } = require("./website-scraper");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Job titles that indicate high need for AI receptionist
const HIGH_FIT_TITLES = [
  "receptionist", "front desk", "office manager", "office administrator",
  "administrative assistant", "secretary", "customer service",
  "phone operator", "call center", "intake coordinator",
  "appointment scheduler", "patient coordinator", "dental receptionist",
  "medical receptionist", "legal receptionist", "veterinary receptionist",
  "office coordinator", "front office", "scheduling coordinator",
];

// Industries that commonly need AI receptionists
const HIGH_FIT_INDUSTRIES = [
  "dentist", "dental", "doctor", "medical", "health", "veterinary", "vet",
  "law", "legal", "attorney", "plumbing", "plumber", "hvac", "heating",
  "roofing", "contractor", "real_estate", "insurance", "salon", "spa",
  "auto_repair", "car_dealer", "accounting", "chiropract", "physiotherap",
  "moving", "landscap", "pest_control", "electrician", "cleaning",
  "optometrist", "orthodont", "dermatolog", "pediatr", "therapy",
  "counseling", "funeral", "mortuary", "storage", "towing",
];

/**
 * Calculate fit score (0-100)
 */
function calculateFitScore(job, placesData, websiteData) {
  let score = 30; // Base — they're hiring, some need exists

  const titleLower = job.title.toLowerCase();
  const isHighFitTitle = HIGH_FIT_TITLES.some((t) => titleLower.includes(t));
  if (isHighFitTitle) score += 30;

  if (titleLower.includes("receptionist") || titleLower.includes("front desk")) {
    score += 15;
  }

  if (placesData?.businessTypes) {
    const typesStr = placesData.businessTypes.join(" ").toLowerCase();
    if (HIGH_FIT_INDUSTRIES.some((ind) => typesStr.includes(ind))) score += 10;
  }

  if (placesData?.reviewCount) {
    if (placesData.reviewCount >= 5 && placesData.reviewCount <= 200) score += 5;
  }

  if (placesData?.businessStatus === "OPERATIONAL") score += 5;

  if (placesData?.website || websiteData?.phones?.length) score += 5;

  if (websiteData?.techStack?.length) {
    const stack = websiteData.techStack.join(" ").toLowerCase();
    if (stack.includes("wordpress") || stack.includes("wix") || stack.includes("squarespace")) {
      score += 5;
    }
  }

  // Penalize low location match confidence (likely wrong business)
  if (placesData?.locationMatchScore !== undefined && placesData.locationMatchScore < 0.3) {
    score -= 15;
  }

  return Math.max(0, Math.min(score, 100));
}

/**
 * Infer industry from available data
 */
function inferIndustry(job, placesData) {
  if (placesData?.businessTypes) {
    const types = placesData.businessTypes;
    if (types.some((t) => t.includes("health") || t.includes("doctor") || t.includes("hospital"))) return "Healthcare";
    if (types.some((t) => t.includes("dentist"))) return "Dental";
    if (types.some((t) => t.includes("veterinary"))) return "Veterinary";
    if (types.some((t) => t.includes("lawyer") || t.includes("legal"))) return "Legal";
    if (types.some((t) => t.includes("real_estate"))) return "Real Estate";
    if (types.some((t) => t.includes("insurance"))) return "Insurance";
    if (types.some((t) => t.includes("salon") || t.includes("beauty") || t.includes("spa"))) return "Beauty & Wellness";
    if (types.some((t) => t.includes("restaurant") || t.includes("food"))) return "Restaurant";
    if (types.some((t) => t.includes("car_repair") || t.includes("car_dealer"))) return "Automotive";
    if (types.some((t) => t.includes("accounting"))) return "Accounting";
    if (types.some((t) => t.includes("plumber") || t.includes("electrician") || t.includes("roofing"))) return "Home Services";
    if (types.some((t) => t.includes("lodging"))) return "Hospitality";
    if (types.some((t) => t.includes("store") || t.includes("shop"))) return "Retail";
    if (types.some((t) => t.includes("storage"))) return "Storage";
    if (types.some((t) => t.includes("gym") || t.includes("fitness"))) return "Fitness";
  }

  const text = `${job.title} ${job.snippet || ""}`.toLowerCase();
  if (/dental|dentist/.test(text)) return "Dental";
  if (/medical|doctor|clinic|hospital|patient/.test(text)) return "Healthcare";
  if (/veterinar|vet|animal/.test(text)) return "Veterinary";
  if (/law|legal|attorney|paralegal/.test(text)) return "Legal";
  if (/salon|beauty|spa|hair|nail/.test(text)) return "Beauty & Wellness";
  if (/plumb|hvac|roof|electri|landscap|contract|handyman/.test(text)) return "Home Services";
  if (/real estate|property|realt|mortgage/.test(text)) return "Real Estate";
  if (/insurance|claims/.test(text)) return "Insurance";
  if (/auto|car|mechanic|body shop|tire/.test(text)) return "Automotive";
  if (/accounting|tax|bookkeep|cpa/.test(text)) return "Accounting";
  if (/storage|moving/.test(text)) return "Storage & Moving";
  if (/gym|fitness|yoga|pilates/.test(text)) return "Fitness";
  if (/therapy|counseling|psycholog/.test(text)) return "Therapy";

  return "Other";
}

/**
 * Enrich a single company
 */
async function enrichCompany(job) {
  const startTime = Date.now();

  const lead = {
    companyName: job.companyName,
    jobTitle: job.title,
    jobLocation: job.location,
    jobSalary: job.salary || null,
    jobSnippet: job.snippet || null,
    indeedUrl: job.jobUrl || null,

    phone: null,
    email: null,
    website: null,
    address: null,
    googleMapsUrl: null,
    rating: null,
    reviewCount: null,
    industry: null,
    businessStatus: null,
    hours: null,
    socialLinks: {},
    techStack: [],
    fitScore: 0,
    locationMatchConfidence: null,

    enrichedAt: new Date().toISOString(),
    enrichmentSources: [],
    enrichmentTimeMs: 0,
    warnings: [],
  };

  // Step 1: Google Places
  let placesData = null;
  try {
    placesData = await enrichFromPlaces(job.companyName, job.location);
    if (placesData) {
      lead.enrichmentSources.push("google_places");
      lead.phone = placesData.phone;
      lead.website = placesData.website;
      lead.address = placesData.address;
      lead.googleMapsUrl = placesData.googleMapsUrl;
      lead.rating = placesData.rating;
      lead.reviewCount = placesData.reviewCount;
      lead.businessStatus = placesData.businessStatus;
      lead.hours = placesData.hours;
      lead.locationMatchConfidence = placesData.locationMatchScore;

      // Flag low-confidence matches
      if (placesData.locationMatchScore < 0.3) {
        lead.warnings.push("Low location match — may be a different branch or business");
      }
      if (placesData.matchedName && placesData.matchedName.toLowerCase() !== job.companyName.toLowerCase()) {
        // Name mismatch — could be a parent company or wrong match
        const similarity = placesData.matchedName.toLowerCase().includes(job.companyName.toLowerCase().split(" ")[0]);
        if (!similarity) {
          lead.warnings.push(`Google matched "${placesData.matchedName}" — verify this is correct`);
        }
      }
    }
  } catch (e) {
    console.error(`[Pipeline] Places failed for ${job.companyName}:`, e.message);
  }

  // Step 2: Website scrape
  let websiteData = null;
  const websiteUrl = placesData?.website || null;
  if (websiteUrl) {
    try {
      websiteData = await scrapeWebsite(websiteUrl);
      if (websiteData) {
        lead.enrichmentSources.push("website_scrape");
        if (!lead.phone && websiteData.phones?.length) lead.phone = websiteData.phones[0];
        if (websiteData.emails?.length) lead.email = websiteData.emails[0];
        if (Object.keys(websiteData.socialLinks || {}).length) lead.socialLinks = websiteData.socialLinks;
        if (websiteData.techStack?.length) lead.techStack = websiteData.techStack;
      }
    } catch (e) {
      console.error(`[Pipeline] Website scrape failed for ${websiteUrl}:`, e.message);
    }
  }

  // Step 3: Score and classify
  lead.industry = inferIndustry(job, placesData);
  lead.fitScore = calculateFitScore(job, placesData, websiteData);
  lead.enrichmentTimeMs = Date.now() - startTime;

  return lead;
}

/**
 * Main pipeline entry point
 */
async function runPipeline({ keywords, location, maxPages = 1, maxLeads = 25, onProgress }) {
  const stats = {
    indeedJobsFound: 0,
    uniqueCompanies: 0,
    enriched: 0,
    withPhone: 0,
    withEmail: 0,
    withWebsite: 0,
    avgFitScore: 0,
    lowConfidenceMatches: 0,
    startTime: Date.now(),
    endTime: null,
  };

  // Stage 1: Scrape Indeed
  if (onProgress) onProgress({ stage: "indeed", message: "Searching Indeed...", percent: 5 });

  let jobs;
  try {
    jobs = await scrapeIndeed({ keywords, location, maxPages });
  } catch (error) {
    // Return the error message (CAPTCHA, blocked, etc.) to the frontend
    throw new Error(`Indeed search failed: ${error.message}`);
  }

  stats.indeedJobsFound = jobs.length;
  stats.uniqueCompanies = jobs.length;

  if (jobs.length === 0) {
    return { leads: [], stats };
  }

  const toEnrich = jobs.slice(0, maxLeads);

  // Stage 2+3: Enrich each company
  const leads = [];
  for (let i = 0; i < toEnrich.length; i++) {
    const job = toEnrich[i];
    const percent = 10 + Math.round((i / toEnrich.length) * 85);

    if (onProgress) {
      onProgress({
        stage: "enriching",
        message: `Enriching ${job.companyName} (${i + 1}/${toEnrich.length})...`,
        percent,
        current: i + 1,
        total: toEnrich.length,
      });
    }

    try {
      const lead = await enrichCompany(job);
      leads.push(lead);
      stats.enriched++;
      if (lead.phone) stats.withPhone++;
      if (lead.email) stats.withEmail++;
      if (lead.website) stats.withWebsite++;
      if (lead.locationMatchConfidence !== null && lead.locationMatchConfidence < 0.3) {
        stats.lowConfidenceMatches++;
      }
    } catch (e) {
      console.error(`[Pipeline] Failed to enrich ${job.companyName}:`, e.message);
      // Push a partial lead with what we have from Indeed
      leads.push({
        companyName: job.companyName,
        jobTitle: job.title,
        jobLocation: job.location,
        jobSalary: job.salary || null,
        jobSnippet: job.snippet || null,
        indeedUrl: job.jobUrl || null,
        phone: null, email: null, website: null, address: null,
        googleMapsUrl: null, rating: null, reviewCount: null,
        industry: inferIndustry(job, null),
        businessStatus: null, hours: null, socialLinks: {},
        techStack: [], fitScore: 20, locationMatchConfidence: null,
        enrichedAt: new Date().toISOString(),
        enrichmentSources: ["indeed_only"],
        enrichmentTimeMs: 0,
        warnings: ["Enrichment failed — Indeed data only"],
      });
      stats.enriched++;
    }

    // Pacing between companies
    if (i < toEnrich.length - 1) {
      await delay(300 + Math.random() * 400);
    }
  }

  // Stats
  if (leads.length > 0) {
    stats.avgFitScore = Math.round(leads.reduce((sum, l) => sum + l.fitScore, 0) / leads.length);
  }

  leads.sort((a, b) => b.fitScore - a.fitScore);

  stats.endTime = Date.now();
  stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);

  console.log(`[Pipeline] Complete — ${leads.length} leads in ${stats.durationSeconds}s (${stats.lowConfidenceMatches} low-confidence)`);

  return { leads, stats };
}

module.exports = { runPipeline, enrichCompany, calculateFitScore };