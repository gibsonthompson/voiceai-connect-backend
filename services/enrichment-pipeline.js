/**
 * Lead Enrichment Pipeline v3
 * 
 * Supports two sources:
 * - Indeed: scrape jobs → Places enrichment → website scrape → score
 * - Google Maps: Places search → Place Details → website scrape → score
 * 
 * Both flows converge into the same enrichment + scoring logic.
 */

const { scrapeIndeed } = require("./indeed-scraper");
const { searchGoogleMaps, getPlaceDetails: getMapsPlaceDetails } = require("./google-maps-source");
const { enrichFromPlaces } = require("./places-enricher");
const { scrapeWebsite } = require("./website-scraper");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const HIGH_FIT_TITLES = [
  "receptionist", "front desk", "office manager", "office administrator",
  "administrative assistant", "secretary", "customer service",
  "phone operator", "call center", "intake coordinator",
  "appointment scheduler", "patient coordinator", "dental receptionist",
  "medical receptionist", "legal receptionist", "veterinary receptionist",
  "office coordinator", "front office", "scheduling coordinator",
];

const HIGH_FIT_INDUSTRIES = [
  "dentist", "dental", "doctor", "medical", "health", "veterinary", "vet",
  "law", "legal", "attorney", "plumbing", "plumber", "hvac", "heating",
  "roofing", "contractor", "real_estate", "insurance", "salon", "spa",
  "auto_repair", "car_dealer", "accounting", "chiropract", "physiotherap",
  "moving", "landscap", "pest_control", "electrician", "cleaning",
  "optometrist", "orthodont", "dermatolog", "pediatr", "therapy",
  "counseling", "funeral", "mortuary", "storage", "towing",
];

function calculateFitScore(lead, placesData, websiteData, source) {
  let score = 0;

  if (source === "indeed") {
    score += 30;
    const titleLower = (lead.jobTitle || "").toLowerCase();
    if (HIGH_FIT_TITLES.some((t) => titleLower.includes(t))) score += 30;
    if (titleLower.includes("receptionist") || titleLower.includes("front desk")) score += 15;
  } else if (source === "google_maps") {
    score += 25;
  }

  const typesStr = (placesData?.businessTypes || lead._businessTypes || []).join(" ").toLowerCase();
  if (HIGH_FIT_INDUSTRIES.some((ind) => typesStr.includes(ind))) {
    score += source === "google_maps" ? 20 : 10;
  }

  const reviewCount = placesData?.reviewCount || lead._reviewCount || 0;
  if (reviewCount >= 5 && reviewCount <= 200) score += 5;

  const status = placesData?.businessStatus || lead._businessStatus;
  if (status === "OPERATIONAL") score += 5;

  if (placesData?.website || websiteData?.phones?.length) score += 5;

  if (websiteData?.techStack?.length) {
    const stack = websiteData.techStack.join(" ").toLowerCase();
    if (stack.includes("wordpress") || stack.includes("wix") || stack.includes("squarespace")) score += 5;
  }

  if (placesData?.locationMatchScore !== undefined && placesData.locationMatchScore < 0.3) score -= 15;

  return Math.max(0, Math.min(score, 100));
}

function inferIndustry(data, placesData) {
  const types = placesData?.businessTypes || data._businessTypes || [];
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
  if (types.some((t) => t.includes("gym") || t.includes("fitness"))) return "Fitness";
  if (types.some((t) => t.includes("storage"))) return "Storage";

  const text = `${data.jobTitle || ""} ${data.jobSnippet || ""} ${data.companyName || ""}`.toLowerCase();
  if (/dental|dentist/.test(text)) return "Dental";
  if (/medical|doctor|clinic|hospital|patient/.test(text)) return "Healthcare";
  if (/veterinar|vet|animal/.test(text)) return "Veterinary";
  if (/law|legal|attorney|paralegal/.test(text)) return "Legal";
  if (/salon|beauty|spa|hair|nail/.test(text)) return "Beauty & Wellness";
  if (/plumb|hvac|roof|electri|landscap|contract/.test(text)) return "Home Services";
  if (/real estate|property|realt|mortgage/.test(text)) return "Real Estate";
  if (/insurance|claims/.test(text)) return "Insurance";
  if (/auto|car|mechanic|body shop/.test(text)) return "Automotive";
  if (/accounting|tax|bookkeep|cpa/.test(text)) return "Accounting";
  return "Other";
}

