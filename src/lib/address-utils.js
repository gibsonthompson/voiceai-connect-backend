// ============================================================================
// address-utils.js
// Decide whether a scraped string is a REAL street address, so the texting
// presets and knowledge base never surface a vague area ("downtown Burlington",
// "Greater Boston", "serving the Triangle") or a city/service-area as the
// business address. A real address has a street number plus a street type or a
// ZIP code.
// ============================================================================

const STREET_TYPES = /\b(st|str|street|ave|av|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|hwy|highway|pkwy|parkway|cir|circle|ter|terrace|sq|square|trl|trail|loop|pike|route|rt|ste|suite|unit|apt|fl|floor|bldg|plaza|crossing|commons)\b/i;

// Phrases that describe an area, not a street address, even if a number sneaks in.
const VAGUE_START = /^(downtown|uptown|midtown|greater|serving|near|around|central|the\s|north\s|south\s|east\s|west\s|all\sof|throughout)\b/i;

function looksLikeStreetAddress(s) {
  const t = String(s == null ? '' : s).trim();
  if (t.length < 6 || t.length > 200) return false;
  if (!/\d/.test(t)) return false;            // a real address carries a street number
  if (VAGUE_START.test(t)) return false;      // "downtown Burlington", "Greater Boston", ...
  const hasStreetNumber = /^\s*(?:[A-Za-z]-)?\d{1,6}[A-Za-z]?\s+\S/.test(t) || /\b\d{1,6}\s+\p{L}{2,}/u.test(t);
  const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(t);
  const hasStreetType = STREET_TYPES.test(t);
  return (hasStreetNumber && (hasStreetType || hasZip)) || (hasStreetType && hasZip);
}

// Pick the first value that is a real street address, from a primary candidate
// then a list. Returns '' when none qualify (better empty than a wrong address).
function pickStreetAddress(primary, list) {
  if (looksLikeStreetAddress(primary)) return String(primary).trim();
  for (const c of (Array.isArray(list) ? list : [])) {
    if (looksLikeStreetAddress(c)) return String(c).trim();
  }
  return '';
}

module.exports = { looksLikeStreetAddress, pickStreetAddress };