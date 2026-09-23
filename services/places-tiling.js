/**
 * Places Tiling - exhaustive area search for the Lead Finder "Find all" mode.
 *
 * Google Places caps any single query at 60 results, so to pull every business
 * of a type in a market we tile the area into rectangles, run a Text Search
 * (New) per tile, and adaptively subdivide any tile that comes back saturated
 * (a full 60, meaning more exist inside it). Results are deduplicated by
 * place_id. This is location-agnostic: it works for any city, county, or region
 * worldwide that the Geocoding API can resolve to a bounding box.
 *
 * The Text Search (New) field mask deliberately requests contact, rating and
 * hours but NOT reviews or photos, which keeps each call in the Enterprise SKU
 * tier (about $35 / 1,000) rather than the pricier Atmosphere tier. Because the
 * search already returns phone and website, the downstream pipeline skips the
 * per-business Place Details call it makes for a standard search.
 *
 * Requires the Geocoding API and the Places API (New) to be enabled on the
 * Google Cloud project for the configured key.
 */

const { INDUSTRY_QUERIES } = require("./google-maps-source");

const GEOCODE_BASE = "https://maps.googleapis.com/maps/api/geocode/json";
const PLACES_SEARCHTEXT = "https://places.googleapis.com/v1/places:searchText";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiling guardrails
const TILE_KM = 8;            // target size of an initial grid cell
const MAX_INITIAL_GRID = 6;   // cap the initial grid at 6x6 before subdividing
const MIN_TILE_KM = 0.6;      // never subdivide a tile smaller than this
const MAX_TILES = 350;        // hard ceiling on tiles searched per job (cost guard)
const PAGES_PER_TILE = 3;     // Google allows 3 pages (60 results) per query
const PAGE_SIZE = 20;

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  "places.googleMapsUri",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.regularOpeningHours.weekdayDescriptions",
  "nextPageToken",
].join(",");

function getApiKey() {
  const key = process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY not set");
  return key;
}

// Planar distance helpers. Accurate enough at city / region scale, where the
// tiles are small relative to the curvature of the earth.
function kmPerDegLat() { return 111.32; }
function kmPerDegLng(lat) { return 111.32 * Math.cos((lat * Math.PI) / 180); }

function rectSizeKm(rect) {
  const midLat = (rect.south + rect.north) / 2;
  const widthKm = Math.abs(rect.east - rect.west) * kmPerDegLng(midLat);
  const heightKm = Math.abs(rect.north - rect.south) * kmPerDegLat();
  return { widthKm, heightKm };
}

async function geocodeArea(location) {
  const key = getApiKey();
  const url = `${GEOCODE_BASE}?address=${encodeURIComponent(location)}&key=${key}`;
  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (e) {
    throw new Error(`Geocoding request failed: ${e.message}`);
  }
  if (data.status === "REQUEST_DENIED") {
    throw new Error(`Geocoding denied: ${data.error_message || "enable the Geocoding API for this key"}`);
  }
  if (data.status !== "OK" || !data.results || !data.results.length) {
    throw new Error(`Could not find that location: "${location}"`);
  }
  const r = data.results[0];
  const box = r.geometry && (r.geometry.bounds || r.geometry.viewport);
  if (!box) throw new Error(`No area bounds available for "${location}"`);
  return {
    south: box.southwest.lat,
    west: box.southwest.lng,
    north: box.northeast.lat,
    east: box.northeast.lng,
    label: r.formatted_address || location,
  };
}

function subdivideRect(rect, cols, rows) {
  const tiles = [];
  const latStep = (rect.north - rect.south) / rows;
  const lngStep = (rect.east - rect.west) / cols;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      tiles.push({
        south: rect.south + i * latStep,
        north: rect.south + (i + 1) * latStep,
        west: rect.west + j * lngStep,
        east: rect.west + (j + 1) * lngStep,
      });
    }
  }
  return tiles;
}

function buildInitialGrid(bbox) {
  const { widthKm, heightKm } = rectSizeKm(bbox);
  const cols = Math.min(Math.max(Math.ceil(widthKm / TILE_KM), 1), MAX_INITIAL_GRID);
  const rows = Math.min(Math.max(Math.ceil(heightKm / TILE_KM), 1), MAX_INITIAL_GRID);
  return subdivideRect(bbox, cols, rows);
}

function mapPlace(p) {
  return {
    companyName: (p.displayName && p.displayName.text) || p.displayName || "Unknown",
    address: p.formattedAddress || null,
    location: p.formattedAddress || null,
    placeId: p.id || null,
    rating: typeof p.rating === "number" ? p.rating : null,
    reviewCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
    businessStatus: p.businessStatus || null,
    businessTypes: p.types || [],
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
    website: p.websiteUri || null,
    hours: (p.regularOpeningHours && p.regularOpeningHours.weekdayDescriptions) || null,
    googleMapsUrl: p.googleMapsUri || null,
    source: "google_maps",
    _tiled: true, // tells the pipeline the contact fields are already filled
  };
}