async function enrichWebsite(lead) {
  if (!lead.website) return null;
  try {
    const data = await scrapeWebsite(lead.website);
    if (data) {
      if (!lead.phone && data.phones?.length) lead.phone = data.phones[0];
      if (data.emails?.length) lead.email = data.emails[0];
      if (Object.keys(data.socialLinks || {}).length) lead.socialLinks = data.socialLinks;
      if (data.techStack?.length) lead.techStack = data.techStack;
      lead.enrichmentSources.push("website_scrape");
    }
    return data;
  } catch (e) {
    console.error(`[Pipeline] Website scrape failed:`, e.message);
    return null;
  }
}

// ── Indeed enrichment ───────────────────────────────────────────────────
async function enrichFromIndeedSource(job) {
  const startTime = Date.now();
  const lead = {
    companyName: job.companyName, jobTitle: job.title, jobLocation: job.location,
    jobSalary: job.salary || null, jobSnippet: job.snippet || null,
    indeedUrl: job.jobUrl || null,
    phone: null, email: null, website: null, address: null,
    googleMapsUrl: null, rating: null, reviewCount: null,
    industry: null, businessStatus: null, hours: null,
    socialLinks: {}, techStack: [], fitScore: 0,
    locationMatchConfidence: null, enrichedAt: new Date().toISOString(),
    enrichmentSources: ["indeed"], enrichmentTimeMs: 0,
    warnings: [], leadSource: "indeed",
  };

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
      if (placesData.locationMatchScore < 0.3) lead.warnings.push("Low location match — may be a different branch");
    }
  } catch (e) {
    console.error(`[Pipeline] Places failed for ${job.companyName}:`, e.message);
  }

  const websiteData = await enrichWebsite(lead);
  lead.industry = inferIndustry(lead, placesData);
  lead.fitScore = calculateFitScore(lead, placesData, websiteData, "indeed");
  lead.enrichmentTimeMs = Date.now() - startTime;
  return lead;
}

// ── Google Maps enrichment ──────────────────────────────────────────────
async function enrichFromMapsSource(business) {
  const startTime = Date.now();
  const lead = {
    companyName: business.companyName, jobTitle: null,
    jobLocation: business.address || business.location,
    jobSalary: null, jobSnippet: null, indeedUrl: null,
    phone: null, email: null, website: null,
    address: business.address || null, googleMapsUrl: null,
    rating: business.rating || null, reviewCount: business.reviewCount || null,
    industry: null, businessStatus: business.businessStatus || null, hours: null,
    socialLinks: {}, techStack: [], fitScore: 0,
    locationMatchConfidence: 1.0, enrichedAt: new Date().toISOString(),
    enrichmentSources: ["google_maps"], enrichmentTimeMs: 0,
    warnings: [], leadSource: "google_maps",
    _businessTypes: business.businessTypes || [],
    _reviewCount: business.reviewCount, _businessStatus: business.businessStatus,
  };

  if (business.placeId) {
    try {
      const details = await getMapsPlaceDetails(business.placeId);
      if (details) {
        lead.phone = details.formatted_phone_number || null;
        lead.website = details.website || null;
        lead.googleMapsUrl = details.url || null;
        lead.businessStatus = details.business_status || lead.businessStatus;
        if (details.opening_hours?.weekday_text) lead.hours = details.opening_hours.weekday_text;
      }
    } catch (e) {
      console.error(`[Pipeline] Place Details failed for ${business.companyName}:`, e.message);
    }
  }

  const websiteData = await enrichWebsite(lead);
  lead.industry = inferIndustry(lead, { businessTypes: business.businessTypes });
  lead.fitScore = calculateFitScore(lead, null, websiteData, "google_maps");
  lead.enrichmentTimeMs = Date.now() - startTime;

  delete lead._businessTypes;
  delete lead._reviewCount;
  delete lead._businessStatus;
  return lead;
}

// ── Pipeline runners ────────────────────────────────────────────────────

