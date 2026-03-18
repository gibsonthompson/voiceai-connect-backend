/**
 * Google Maps Source Service
 * 
 * Searches Google Places API by industry/category + location.
 * Unlike Indeed (which finds businesses actively hiring), this finds
 * businesses in target verticals directly — dentists, plumbers, lawyers, etc.
 * 
 * No Puppeteer needed — purely API-driven.
 * Returns up to 60 results per query (20 per page, 3 pages via next_page_token).
 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

// Industry presets mapped to Google Places search queries
const INDUSTRY_QUERIES = {
  dental: "dental office",
  medical: "medical clinic doctor office",
  veterinary: "veterinary clinic animal hospital",
  legal: "law firm attorney office",
  "home_services": "plumber hvac contractor",
  plumbing: "plumber plumbing company",
  hvac: "hvac heating cooling company",
  roofing: "roofing company",
  electrical: "electrician electrical contractor",
  landscaping: "landscaping company lawn care",
  "pest_control": "pest control exterminator",
  "real_estate": "real estate agency realtor office",
  insurance: "insurance agency office",
  accounting: "accounting firm cpa tax",
  "beauty_salon": "hair salon beauty spa",
  automotive: "auto repair mechanic shop",
  chiropractic: "chiropractor chiropractic",
  therapy: "therapy counseling therapist office",
  optometry: "optometrist eye doctor",
  "moving_storage": "moving company storage facility",
  "property_management": "property management company",
  "funeral": "funeral home mortuary",
  "cleaning": "cleaning service janitorial",
  towing: "towing company",
};

/**
 * Search Google Places by query + location
 * Supports pagination via next_page_token (up to 3 pages = 60 results)
 * 
 * @param {Object} params
 * @param {string} params.query - Search query (industry or custom)
 * @param {string} params.location - City/state (e.g., "Atlanta, GA")
 * @param {string} params.industry - Industry preset key (optional, overrides query)
 * @param {number} params.maxPages - Max pages to fetch (1-3, default 1)
 * @returns {Array} Array of place objects with basic data
 */
async function searchGoogleMaps({ query, location, industry, maxPages = 1 }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY not set");

  // Build search query
  let searchQuery = query;
  if (industry && INDUSTRY_QUERIES[industry]) {
    searchQuery = INDUSTRY_QUERIES[industry];
  }
  const fullQuery = `${searchQuery} ${location}`;

  console.log(`[GoogleMaps] Searching: "${fullQuery}" (max ${maxPages} pages)`);

  let allResults = [];
  let nextPageToken = null;
  const maxPagesClamp = Math.min(maxPages, 3);

  for (let page = 0; page < maxPagesClamp; page++) {
    let url = `${PLACES_BASE}/textsearch/json?query=${encodeURIComponent(fullQuery)}&key=${apiKey}`;

    if (nextPageToken) {
      url = `${PLACES_BASE}/textsearch/json?pagetoken=${nextPageToken}&key=${apiKey}`;
    }

    try {
      const res = await fetch(url);
      const data = await res.json();

      if (data.status === "REQUEST_DENIED") {
        throw new Error(`Google Places API denied: ${data.error_message || "Check API key"}`);
      }

      if (data.status === "OVER_QUERY_LIMIT") {
        console.warn("[GoogleMaps] Rate limited — stopping pagination");
        break;
      }

      if (data.status !== "OK" || !data.results?.length) {
        console.log(`[GoogleMaps] No results on page ${page + 1} (status: ${data.status})`);
        break;
      }

      // Filter out results that are permanently closed
      const validResults = data.results.filter(
        (r) => r.business_status !== "CLOSED_PERMANENTLY"
      );

      allResults = allResults.concat(validResults);
      console.log(`[GoogleMaps] Page ${page + 1}: ${validResults.length} results`);

      // Check for next page
      nextPageToken = data.next_page_token || null;
      if (!nextPageToken) break;

      // Google requires a short delay before using next_page_token
      if (page < maxPagesClamp - 1) {
        await delay(2000);
      }
    } catch (error) {
      console.error(`[GoogleMaps] Search failed on page ${page + 1}:`, error.message);
      if (page === 0) throw error; // First page fail is fatal
      break; // Later pages — return what we have
    }
  }

  // Deduplicate by place_id
  const seen = new Set();
  const deduped = [];
  for (const result of allResults) {
    if (!seen.has(result.place_id)) {
      seen.add(result.place_id);
      deduped.push(result);
    }
  }

  console.log(`[GoogleMaps] Total: ${deduped.length} unique businesses`);

  // Map to our standard format
  return deduped.map((r) => ({
    companyName: r.name,
    address: r.formatted_address,
    location: r.formatted_address, // For pipeline compatibility
    placeId: r.place_id,
    rating: r.rating || null,
    reviewCount: r.user_ratings_total || null,
    businessStatus: r.business_status || null,
    businessTypes: r.types || [],
    // These will be filled by Place Details in enrichment
    phone: null,
    website: null,
    source: "google_maps",
  }));
}

/**
 * Get Place Details for a single place (phone, website, hours)
 * This is the same call as places-enricher but structured for the Maps source flow
 */
async function getPlaceDetails(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY not set");

  const fields = [
    "name",
    "formatted_address",
    "formatted_phone_number",
    "international_phone_number",
    "website",
    "url",
    "types",
    "business_status",
    "rating",
    "user_ratings_total",
    "opening_hours",
  ].join(",");

  const url = `${PLACES_BASE}/details/json?place_id=${placeId}&fields=${fields}&key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK" || !data.result) return null;
    return data.result;
  } catch (error) {
    console.error(`[GoogleMaps] Details failed for ${placeId}:`, error.message);
    return null;
  }
}

module.exports = { searchGoogleMaps, getPlaceDetails, INDUSTRY_QUERIES };