// ============================================================================
// src/lib/brand-fonts.js
//
// Backend copy of the curated font catalog (keep in sync with the frontend
// lib/brandFonts.ts). Used to (a) show the vision model the exact set of fonts
// it may choose from, and (b) validate the fonts it returns so a hallucinated or
// unloadable family can never reach the agency row. Icon styles live here too so
// the model can pick one.
// ============================================================================

// family -> { category, vibes[], role, pairs[] }. Trimmed to what the prompt +
// validation need (weights/loading are the frontend's concern).
const BRAND_FONTS = [
  { family: 'Sora', category: 'geometric-sans', vibes: ['modern', 'techy', 'clean', 'confident'], role: 'display' },
  { family: 'Poppins', category: 'geometric-sans', vibes: ['friendly', 'modern', 'approachable', 'rounded'], role: 'both' },
  { family: 'Montserrat', category: 'geometric-sans', vibes: ['clean', 'professional', 'versatile'], role: 'display' },
  { family: 'Outfit', category: 'geometric-sans', vibes: ['modern', 'minimal', 'sleek'], role: 'both' },
  { family: 'Urbanist', category: 'geometric-sans', vibes: ['modern', 'minimal', 'clean'], role: 'both' },
  { family: 'Lexend', category: 'geometric-sans', vibes: ['clean', 'approachable', 'readable'], role: 'both' },
  { family: 'Raleway', category: 'geometric-sans', vibes: ['elegant', 'light', 'sophisticated'], role: 'display' },
  { family: 'Inter', category: 'grotesque-sans', vibes: ['neutral', 'clean', 'professional', 'default'], role: 'both' },
  { family: 'Space Grotesk', category: 'grotesque-sans', vibes: ['techy', 'modern', 'distinctive'], role: 'display' },
  { family: 'Manrope', category: 'grotesque-sans', vibes: ['modern', 'clean', 'balanced'], role: 'both' },
  { family: 'DM Sans', category: 'grotesque-sans', vibes: ['clean', 'geometric', 'friendly'], role: 'both' },
  { family: 'Archivo', category: 'grotesque-sans', vibes: ['bold', 'industrial', 'strong'], role: 'display' },
  { family: 'Hanken Grotesk', category: 'grotesque-sans', vibes: ['modern', 'clean', 'warm'], role: 'both' },
  { family: 'Bricolage Grotesque', category: 'grotesque-sans', vibes: ['distinctive', 'editorial', 'modern'], role: 'display' },
  { family: 'Work Sans', category: 'humanist-sans', vibes: ['warm', 'approachable', 'clean'], role: 'both' },
  { family: 'Source Sans 3', category: 'humanist-sans', vibes: ['neutral', 'readable', 'professional'], role: 'body' },
  { family: 'Mulish', category: 'humanist-sans', vibes: ['clean', 'minimal', 'light'], role: 'body' },
  { family: 'Figtree', category: 'humanist-sans', vibes: ['friendly', 'modern', 'warm'], role: 'both' },
  { family: 'Nunito Sans', category: 'humanist-sans', vibes: ['friendly', 'soft', 'approachable'], role: 'body' },
  { family: 'Karla', category: 'humanist-sans', vibes: ['clean', 'quirky', 'readable'], role: 'body' },
  { family: 'IBM Plex Sans', category: 'humanist-sans', vibes: ['techy', 'corporate', 'precise'], role: 'both' },
  { family: 'Quicksand', category: 'rounded-sans', vibes: ['playful', 'soft', 'friendly', 'light'], role: 'display' },
  { family: 'Baloo 2', category: 'rounded-sans', vibes: ['playful', 'bold', 'friendly'], role: 'display' },
  { family: 'Fredoka', category: 'rounded-sans', vibes: ['playful', 'fun', 'bold', 'friendly'], role: 'display' },
  { family: 'Comfortaa', category: 'rounded-sans', vibes: ['soft', 'minimal', 'playful'], role: 'display' },
  { family: 'Playfair Display', category: 'serif', vibes: ['luxury', 'elegant', 'editorial', 'high-end'], role: 'display' },
  { family: 'Fraunces', category: 'serif', vibes: ['editorial', 'characterful', 'warm', 'premium'], role: 'display' },
  { family: 'Cormorant', category: 'serif', vibes: ['luxury', 'refined', 'delicate', 'high-end'], role: 'display' },
  { family: 'Lora', category: 'serif', vibes: ['trustworthy', 'editorial', 'warm', 'readable'], role: 'both' },
  { family: 'Libre Baskerville', category: 'serif', vibes: ['traditional', 'trustworthy', 'classic'], role: 'both' },
  { family: 'Spectral', category: 'serif', vibes: ['editorial', 'refined', 'readable'], role: 'both' },
  { family: 'Roboto Slab', category: 'slab-serif', vibes: ['sturdy', 'confident', 'modern'], role: 'both' },
  { family: 'Zilla Slab', category: 'slab-serif', vibes: ['techy', 'sturdy', 'distinctive'], role: 'display' },
  { family: 'Syne', category: 'display', vibes: ['bold', 'artsy', 'futuristic', 'distinctive'], role: 'display' },
  { family: 'Unbounded', category: 'display', vibes: ['bold', 'futuristic', 'loud', 'modern'], role: 'display' },
  { family: 'Clash Display', category: 'display', vibes: ['bold', 'modern', 'premium'], role: 'display' },
  { family: 'Bebas Neue', category: 'condensed', vibes: ['bold', 'impactful', 'athletic', 'loud'], role: 'display' },
  { family: 'Anton', category: 'condensed', vibes: ['heavy', 'impactful', 'bold'], role: 'display' },
  { family: 'Archivo Narrow', category: 'condensed', vibes: ['clean', 'efficient', 'modern'], role: 'both' },
  { family: 'Space Mono', category: 'mono', vibes: ['techy', 'retro', 'distinctive'], role: 'display' },
  { family: 'JetBrains Mono', category: 'mono', vibes: ['techy', 'precise', 'developer'], role: 'body' },
];

const ICON_STYLES = ['fine', 'regular', 'bold']; // fine=elegant/luxury, bold=strong/techy
const DEFAULT_ICON_STYLE = 'regular';

function byFamily(family) {
  if (!family || typeof family !== 'string') return null;
  const f = family.trim().toLowerCase();
  return BRAND_FONTS.find((x) => x.family.toLowerCase() === f) || null;
}

// Validate a family is in the catalog and usable in a slot; returns the exact
// catalog family name (canonical casing) or null.
function validFont(family, role) {
  const f = byFamily(family);
  if (!f) return null;
  if (role && f.role !== 'both' && f.role !== role) return null;
  return f.family;
}

function validIconStyle(style) {
  return ICON_STYLES.includes(style) ? style : DEFAULT_ICON_STYLE;
}

// A compact, prompt-friendly listing the model reads: "Family (category; vibes) [display|body|both]".
function catalogForPrompt() {
  return BRAND_FONTS
    .map((f) => `- ${f.family} (${f.category}; ${f.vibes.join(', ')}) [${f.role}]`)
    .join('\n');
}

module.exports = {
  BRAND_FONTS,
  ICON_STYLES,
  DEFAULT_ICON_STYLE,
  byFamily,
  validFont,
  validIconStyle,
  catalogForPrompt,
};
