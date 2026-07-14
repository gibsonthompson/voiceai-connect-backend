// ============================================================================
// MEASUREMENT REPORT
// ----------------------------------------------------------------------------
// Room by room: floor, ceiling, perimeter, WALL AREA with every opening deducted,
// and baseboard. These are the numbers that pay for paint, drywall, flooring and trim.
//
// IT SHOWS ITS WORK. An adjuster will ask how you got 336 sq ft of wall, and "the app
// said so" is not an answer. Gross area, each opening subtracted by name, net. The same
// arithmetic a human would do on paper, which is exactly what survives a scrub.
//
// NO PRICES. Xactimate prices this from the carrier price list for the region and the
// date of loss. We measure it. Rebuilt on the shared layout kit so it matches the
// carrier report and the client pack.
// ============================================================================
const {
  T, M, newDoc, docToBuffer, brandingOf, kit, coverPage, brandFooterBlock,
  dateOnly, db, orgSettings
} = require('./resto-pdf-common');
const { roomDimensions } = require('./resto-scope-quantities');
const { formatFeetInches } = require('./feet-inches');

const OPENING_LABEL = { door: 'Door', window: 'Window', opening: 'Cased opening', missing_wall: 'Missing wall' };
const num = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

function generateMeasurementPdf(graph) {
  const { claim, structures, rooms, sketches, settings } = graph;
  const brand = brandingOf(settings);
  const cfg = brand.cfg || {};

  const doc = newDoc();
  const bufP = docToBuffer(doc);

  const k = coverPage(doc, brand, {
    title: 'Measurements',
    heading: claim.policyholder_name || 'Claim',
    sub: claim.address || '',
    factPairs: [
      ['Claim / job number', claim.carrier_identifier],
      ['Date of loss', dateOnly(claim.date_of_loss)],
      ['Insurance company', claim.insurance_company],
      ['Adjuster / claim rep', claim.adjuster]
    ]
  });
  const { W } = k;

  k.para('Wall area is the perimeter multiplied by the ceiling height, with every door, window, cased opening and missing wall subtracted. Each deduction is listed by name and by size, so the arithmetic can be followed line by line.',
    { size: 10 });
  k.gap(1);
  k.para('Measurements only. Xactimate prices these from the carrier price list for the region and the date of loss.',
    { size: T.size.small, color: T.muted });

  doc.addPage();
  doc.x = M; doc.y = 76;

  let totalFloor = 0, totalWall = 0, totalBase = 0, totalCeil = 0;
  let assumedCeilings = 0, assumedOpenings = 0, anyRoom = false;

  for (const st of structures) {
    const stRooms = rooms.filter((r) => r.structure_id === st.id);
    if (!stRooms.length) continue;
    const structDefault = Number(st.default_ceiling_height_ft) > 0 ? Number(st.default_ceiling_height_ft) : null;

    let printedSection = false;

    for (const room of stRooms) {
      const rSketches = sketches.filter((s) => s.room_id === room.id);
      if (!rSketches.length) continue;

      const roomCeiling = Number(room.height_ft) > 0 ? Number(room.height_ft) : structDefault;
      // roomDimensions takes the SKETCH ROWS, not a scene. It walks every sketch of the
      // room and takes the largest wall polygon as the outline, so a room with two maps
      // still measures once.
      const d = roomDimensions(rSketches, roomCeiling);
      if (!d.F) continue;   // nothing drawn, nothing to measure

      if (!printedSection) { k.section(st.name || 'Structure'); printedSection = true; }
      anyRoom = true;

      k.h2(room.name || 'Room', room.affected === false ? 'Context only, not part of the loss' : null);

      k.facts([
        ['Floor', num(d.F) + ' sq ft'],
        ['Ceiling', num(d.C) + ' sq ft'],
        ['Perimeter', num(d.PF) + ' ft'],
        ['Ceiling height', formatFeetInches(d.SH) + (d.assumedCeiling ? ' (assumed)' : '')]
      ], 4);

      // THE WALL MATH, step by step. This is the whole point of the document.
      const rowsW = [[`Perimeter ${num(d.PF)} ft x height ${formatFeetInches(d.SH)}`, '', num(d.grossWallSF) + ' sq ft']];
      for (const o of d.openings) {
        const label = 'Less ' + (OPENING_LABEL[o.kind] || o.kind).toLowerCase();
        const size = `${formatFeetInches(o.widthFt)} x ${formatFeetInches(o.heightFt)}` + (o.assumedHeight ? '  (size assumed)' : '');
        rowsW.push([label, size, '-' + num(o.sqft) + ' sq ft']);
        if (o.assumedHeight) assumedOpenings++;
      }
      k.h3('Wall area', 40);
      k.table(
        [{ t: 'Calculation', w: 0.42 }, { t: 'Size', w: 0.30 }, { t: 'Area', w: 0.28, align: 'right' }],
        rowsW,
        { total: ['Wall area to bill', '', num(d.W) + ' sq ft'] }
      );

      k.facts([
        ['Walls and ceiling', num(d.WC) + ' sq ft'],
        ['Baseboard', num(d.baseboardLF) + ' ft'],
        ['Floor, square yards', num(d.SY) + ' sy']
      ], 3);

      (d.warnings || []).forEach((w) => k.callout(w, 'warn'));

      if (d.assumedCeiling) assumedCeilings++;
      totalFloor += d.F; totalCeil += d.C; totalWall += d.W; totalBase += d.baseboardLF;
      k.gap(1);
    }
  }

  if (!anyRoom) {
    k.para('No rooms have been drawn yet. Sketch a room and its measurements appear here.',
      { color: T.muted });
  } else {
    k.section('Totals');
    k.facts([
      ['Floor area', num(totalFloor) + ' sq ft'],
      ['Ceiling area', num(totalCeil) + ' sq ft'],
      ['Wall area to bill', num(totalWall) + ' sq ft'],
      ['Baseboard', num(totalBase) + ' ft']
    ], 4);

    if (assumedCeilings || assumedOpenings) {
      const bits = [];
      if (assumedCeilings) bits.push(`${assumedCeilings} room${assumedCeilings === 1 ? '' : 's'} without a measured ceiling height`);
      if (assumedOpenings) bits.push(`${assumedOpenings} opening${assumedOpenings === 1 ? '' : 's'} without a measured size`);
      k.callout(bits.join(' and ') + '. Those figures rest on a standard size rather than a tape measure, and they should be measured before the wall area is billed.', 'warn');
    } else {
      k.callout('Every ceiling height and every opening on this claim was measured. Nothing here rests on a default.', 'ok');
    }
  }

  brandFooterBlock(k, cfg);
  k.gap(1);
  k.para('Measurements only, no pricing. Xactimate prices every line from the carrier price list for the region and the date of loss.',
    { size: T.size.tiny, color: T.faint });

  k.furniture({
    company: cfg.company_name || '',
    address: claim.address || '',
    coverPages: 1,
    footNote: [claim.policyholder_name, claim.carrier_identifier].filter(Boolean).join('   \u00b7   ')
  });

  doc.end();
  return bufP;
}

async function fetchMeasurementGraph(claimId) {
  const supabase = db();
  const { data: claim } = await supabase.from('resto_claims').select('*').eq('id', claimId).single();
  if (!claim) throw new Error('claim not found');
  const settings = await orgSettings(claim.org_id);

  const { data: structures } = await supabase.from('resto_structures').select('*').eq('claim_id', claimId).order('sort_order');
  const structureIds = (structures || []).map((s) => s.id);
  const { data: rooms } = structureIds.length
    ? await supabase.from('resto_rooms').select('*').in('structure_id', structureIds).order('sort_order')
    : { data: [] };
  const roomIds = (rooms || []).map((r) => r.id);
  const { data: sketches } = roomIds.length
    ? await supabase.from('resto_sketches').select('*').in('room_id', roomIds)
    : { data: [] };

  return { claim, structures: structures || [], rooms: rooms || [], sketches: sketches || [], settings };
}

async function buildMeasurementPdf(claimId) {
  const graph = await fetchMeasurementGraph(claimId);
  const pdf = await generateMeasurementPdf(graph);
  return { pdf, claim: graph.claim };
}

module.exports = { buildMeasurementPdf, generateMeasurementPdf, fetchMeasurementGraph };