// ============================================================================
// INDUSTRY PRICING REFERENCE
// ----------------------------------------------------------------------------
// Specific common jobs and their typical US price ranges per industry, so the
// receptionist can give a caller a real, grounded ballpark when they ask about
// cost, instead of stonewalling ("we don't give prices over the phone"). See
// the "# Pricing and ballpark requests" block in assistant-config-builder.js.
//
// Ranges are rough 2026 US national figures compiled from public cost guides
// (Angi, HomeGuide, Fixr, This Old House, HouseCall Pro, RepairPal, and
// industry sources). They are intentionally wide and honest.
//
// Hard rules baked into how this is used (enforced by the prompt block):
//   - These are TYPICAL ranges for the kind of work, NOT any specific
//     business's prices. A client's own entered service prices ALWAYS win.
//   - Ballpark reference only. The AI never reads a number here as the
//     business's quoted price, never gives a single figure as a quote, and
//     never uses this list to OFFER a service (only the business's real
//     service list does that). It always points to the free exact quote.
//
// Every supported industry has a table. To tune: edit the ranges below. One
// place, applies platform-wide on the next deploy, to every client of that
// industry, with no per-client migration.
// ============================================================================

const INDUSTRY_PRICING = {
  // ── Home services (catch-all: handyman + common trade + garage door) ──────
  home_services: [
    { service: 'Service call / diagnostic visit', range: '$75 to $150' },
    { service: 'Handyman labor', range: '$60 to $125 per hour' },
    { service: 'Garage door spring replacement', range: '$150 to $450' },
    { service: 'Garage door cable replacement', range: '$150 to $350' },
    { service: 'Garage door opener repair', range: '$120 to $300' },
    { service: 'Garage door opener replacement', range: '$300 to $800' },
    { service: 'Drywall patch / small repair', range: '$150 to $450' },
    { service: 'Larger repair or installation', range: '$500 to $2,500+' },
  ],

  hvac: [
    { service: 'Service call / diagnostic', range: '$75 to $200' },
    { service: 'Capacitor, contactor, or relay', range: '$150 to $450' },
    { service: 'Refrigerant recharge', range: '$150 to $700' },
    { service: 'Thermostat (incl. smart)', range: '$150 to $500' },
    { service: 'Blower or fan motor', range: '$400 to $1,200' },
    { service: 'Refrigerant leak repair', range: '$500 to $1,500' },
    { service: 'Evaporator or condenser coil', range: '$600 to $2,700' },
    { service: 'Compressor replacement', range: '$1,200 to $3,500' },
    { service: 'Seasonal tune-up / maintenance', range: '$80 to $200' },
    { service: 'Replace one unit (AC or furnace)', range: '$4,500 to $12,000' },
    { service: 'Full new system (AC + furnace)', range: '$6,000 to $14,000' },
  ],

  plumbing: [
    { service: 'Service call / diagnostic', range: '$75 to $200' },
    { service: 'Drain cleaning / snaking', range: '$125 to $450' },
    { service: 'Hydro jetting', range: '$300 to $1,000' },
    { service: 'Faucet or fixture install', range: '$150 to $600' },
    { service: 'Toilet repair', range: '$100 to $350' },
    { service: 'Leak repair', range: '$150 to $600' },
    { service: 'Slab leak repair', range: '$1,500 to $4,500' },
    { service: 'Water heater repair', range: '$150 to $750' },
    { service: 'Water heater replacement (tank)', range: '$1,200 to $2,500' },
    { service: 'Tankless water heater install', range: '$1,500 to $4,500' },
    { service: 'Sewer line cleaning', range: '$200 to $600' },
    { service: 'Sewer line repair', range: '$1,500 to $8,000' },
    { service: 'Sump pump repair or replace', range: '$300 to $1,200' },
    { service: 'Whole-home repipe', range: '$4,000 to $20,000' },
  ],

  electrical: [
    { service: 'Service call / diagnostic', range: '$75 to $200' },
    { service: 'Outlet or switch repair/replace', range: '$120 to $350' },
    { service: 'GFCI outlet', range: '$130 to $300' },
    { service: 'Light fixture install', range: '$85 to $350' },
    { service: 'Ceiling fan install', range: '$150 to $400' },
    { service: 'Circuit breaker replacement', range: '$150 to $350' },
    { service: 'New dedicated circuit', range: '$250 to $900' },
    { service: 'Panel upgrade (100 to 200 amp)', range: '$1,500 to $4,000' },
    { service: 'EV charger install', range: '$800 to $2,500' },
    { service: 'Standby generator install', range: '$4,500 to $15,000+' },
    { service: 'Whole-home rewire', range: '$8,000 to $20,000' },
  ],

  roofing: [
    { service: 'Roof inspection', range: 'often free, up to $300' },
    { service: 'Minor repair (leak, a few shingles)', range: '$150 to $800' },
    { service: 'Average roof repair', range: '$400 to $1,800' },
    { service: 'Asphalt shingle replacement', range: '$6,000 to $18,000 (about $4 to $8 per sq ft)' },
    { service: 'Metal roof replacement', range: '$12,000 to $30,000+' },
    { service: 'Flat or commercial roof', range: '$5 to $17 per sq ft' },
    { service: 'Tear-off and disposal (add-on)', range: '$1,000 to $5,000' },
  ],

  automotive: [
    { service: 'Diagnostic / check-engine scan', range: '$80 to $200' },
    { service: 'Oil change', range: '$40 to $100' },
    { service: 'Tire (per tire, installed)', range: '$100 to $300' },
    { service: 'Wheel alignment', range: '$75 to $200' },
    { service: 'Battery replacement', range: '$150 to $350' },
    { service: 'Brake job (per axle)', range: '$250 to $600' },
    { service: 'Alternator replacement', range: '$400 to $1,000' },
    { service: 'Starter replacement', range: '$300 to $600' },
    { service: 'Timing belt', range: '$500 to $1,200' },
    { service: 'A/C repair or recharge', range: '$150 to $700' },
    { service: 'Transmission repair or rebuild', range: '$1,500 to $4,500' },
    { service: 'Engine replacement', range: '$4,000 to $10,000+' },
  ],

  waterproofing: [
    { service: 'Inspection / diagnostic', range: 'often free, up to $500' },
    { service: 'Foundation crack injection (per crack)', range: '$300 to $1,000' },
    { service: 'Interior French drain (per linear ft)', range: '$40 to $100' },
    { service: 'Sump pump install', range: '$700 to $3,000' },
    { service: 'Interior drainage + sump pump', range: '$3,000 to $8,000' },
    { service: 'Vapor barrier / encapsulation', range: '$1,500 to $4,000' },
    { service: 'Full basement waterproofing (typical)', range: '$3,000 to $10,000' },
    { service: 'Exterior excavation + membrane', range: '$5,000 to $15,000+' },
  ],

  septic: [
    { service: 'Pump / cleaning (1,000 to 1,500 gal)', range: '$300 to $600' },
    { service: 'Inspection', range: '$300 to $600' },
    { service: 'Baffle, filter, or riser repair', range: '$150 to $1,000' },
    { service: 'Drain field repair', range: '$2,000 to $10,000' },
    { service: 'Drain field replacement', range: '$5,000 to $15,000' },
    { service: 'Tank-only replacement', range: '$3,000 to $7,000' },
    { service: 'New septic system', range: '$5,000 to $25,000+' },
    { service: 'Perc / soil test', range: '$300 to $1,500' },
  ],

  junk_removal: [
    { service: 'Single item pickup', range: '$75 to $180' },
    { service: 'Minimum / small load', range: '$100 to $250' },
    { service: 'Quarter truckload', range: '$150 to $300' },
    { service: 'Half truckload', range: '$300 to $500' },
    { service: 'Full truckload', range: '$450 to $800' },
    { service: 'Mattress or single appliance', range: '$75 to $180' },
    { service: 'Garage or full home cleanout', range: '$300 to $800+' },
  ],

  landscaping: [
    { service: 'Lawn mowing (per visit)', range: '$40 to $100' },
    { service: 'Yard cleanup', range: '$200 to $600' },
    { service: 'Mulch install', range: '$75 to $150 per yard installed' },
    { service: 'Sod install', range: '$1 to $2 per sq ft' },
    { service: 'Tree trimming / pruning', range: '$150 to $1,000' },
    { service: 'Tree removal', range: '$400 to $2,000+ (large trees $2,000 to $6,000)' },
    { service: 'Stump grinding (per stump)', range: '$100 to $400' },
    { service: 'Irrigation repair', range: '$100 to $400' },
    { service: 'Design / install project', range: '$2,000 to $10,000+' },
  ],

  pest_control: [
    { service: 'One-time general treatment (ants, roaches, spiders)', range: '$150 to $400' },
    { service: 'Recurring plan (per visit)', range: '$40 to $200' },
    { service: 'Termite inspection', range: 'often free, up to $150' },
    { service: 'Termite treatment', range: '$500 to $3,000' },
    { service: 'Termite fumigation (tenting)', range: '$2,000 to $8,000+' },
    { service: 'Bed bug treatment', range: '$500 to $2,500' },
    { service: 'Rodent control & exclusion', range: '$200 to $1,500' },
    { service: 'Mosquito treatment (per visit)', range: '$75 to $300' },
    { service: 'Wildlife removal', range: '$250 to $1,000' },
  ],

  dental: [
    { service: 'Exam, cleaning & X-rays', range: '$75 to $350' },
    { service: 'Deep cleaning (per quadrant)', range: '$150 to $400' },
    { service: 'Composite filling', range: '$150 to $450' },
    { service: 'Simple extraction', range: '$100 to $300' },
    { service: 'Surgical / impacted extraction', range: '$225 to $600' },
    { service: 'Root canal', range: '$700 to $1,800' },
    { service: 'Crown', range: '$900 to $2,000' },
    { service: 'Single implant (with crown)', range: '$3,000 to $6,000' },
    { service: 'Note', range: 'insurance often covers most preventive and basic work; these are rough self-pay figures' },
  ],

  med_spa: [
    { service: 'Consultation', range: 'often free' },
    { service: 'Botox / tox (per unit)', range: '$10 to $18' },
    { service: 'Dermal filler (per syringe)', range: '$600 to $1,200' },
    { service: 'HydraFacial', range: '$150 to $350' },
    { service: 'Chemical peel', range: '$150 to $600' },
    { service: 'Microneedling', range: '$200 to $700' },
    { service: 'Laser hair removal (per session)', range: '$100 to $500' },
    { service: 'IPL photofacial', range: '$300 to $600' },
    { service: 'Monthly membership', range: '$149 to $249' },
  ],

  salon_spa: [
    { service: "Women's haircut", range: '$35 to $90' },
    { service: "Men's haircut", range: '$20 to $50' },
    { service: 'Color / highlights', range: '$75 to $250' },
    { service: 'Balayage', range: '$150 to $350' },
    { service: 'Blowout', range: '$40 to $75' },
    { service: 'Facial', range: '$75 to $150' },
    { service: 'Massage (60 min)', range: '$70 to $150' },
    { service: 'Manicure / pedicure', range: '$30 to $90' },
    { service: 'Waxing', range: '$20 to $120' },
  ],

  fitness: [
    { service: 'Day pass', range: '$10 to $30' },
    { service: 'Monthly membership', range: '$30 to $100' },
    { service: 'Group class (drop-in)', range: '$15 to $35' },
    { service: 'Small-group training', range: '$25 to $50 per session' },
    { service: 'Personal training (per session)', range: '$50 to $120' },
    { service: 'Intro / trial', range: 'often free' },
  ],

  medical: [
    { service: 'Office visit (self-pay)', range: '$100 to $300' },
    { service: 'Specialist visit (self-pay)', range: '$200 to $500' },
    { service: 'Urgent care visit', range: '$125 to $300' },
    { service: 'Note', range: 'with insurance most patients pay only a copay (about $20 to $75); self-pay cost varies a lot by visit and is best confirmed by the office' },
  ],

  legal: [
    { service: 'Initial consultation', range: 'often free, up to $300' },
    { service: 'Hourly rate', range: '$150 to $500 per hour' },
    { service: 'Simple will / estate document', range: '$300 to $1,200' },
    { service: 'Flat-fee uncontested matter', range: '$500 to $2,500' },
    { service: 'Retainer (to start)', range: '$1,500 to $5,000+' },
    { service: 'Note', range: 'injury and some other cases are often contingency, about a third of any recovery, with nothing up front' },
  ],

  real_estate: [
    { service: 'Listing / sale commission', range: 'typically 5% to 6% of sale price, usually split between the two agents' },
    { service: 'Buyer consultation / home valuation', range: 'usually free' },
    { service: 'Note', range: 'commission structures vary; some brokerages offer flat or discounted fees' },
  ],

  financial: [
    { service: 'Initial consultation', range: 'usually free' },
    { service: 'Assets-under-management fee', range: 'typically about 1% per year' },
    { service: 'Flat financial plan', range: '$1,000 to $3,000' },
    { service: 'Hourly planning', range: '$150 to $400 per hour' },
    { service: 'Monthly retainer / subscription', range: '$100 to $500' },
  ],

  professional_services: [
    { service: 'Initial consultation', range: 'often free, up to $200' },
    { service: 'Hourly rate', range: '$75 to $300 per hour' },
    { service: 'Monthly retainer', range: '$500 to $5,000' },
    { service: 'Note', range: 'project pricing varies widely with scope' },
  ],

  restaurants: [
    { service: 'Menu items', range: 'priced per dish, point the caller to the current menu' },
    { service: 'Catering (per person)', range: '$15 to $50' },
    { service: 'Private event / room minimum', range: '$200 to $2,000+' },
    { service: 'Large-party deposit', range: 'often a set per-head or flat deposit' },
  ],

  retail: [
    { service: 'Products', range: 'priced per item, point the caller to the specific product' },
    { service: 'Delivery / assembly', range: '$50 to $200 typical' },
    { service: 'Repairs, custom orders, alterations', range: 'quoted per job' },
  ],
};

// Build the prompt block for a given industry. Returns '' only when the key is
// unmapped (every supported industry above has a table), so the AI falls back
// to the general-knowledge guidance in the pricing block.
function buildIndustryPricingBlock(industryKey) {
  const rows = INDUSTRY_PRICING[industryKey];
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const lines = rows
    .map((r) => (r.service === 'Note' ? `(${r.range})` : `- ${r.service}: ${r.range}`))
    .join('\n');
  return `\n\n# Typical pricing reference (general, NOT this business's prices)
Use this ONLY to give a caller a rough ballpark when they ask about cost, exactly as described in the pricing section above. These are rough national averages for this kind of work, not this business's set prices, so present them as a general range, say the real price depends on the specifics, and point them to the free exact quote. Never read a number here as this business's quoted price, and never use this list to offer or suggest a service, only the business's own service list does that. If the business's information above lists a real price for what they asked, use that instead of this.
${lines}`;
}

module.exports = { INDUSTRY_PRICING, buildIndustryPricingBlock };
