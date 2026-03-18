/**
 * Lead Enrichment Pipeline
 * Orchestrates: Indeed Scrape → Google Places → Website Scrape → Scoring
 * 
 * Takes search params, runs the full pipeline, and returns enriched leads
 * with a "fit score" indicating how likely the business needs an AI receptionist.
 */

const { scrapeIndeed } = require("./indeed-scraper");
const { enrichFromPlaces } = require("./places-enricher");
const { scrapeWebsite } = require("./website-scraper");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Job titles that indicate high need for AI receptionist
const HIGH_FIT_TITLES = [
  "receptionist",
  "front desk",
  "office manager",
  "office administrator",
  "administrative assistant",
  "secretary",
  "customer service",
  "phone operator",
  "call center",
  "intake coordinator",
  "appointment scheduler",
  "patient coordinator",
  "dental receptionist",
  "medical receptionist",
  "legal receptionist",
  "veterinary receptionist",
];

// Industries that commonly need AI receptionists
const HIGH_FIT_INDUSTRIES = [
  "dentist",
  "dental",
  "doctor",
  "medical",
  "health",
  "veterinary",
  "vet",
  "law",
  "legal",
  "attorney",
  "plumbing",
  "plumber",
  "hvac",
  "heating",
  "roofing",
  "contractor",
  "real_estate",
  "insurance",
  "salon",
  "spa",
  "auto_repair",
  "car_dealer",
  "accounting",
  "chiropract",
  "physiotherap",
  "moving",
  "landscap",
  "pest_control",
  "electrician",
  "cleaning",
];

/**
 * Calculate a fit score (0-100) for how likely this business needs an AI receptionist
 */
function calculateFitScore(job, placesData, websiteData) {
  let score = 30; // Base score — they're hiring, so they have some need

  // Job title match
  const titleLower = job.title.toLowerCase();
  const isHighFitTitle = HIGH_FIT_TITLES.some((t) => titleLower.includes(t));
  if (isHighFitTitle) score += 30;

  // If they're hiring for receptionist/front desk specifically, that's the strongest signal
  if (titleLower.includes("receptionist") || titleLower.includes("front desk")) {
    score += 15;
  }

  // Industry match from Google Places types
  if (placesData?.businessTypes) {
    const typesStr = placesData.businessTypes.join(" ").toLowerCase();
    const isHighFitIndustry = HIGH_FIT_INDUSTRIES.some((ind) => typesStr.includes(ind));
    if (isHighFitIndustry) score += 10;
  }

  // Small/medium business indicators
  if (placesData?.reviewCount) {
    // SMBs typically have 5-200 reviews. These are the sweet spot.
    if (placesData.reviewCount >= 5 && placesData.reviewCount <= 200) {
      score += 5;
    }
  }

  // Active/operational business
  if (placesData?.businessStatus === "OPERATIONAL") {
    score += 5;
  }

  // Has a website (can look professional, but might need help with phone handling)
  if (placesData?.website || websiteData?.phones?.length) {
    score += 5;
  }

  // Tech stack — WordPress/Wix/Squarespace sites are often run by less tech-savvy businesses
  if (websiteData?.techStack?.length) {
    const stack = websiteData.techStack.join(" ").toLowerCase();
    if (stack.includes("wordpress") || stack.includes("wix") || stack.includes("squarespace")) {
      score += 5;
    }
  }

  return Math.min(score, 100);
}

/**
 * Determine a human-readable industry label from available data
 */
function inferIndustry(job, placesData) {
  // Check Google Places types first
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
    if (types.some((t) => t.includes("plumber") || t.includes("electrician"))) return "Home Services";
    if (types.some((t) => t.includes("lodging"))) return "Hospitality";
    if (types.some((t) => t.includes("store") || t.includes("shop"))) return "Retail";
  }

  // Fall back to job title/snippet inference
  const text = `${job.title} ${job.snippet}`.toLowerCase();
  if (/dental|dentist/.test(text)) return "Dental";
  if (/medical|doctor|clinic|hospital|patient/.test(text)) return "Healthcare";
  if (/veterinar|vet|animal/.test(text)) return "Veterinary";
  if (/law|legal|attorney|paralegal/.test(text)) return "Legal";
  if (/salon|beauty|spa|hair/.test(text)) return "Beauty & Wellness";
  if (/plumb|hvac|roof|electri|landscap|contract/.test(text)) return "Home Services";
  if (/real estate|property|realt/.test(text)) return "Real Estate";
  if (/insurance/.test(text)) return "Insurance";
  if (/auto|car|mechanic|body shop/.test(text)) return "Automotive";

  return "Other";
}

