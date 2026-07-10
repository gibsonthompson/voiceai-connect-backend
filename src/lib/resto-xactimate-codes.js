// ============================================================================
// XACTIMATE SELECTOR-CODE LOOKUP  (isolated on purpose)
// ----------------------------------------------------------------------------
// This is the ONE file that changes when a real reference .esx confirms the
// codes and the exact CAT/SEL attribute format. All mapping logic references
// this table; the logic never hardcodes a code. See xactimate-integration-map.md.
//
// confidence : 'confirmed' (corroborated across industry sources)
//              'likely'    (seen once or inferred from the code pattern)
//              'verify'    (placeholder, do NOT trust until confirmed on import)
// cat3Suffix : whether Category 3 water appends 'S' to the selector (WTR labor burden)
// unit       : SF sq ft, LF linear ft, EA each, DA day (per 24 hr), HR hour
// ============================================================================

const CODES = {
  extraction_carpet: { cat: 'WTR', sel: 'EXT',    unit: 'SF', confidence: 'confirmed', cat3Suffix: true,  desc: 'Water extraction, carpet/wand' },
  extraction_hard:   { cat: 'WTR', sel: 'EXTH',   unit: 'SF', confidence: 'likely',    cat3Suffix: true,  desc: 'Water extraction, hard surface' },
  drywall_lf_4in:    { cat: 'WTR', sel: 'DRYWLI', unit: 'LF', confidence: 'confirmed', cat3Suffix: true,  desc: 'Tear out wet drywall, cleanup, bag, per LF up to 4 in' },
  drywall_lf_2ft:    { cat: 'WTR', sel: 'DRYWLF', unit: 'LF', confidence: 'confirmed', cat3Suffix: true,  desc: 'Tear out wet drywall, cleanup, bag, per LF up to 2 ft' },
  drywall_sf:        { cat: 'WTR', sel: 'DRYW',   unit: 'SF', confidence: 'confirmed', cat3Suffix: true,  desc: 'Tear out wet drywall, cleanup, bag (per SF)' },
  antimicrobial:     { cat: 'WTR', sel: 'GRM',    unit: 'SF', confidence: 'confirmed', cat3Suffix: false, desc: 'Apply antimicrobial agent' },
  air_mover:         { cat: 'WTR', sel: 'DRY',    unit: 'DA', confidence: 'confirmed', cat3Suffix: false, desc: 'Air mover, per 24 hr period, no monitoring' },
  dehumidifier:      { cat: 'WTR', sel: 'DHM',    unit: 'DA', confidence: 'confirmed', cat3Suffix: false, desc: 'Dehumidifier, per 24 hr period, no monitoring' },
  air_scrubber:      { cat: 'WTR', sel: 'AFD',    unit: 'DA', confidence: 'verify',    cat3Suffix: false, desc: 'Negative air / air scrubber, per 24 hr (VERIFY exact selector)' },
  containment:       { cat: 'WTR', sel: 'BARR',   unit: 'SF', confidence: 'confirmed', cat3Suffix: false, desc: 'Containment barrier (plastic)' },
  contents_loss:     { cat: 'CON', sel: 'ITEM',   unit: 'EA', confidence: 'verify',    cat3Suffix: false, desc: 'Non-salvageable content item (VERIFY; contents are usually handled in XactContents, not the estimate)' }
};

// equipment row type -> code key
const EQUIP_CODE = { air_mover: 'air_mover', dehumidifier: 'dehumidifier', air_scrubber: 'air_scrubber' };

// Resolve a code, applying the Category 3 suffix when the loss warrants it.
function selectorFor(key, categoryOfWater) {
  const c = CODES[key]; if (!c) return null;
  const sel = (c.cat3Suffix && Number(categoryOfWater) === 3) ? c.sel + 'S' : c.sel;
  return { cat: c.cat, sel, unit: c.unit, confidence: c.confidence, desc: c.desc };
}

module.exports = { CODES, EQUIP_CODE, selectorFor };