/**
 * Search one rectangular tile, following page tokens up to the 60-result cap.
 * Returns { places, saturated, fatal }. "saturated" means the tile returned a
 * full 60, so more businesses exist inside it and it should be subdivided.
 * "fatal" is set on config / quota errors that should stop the whole job.
 */
async function searchTextTile(textQuery, rect, apiKey) {
  const results = [];
  let pageToken = null;

  for (let page = 0; page < PAGES_PER_TILE; page++) {
    const body = {
      textQuery,
      pageSize: PAGE_SIZE,
      locationRestriction: {
        rectangle: {
          low: { latitude: rect.south, longitude: rect.west },
          high: { latitude: rect.north, longitude: rect.east },
        },
      },
    };
    if (pageToken) body.pageToken = pageToken;

    let data = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(PLACES_SEARCHTEXT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": FIELD_MASK,
          },
          body: JSON.stringify(body),
        });
        data = await res.json();
        if (!res.ok) {
          const code = (data && data.error && data.error.status) || res.status;
          if (code === "PERMISSION_DENIED" || code === 403) {
            return { places: results, saturated: false, fatal: (data.error && data.error.message) || "permission denied" };
          }
          if (code === "RESOURCE_EXHAUSTED" || code === 429) {
            return { places: results, saturated: false, fatal: (data.error && data.error.message) || "quota exhausted" };
          }
          // A page token that is not ready yet: brief wait, then one retry.
          if ((code === "INVALID_ARGUMENT" || code === 400) && pageToken && attempt === 0) {
            await delay(1500);
            continue;
          }
          data = null;
        }
      } catch (e) {
        console.error(`[Tiling] tile fetch error (attempt ${attempt + 1}): ${e.message}`);
        data = null;
      }
      break;
    }

    if (!data || !Array.isArray(data.places) || data.places.length === 0) break;

    for (const p of data.places) results.push(mapPlace(p));

    pageToken = data.nextPageToken || null;
    if (!pageToken) break;
  }

  const saturated = results.length >= PAGES_PER_TILE * PAGE_SIZE;
  return { places: results, saturated, fatal: null };
}

/**
 * Find every matching business in an area. Geocodes the location, tiles its
 * bounding box, adaptively subdivides saturated tiles, and deduplicates by
 * place_id. Stops early once maxLeads unique businesses are found, or once the
 * per-job tile ceiling is hit.
 */
async function findAllInArea({ query, industry, location, maxLeads = 1000, onProgress }) {
  const apiKey = getApiKey();

  let textQuery = query;
  if (industry && INDUSTRY_QUERIES[industry]) textQuery = INDUSTRY_QUERIES[industry];
  if (!textQuery || !String(textQuery).trim()) throw new Error("A search query or industry is required");
  textQuery = String(textQuery).trim();

  const cap = Math.max(Number(maxLeads) || 1, 1);

  if (onProgress) onProgress({ stage: "geocoding", message: `Locating ${location}...`, percent: 3 });

  const bbox = await geocodeArea(location);
  const queue = buildInitialGrid(bbox);
  const estTiles = Math.max(queue.length, 1);

  const unique = new Map(); // placeId -> business
  let tilesSearched = 0;
  let saturatedTiles = 0;
  let tileLimitHit = false;
  let leadCapHit = false;
  let fatal = null;

  while (queue.length > 0) {
    if (tilesSearched >= MAX_TILES) { tileLimitHit = true; break; }

    const rect = queue.shift();
    const { places, saturated, fatal: tileFatal } = await searchTextTile(textQuery, rect, apiKey);
    tilesSearched++;

    if (tileFatal) {
      // First tile failing on config / quota is fatal; later, keep what we have.
      if (unique.size === 0) fatal = tileFatal;
      break;
    }

    for (const biz of places) {
      if (biz.placeId && !unique.has(biz.placeId)) unique.set(biz.placeId, biz);
    }

    if (saturated) {
      saturatedTiles++;
      const { widthKm, heightKm } = rectSizeKm(rect);
      if (widthKm > MIN_TILE_KM || heightKm > MIN_TILE_KM) {
        for (const sub of subdivideRect(rect, 2, 2)) queue.push(sub);
      }
    }

    if (onProgress) {
      const pct = Math.min(40, Math.round((tilesSearched / (estTiles * 1.6)) * 40));
      onProgress({
        stage: "tiling",
        message: `Scanning ${bbox.label} (${tilesSearched} zones, ${unique.size} businesses found)...`,
        percent: Math.max(3, pct),
        found: unique.size,
        tilesSearched,
      });
    }

    if (unique.size >= cap) { leadCapHit = true; break; }
  }

  if (fatal) throw new Error(`Google Places search failed: ${fatal}`);

  const businesses = Array.from(unique.values()).slice(0, cap);
  return {
    businesses,
    meta: {
      areaLabel: bbox.label,
      tilesSearched,
      saturatedTiles,
      totalFound: unique.size,
      returned: businesses.length,
      capped: leadCapHit || unique.size > businesses.length,
      partialArea: tileLimitHit,
    },
  };
}

module.exports = { findAllInArea, geocodeArea };