/**
 * Google Places Enrichment Service v2
 * 
 * Fixes applied:
 * - Location match validation (compares returned city/state against expected)
 * - Retry with backoff on transient API failures (OVER_QUERY_LIMIT, etc.)
 * - Match confidence score so pipeline can flag questionable matches
 * - Better error isolation (one failed lookup doesn't kill the batch)
 * - Request spacing respects Google's rate limits
 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";
const MAX_RETRIES = 2;

/**
 * Normalize a location string for comparison
 * "Atlanta, GA 30301" → "atlanta ga"
 */
function normalizeLocation(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/\d{5}(-\d{4})?/g, "") // Remove zip codes
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .replace(/united states|usa|us$/i, "")
    .trim();
}

/**
 * Calculate how well the returned address matches the expected location
 * Returns 0-1 confidence score
 */
function locationMatchScore(expectedLocation, returnedAddress) {
  if (!expectedLocation || !returnedAddress) return 0.5; // No data to compare

  const expected = normalizeLocation(expectedLocation);
  const returned = normalizeLocation(returnedAddress);

  if (!expected || !returned) return 0.5;

  // Extract city and state from expected
  const expectedParts = expected.split(" ").filter(Boolean);

  let matched = 0;
  for (const part of expectedParts) {
    if (part.length < 2) continue;
    if (returned.includes(part)) matched++;
  }

  if (expectedParts.length === 0) return 0.5;
  return matched / expectedParts.length;
}

/**
 * Fetch with retry for transient Google API errors
 */
async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      const data = await res.json();

      // Retry on rate limit
      if (data.status === "OVER_QUERY_LIMIT" && attempt < retries) {
        console.log(`[Places] Rate limited — retrying in ${(attempt + 1) * 2}s`);
        await delay((attempt + 1) * 2000);
        continue;
      }

      // Retry on unknown error
      if (data.status === "UNKNOWN_ERROR" && attempt < retries) {
        console.log(`[Places] Unknown error — retrying in ${(attempt + 1) * 1}s`);
        await delay((attempt + 1) * 1000);
        continue;
      }

      return data;
    } catch (error) {
      if (attempt < retries) {
        console.log(`[Places] Network error — retrying: ${error.message}`);
        await delay((attempt + 1) * 1000);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Search for a business using Google Places Text Search
 */
async function searchPlace(companyName, location) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY not set");

  const query = `${companyName} ${location}`;
  const url = `${PLACES_BASE}/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;

  try {
    const data = await fetchWithRetry(url);

    if (data.status === "REQUEST_DENIED") {
      throw new Error(`Google Places API denied: ${data.error_message || "Check API key"}`);
    }

    if (data.status !== "OK" || !data.results?.length) {
      console.log(`[Places] No results for: ${query} (status: ${data.status})`);
      return null;
    }

    // Score the top results by location match and pick the best
    const expectedLocation = location;
    let bestMatch = null;
    let bestScore = -1;

    for (const result of data.results.slice(0, 3)) {
      const score = locationMatchScore(expectedLocation, result.formatted_address);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = result;
      }
    }

    if (bestMatch) {
      bestMatch._locationMatchScore = bestScore;
    }

    return bestMatch;
  } catch (error) {
    console.error(`[Places] Search failed for ${query}:`, error.message);
    return null;
  }
}

/**
 * Get detailed info for a place using Place Details API
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
    const data = await fetchWithRetry(url);

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
 * Returns enriched data with a location match confidence score
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
    locationMatchScore: 0,
  };

  try {
    const place = await searchPlace(companyName, location);
    if (!place) return result;

    result.matchedName = place.name;
    result.address = place.formatted_address;
    result.rating = place.rating || null;
    result.reviewCount = place.user_ratings_total || null;
    result.businessTypes = place.types || [];
    result.locationMatchScore = place._locationMatchScore || 0;

    await delay(250);
    const details = await getPlaceDetails(place.place_id);
    if (!details) return result;

    result.phone = details.formatted_phone_number || null;
    result.phoneInternational = details.international_phone_number || null;
    result.website = details.website || null;
    result.googleMapsUrl = details.url || null;
    result.businessStatus = details.business_status || null;
    result.matchedName = details.name || result.matchedName;

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
 */
async function batchEnrichFromPlaces(companies, delayMs = 350) {
  const results = new Map();

  for (let i = 0; i < companies.length; i++) {
    const { companyName, location } = companies[i];
    console.log(`[Places] Enriching ${i + 1}/${companies.length}: ${companyName}`);

    const enriched = await enrichFromPlaces(companyName, location);
    results.set(companyName, enriched);

    if (i < companies.length - 1) {
      await delay(delayMs + Math.random() * 200);
    }
  }

  return results;
}

module.exports = { enrichFromPlaces, batchEnrichFromPlaces, searchPlace, getPlaceDetails };