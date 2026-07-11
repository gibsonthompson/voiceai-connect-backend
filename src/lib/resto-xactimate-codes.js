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
  contents_loss:     { cat: 'CON', sel: 'ITEM',   unit: 'EA', confidence: 'verify',    cat3Suffix: false, desc: 'Non-salvageable content item (VERIFY; contents are usually handled in XactContents, not the estimate)' },

  // Flooring tear-out of NON-SALVAGEABLE floor covering, under the WTR (water
  // mitigation) category. Structure corroborated by Verisk XactAnalysis
  // (non-salvageable tear-out items are WTRFCC / WTRFCV / WTRFCW) and Reets
  // Drying Academy (WTRFC base + C/T/V/W material + S for Cat 3). Emitted only
  // when the tech marks a wet floor 'remove'; a wet floor left to dry bills
  // extraction instead. Never both on the same SF (XactAnalysis flags a
  // same-type, same-SF tear-out + removal overlap as a scrub trigger).
  floor_carpet:      { cat: 'WTR', sel: 'FCC',    unit: 'SF', confidence: 'confirmed', cat3Suffix: true,  desc: 'Tear out wet non-salvageable carpet, cut & bag for disposal' },
  floor_vinyl:       { cat: 'WTR', sel: 'FCV',    unit: 'SF', confidence: 'confirmed', cat3Suffix: true,  desc: 'Tear out non-salvageable vinyl floor, cut & bag for disposal' },
  floor_wood:        { cat: 'WTR', sel: 'FCW',    unit: 'SF', confidence: 'confirmed', cat3Suffix: true,  desc: 'Tear out non-salvageable wood floor, cut & bag for disposal' },
  floor_tile:        { cat: 'WTR', sel: 'FCT',    unit: 'SF', confidence: 'likely',    cat3Suffix: true,  desc: 'Tear out non-salvageable tile floor, cut & bag for disposal' }
};

// equipment row type -> code key
const EQUIP_CODE = { air_mover: 'air_mover', dehumidifier: 'dehumidifier', air_scrubber: 'air_scrubber' };

// Map a free-text floor material to its tear-out code key. Returns null when the
// material has no confident tear-out mapping (the caller then bills extraction).
function flooringCodeKey(material) {
  const m = String(material || '').toLowerCase();
  if (/carpet/.test(m)) return 'floor_carpet';
  if (/vinyl|lvp|lvt|linoleum|sheet\s*good|resilient/.test(m)) return 'floor_vinyl';
  if (/wood|hardwood|laminate|engineered|bamboo|parquet/.test(m)) return 'floor_wood';
  if (/tile|ceramic|porcelain|stone|travertine|marble|slate|terrazzo/.test(m)) return 'floor_tile';
  return null;
}

// Resolve a code, applying the Category 3 suffix when the loss warrants it.
function selectorFor(key, categoryOfWater) {
  const c = CODES[key]; if (!c) return null;
  const sel = (c.cat3Suffix && Number(categoryOfWater) === 3) ? c.sel + 'S' : c.sel;
  return { cat: c.cat, sel, unit: c.unit, confidence: c.confidence, desc: c.desc };
}

module.exports = { CODES, EQUIP_CODE, selectorFor, flooringCodeKey };