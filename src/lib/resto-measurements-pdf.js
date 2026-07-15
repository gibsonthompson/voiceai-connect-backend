// ============================================================================
// MEASUREMENT REPORT  (verbatim)
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

  k.para('Wall area is the perimeter multiplied by the ceiling height, measured as the entire wall. Doors, windows, cased openings and missing walls are listed by name and by size for reference, but they are not deducted, so the wall area covers the full surface as if every opening were being finished.',
    { size: 10 });
  k.gap(1);
  k.para('Measurements only. Xactimate prices these from the carrier price list for the region and the date of loss.',
    { size: T.size.small, color: T.muted });

  doc.addPage();
  doc.x = M; doc.y = 76;

  let totalFloor = 0, totalWall = 0, totalBase = 0, totalCeil = 0;
  let anyRoom = false;

  for (const st of structures) {
    const stRooms = rooms.filter((r) => r.structure_id === st.id);
    if (!stRooms.length) continue;
    const structDefault = Number(st.default_ceiling_height_ft) > 0 ? Number(st.default_ceiling_height_ft) : null;

    let printedSection = false;

    for (const room of stRooms) {
      const rSketches = sketches.filter((s) => s.room_id === room.id);
      if (!rSketches.length) continue;

      const roomCeiling = Number(room.height_ft) > 0 ? Number(room.height_ft) : structDefault;
      const d = roomDimensions(rSketches, roomCeiling);
      if (!d.F) continue;

      if (!printedSection) { k.section(st.name || 'Structure'); printedSection = true; }
      anyRoom = true;

      // Per-surface scope. A surface a tech turned off (e.g. an unaffected tile floor in
      // a hallway with wet walls) is shown for reference but kept OUT of the totals.
      const incFloor = room.include_floor !== false;
      const incWalls = room.include_walls !== false;
      const incCeiling = room.include_ceiling !== false;
      const incBase = room.include_baseboard !== false;
      const nis = ' (not in scope)';

      k.h2(room.name || 'Room', room.affected === false ? 'Context only, not part of the loss' : null);

      k.facts([
        ['Floor', num(d.F) + ' sq ft' + (incFloor ? '' : nis)],
        ['Ceiling', num(d.C) + ' sq ft' + (incCeiling ? '' : nis)],
        ['Perimeter', num(d.PF) + ' ft'],
        ['Ceiling height', formatFeetInches(d.SH) + (d.assumedCeiling ? ' (assumed)' : '')]
      ], 4);

      const grossWall = d.grossWallSF;
      const rowsW = [[`Perimeter ${num(d.PF)} ft x height ${formatFeetInches(d.SH)}`, '', num(grossWall) + ' sq ft']];
      for (const o of d.openings) {
        const label = OPENING_LABEL[o.kind] || o.kind;
        const size = `${formatFeetInches(o.widthFt)} x ${formatFeetInches(o.heightFt)}` + (o.assumedHeight ? '  (size assumed)' : '');
        rowsW.push([label, size, '(' + num(o.sqft) + ' sq ft)']);
      }
      k.h3('Wall area', 40);
      k.table(
        [{ t: 'Calculation', w: 0.42 }, { t: 'Size', w: 0.30 }, { t: 'Area', w: 0.28, align: 'right' }],
        rowsW,
        { total: ['Wall area to bill', '', num(grossWall) + ' sq ft' + (incWalls ? '' : nis)] }
      );
      if (d.openings.length) {
        k.para('Openings above are listed for reference only. They are included in the wall area and not deducted, so the entire wall is measured as if every opening were being finished.',
          { size: T.size.small, color: T.muted });
      }

      k.facts([
        ['Walls and ceiling', num(grossWall + d.C) + ' sq ft'],
        ['Baseboard', num(d.baseboardLF) + ' ft' + (incBase ? '' : nis)],
        ['Floor, square yards', num(d.SY) + ' sy' + (incFloor ? '' : nis)]
      ], 3);

      // Say plainly which surfaces are excluded and why the totals leave them out.
      const outOf = [];
      if (!incFloor) outOf.push('floor');
      if (!incWalls) outOf.push('walls');
      if (!incCeiling) outOf.push('ceiling');
      if (!incBase) outOf.push('baseboard');
      if (outOf.length) {
        k.callout('Not part of the loss in this room: ' + outOf.join(', ') +
          '. Measured and shown above for reference, but excluded from the totals below.', 'warn');
      }

      (d.warnings || []).forEach((w) => k.callout(w, 'warn'));

      if (incFloor) totalFloor += d.F;
      if (incCeiling) totalCeil += d.C;
      if (incWalls) totalWall += grossWall;
      if (incBase) totalBase += d.baseboardLF;
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