async function runIndeedPipeline({ keywords, location, maxPages = 1, maxLeads = 25, onProgress }) {
  const stats = {
    source: "indeed", jobsFound: 0, uniqueCompanies: 0, enriched: 0,
    withPhone: 0, withEmail: 0, withWebsite: 0,
    avgFitScore: 0, lowConfidenceMatches: 0, startTime: Date.now(), endTime: null,
  };

  if (onProgress) onProgress({ stage: "indeed", message: "Searching Indeed...", percent: 5 });

  let jobs;
  try { jobs = await scrapeIndeed({ keywords, location, maxPages }); }
  catch (error) { throw new Error(`Indeed search failed: ${error.message}`); }

  stats.jobsFound = jobs.length;
  stats.uniqueCompanies = jobs.length;
  if (jobs.length === 0) return { leads: [], stats };

  const toEnrich = jobs.slice(0, maxLeads);
  const leads = [];

  for (let i = 0; i < toEnrich.length; i++) {
    const job = toEnrich[i];
    if (onProgress) {
      onProgress({
        stage: "enriching",
        message: `Enriching ${job.companyName} (${i + 1}/${toEnrich.length})...`,
        percent: 10 + Math.round((i / toEnrich.length) * 85),
        current: i + 1, total: toEnrich.length,
      });
    }

    try {
      const lead = await enrichFromIndeedSource(job);
      leads.push(lead);
      stats.enriched++;
      if (lead.phone) stats.withPhone++;
      if (lead.email) stats.withEmail++;
      if (lead.website) stats.withWebsite++;
      if (lead.locationMatchConfidence !== null && lead.locationMatchConfidence < 0.3) stats.lowConfidenceMatches++;
    } catch (e) {
      leads.push({
        companyName: job.companyName, jobTitle: job.title, jobLocation: job.location,
        phone: null, email: null, website: null, address: null, googleMapsUrl: null,
        rating: null, reviewCount: null, industry: inferIndustry(job, null),
        businessStatus: null, hours: null, socialLinks: {}, techStack: [],
        fitScore: 20, locationMatchConfidence: null, enrichedAt: new Date().toISOString(),
        enrichmentSources: ["indeed_only"], enrichmentTimeMs: 0,
        warnings: ["Enrichment failed — Indeed data only"], leadSource: "indeed",
      });
      stats.enriched++;
    }
    if (i < toEnrich.length - 1) await delay(300 + Math.random() * 400);
  }

  if (leads.length > 0) stats.avgFitScore = Math.round(leads.reduce((s, l) => s + l.fitScore, 0) / leads.length);
  leads.sort((a, b) => b.fitScore - a.fitScore);
  stats.endTime = Date.now();
  stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);
  return { leads, stats };
}

async function runGoogleMapsPipeline({ query, location, industry, maxPages = 1, maxLeads = 25, onProgress }) {
  const stats = {
    source: "google_maps", businessesFound: 0, uniqueCompanies: 0, enriched: 0,
    withPhone: 0, withEmail: 0, withWebsite: 0,
    avgFitScore: 0, startTime: Date.now(), endTime: null,
  };

  if (onProgress) onProgress({ stage: "google_maps", message: "Searching Google Maps...", percent: 5 });

  let businesses;
  try { businesses = await searchGoogleMaps({ query, location, industry, maxPages }); }
  catch (error) { throw new Error(`Google Maps search failed: ${error.message}`); }

  stats.businessesFound = businesses.length;
  stats.uniqueCompanies = businesses.length;
  if (businesses.length === 0) return { leads: [], stats };

  const toEnrich = businesses.slice(0, maxLeads);
  const leads = [];

  for (let i = 0; i < toEnrich.length; i++) {
    const biz = toEnrich[i];
    if (onProgress) {
      onProgress({
        stage: "enriching",
        message: `Enriching ${biz.companyName} (${i + 1}/${toEnrich.length})...`,
        percent: 10 + Math.round((i / toEnrich.length) * 85),
        current: i + 1, total: toEnrich.length,
      });
    }

    try {
      const lead = await enrichFromMapsSource(biz);
      leads.push(lead);
      stats.enriched++;
      if (lead.phone) stats.withPhone++;
      if (lead.email) stats.withEmail++;
      if (lead.website) stats.withWebsite++;
    } catch (e) {
      leads.push({
        companyName: biz.companyName, jobTitle: null, jobLocation: biz.address,
        phone: null, email: null, website: null, address: biz.address,
        googleMapsUrl: null, rating: biz.rating, reviewCount: biz.reviewCount,
        industry: inferIndustry(biz, { businessTypes: biz.businessTypes }),
        businessStatus: biz.businessStatus, hours: null, socialLinks: {}, techStack: [],
        fitScore: 15, locationMatchConfidence: 1.0, enrichedAt: new Date().toISOString(),
        enrichmentSources: ["google_maps_only"], enrichmentTimeMs: 0,
        warnings: ["Enrichment failed — Maps data only"], leadSource: "google_maps",
      });
      stats.enriched++;
    }
    if (i < toEnrich.length - 1) await delay(300 + Math.random() * 300);
  }

  if (leads.length > 0) stats.avgFitScore = Math.round(leads.reduce((s, l) => s + l.fitScore, 0) / leads.length);
  leads.sort((a, b) => b.fitScore - a.fitScore);
  stats.endTime = Date.now();
  stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);
  return { leads, stats };
}

async function runPipeline({ source = "indeed", ...params }) {
  if (source === "google_maps") return runGoogleMapsPipeline(params);
  return runIndeedPipeline(params);
}

module.exports = { runPipeline, enrichFromIndeedSource, enrichFromMapsSource, calculateFitScore };