/**
 * Run the full enrichment pipeline for a single company
 */
async function enrichCompany(job) {
  const lead = {
    // From Indeed
    companyName: job.companyName,
    jobTitle: job.title,
    jobLocation: job.location,
    jobSalary: job.salary || null,
    jobSnippet: job.snippet || null,
    indeedUrl: job.jobUrl || null,

    // From enrichment (will be filled in)
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

    // Metadata
    enrichedAt: new Date().toISOString(),
    enrichmentSources: [],
  };

  // Step 1: Google Places enrichment
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
    }
  } catch (e) {
    console.error(`[Pipeline] Places enrichment failed for ${job.companyName}:`, e.message);
  }

  // Step 2: Website scrape (if we have a URL)
  let websiteData = null;
  const websiteUrl = placesData?.website || null;
  if (websiteUrl) {
    try {
      await delay(500);
      websiteData = await scrapeWebsite(websiteUrl);
      if (websiteData) {
        lead.enrichmentSources.push("website_scrape");

        // Fill in missing data from website
        if (!lead.phone && websiteData.phones?.length) {
          lead.phone = websiteData.phones[0];
        }
        if (websiteData.emails?.length) {
          lead.email = websiteData.emails[0];
        }
        if (Object.keys(websiteData.socialLinks || {}).length) {
          lead.socialLinks = websiteData.socialLinks;
        }
        if (websiteData.techStack?.length) {
          lead.techStack = websiteData.techStack;
        }
      }
    } catch (e) {
      console.error(`[Pipeline] Website scrape failed for ${websiteUrl}:`, e.message);
    }
  }

  // Step 3: Scoring and classification
  lead.industry = inferIndustry(job, placesData);
  lead.fitScore = calculateFitScore(job, placesData, websiteData);

  return lead;
}

/**
 * Main pipeline entry point
 * @param {Object} params
 * @param {string} params.keywords - Indeed search keywords
 * @param {string} params.location - Location
 * @param {number} params.maxPages - Max Indeed pages to scrape (default 1)
 * @param {number} params.maxLeads - Max leads to enrich (default 25)
 * @param {Function} params.onProgress - Progress callback (optional)
 * @returns {Object} { leads, stats }
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
    startTime: Date.now(),
    endTime: null,
  };

  // Stage 1: Scrape Indeed
  if (onProgress) onProgress({ stage: "indeed", message: "Searching Indeed...", percent: 5 });

  const jobs = await scrapeIndeed({ keywords, location, maxPages });
  stats.indeedJobsFound = jobs.length;
  stats.uniqueCompanies = jobs.length;

  if (jobs.length === 0) {
    return { leads: [], stats };
  }

  // Limit to maxLeads
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

    const lead = await enrichCompany(job);
    leads.push(lead);
    stats.enriched++;

    if (lead.phone) stats.withPhone++;
    if (lead.email) stats.withEmail++;
    if (lead.website) stats.withWebsite++;

    // Pacing between companies
    if (i < toEnrich.length - 1) {
      await delay(300 + Math.random() * 500);
    }
  }

  // Calculate average fit score
  if (leads.length > 0) {
    stats.avgFitScore = Math.round(
      leads.reduce((sum, l) => sum + l.fitScore, 0) / leads.length
    );
  }

  // Sort by fit score (highest first)
  leads.sort((a, b) => b.fitScore - a.fitScore);

  stats.endTime = Date.now();
  stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);

  console.log(`[Pipeline] Complete — ${leads.length} leads enriched in ${stats.durationSeconds}s`);

  return { leads, stats };
}

module.exports = { runPipeline, enrichCompany, calculateFitScore };