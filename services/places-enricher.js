/**
 * Google Places Enrichment Service
 * Uses Google Places API to find business details from company name + location
 * 
 * This is the most reliable path for local businesses since they almost always
 * have a Google Business Profile. One API call gets website, phone, address, 
 * hours, rating, and business type.
 * 
 * Requires GOOGLE_PLACES_API_KEY env var
 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

/**
 * Search for a business using Google Places Text Search
 * @param {string} companyName 
 * @param {string} location - City/state from Indeed
 * @returns {Object|null} Place result with place_id
 */
async function searchPlace(companyName, location) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY not set");

  const query = `${companyName} ${location}`;
  const url = `${PLACES_BASE}/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK" || !data.results?.length) {
      console.log(`[Places] No results for: ${query}`);
      return null;
    }

    // Return the top result — usually correct for "{business name} {city}"
    return data.results[0];
  } catch (error) {
    console.error(`[Places] Search failed for ${query}:`, error.message);
    return null;
  }
}

/**
 * Get detailed info for a place using Place Details API
 * This is where we get phone number, website, hours, etc.
 * @param {string} placeId - Google Place ID from search
 * @returns {Object|null} Detailed place info
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
    "url",               // Google Maps URL
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

    if (data.status !== "OK" || !data.result) {
      console.log(`[Places] No details for place_id: ${placeId}`);
      return null;
    }

    return data.result;
  } catch (error) {
    console.error(`[Places] Details failed for ${placeId}:`, error.message);
    return null;
  }
}

/**
 * Full enrichment: search + details in one call
 * @param {string} companyName 
 * @param {string} location 
 * @returns {Object} Enriched company data
 */
async function enrichFromPlaces(companyName, location) {
  const result = {
    source: "google_places",
    phone: null,
    phoneInternational: null,
    website: null,
    address: null,
    googleMapsUrl: null,
    rating: null,
    reviewCount: null,
    businessStatus: null,
    businessTypes: [],
    hours: null,
    matchedName: null,
  };

  try {
    // Step 1: Text search to find the business
    const place = await searchPlace(companyName, location);
    if (!place) return result;

    result.matchedName = place.name;
    result.address = place.formatted_address;
    result.rating = place.rating || null;
    result.reviewCount = place.user_ratings_total || null;
    result.businessTypes = place.types || [];

    // Step 2: Get detailed info (phone, website, hours)
    await delay(200); // Slight delay between calls
    const details = await getPlaceDetails(place.place_id);
    if (!details) return result;

    result.phone = details.formatted_phone_number || null;
    result.phoneInternational = details.international_phone_number || null;
    result.website = details.website || null;
    result.googleMapsUrl = details.url || null;
    result.businessStatus = details.business_status || null;
    result.matchedName = details.name || result.matchedName;

    // Parse hours into readable format
    if (details.opening_hours?.weekday_text) {
      result.hours = details.opening_hours.weekday_text;
    }

    return result;
  } catch (error) {
    console.error(`[Places] Enrichment failed for ${companyName}:`, error.message);
    return result;
  }
}

/**
 * Batch enrich multiple companies with rate limiting
 * @param {Array} companies - Array of { companyName, location }
 * @param {number} delayMs - Delay between API calls (default 300ms)
 * @returns {Map} Map of companyName -> enrichment data
 */
async function batchEnrichFromPlaces(companies, delayMs = 300) {
  const results = new Map();

  for (let i = 0; i < companies.length; i++) {
    const { companyName, location } = companies[i];
    console.log(`[Places] Enriching ${i + 1}/${companies.length}: ${companyName}`);

    const enriched = await enrichFromPlaces(companyName, location);
    results.set(companyName, enriched);

    // Rate limit spacing
    if (i < companies.length - 1) {
      await delay(delayMs + Math.random() * 200);
    }
  }

  return results;
}

module.exports = { enrichFromPlaces, batchEnrichFromPlaces, searchPlace, getPlaceDetails };