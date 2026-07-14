// ============================================================================
// MEASUREMENT REPORT
// ----------------------------------------------------------------------------
// The room-by-room measurement sheet: floor, ceiling, perimeter, WALL AREA with
// every opening deducted, and baseboard. These are the numbers that pay for paint,
// drywall, flooring, and trim.
//
// IT SHOWS ITS WORK. An adjuster will ask how you got 356 sq ft of wall, and "the
// app said so" is not an answer. Gross area, each opening subtracted by name, net.
// The same arithmetic a human would do on paper, which is exactly what survives a
// scrub. NO PRICES: Xactimate prices this, we only measure it.
// ============================================================================
const PDFDocument = require('pdfkit');
const {
  NAVY, DARK, GRAY, docToBuffer, brandingOf, drawBrandHeader, drawBrandFooter,
  dateOnly, db, orgSettings
} = require('./resto-pdf-common');
const { roomDimensions } = require('./resto-scope-quantities');
const { formatFeetInches } = require('./feet-inches');

const OPENING_LABEL = { door: 'Door', window: 'Window', opening: 'Cased opening', missing_wall: 'Missing wall' };
const num = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

function generateMeasurementPdf(graph) {
  const { claim, structures, rooms, sketches, settings } = graph;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  const bufP = docToBuffer(doc);
  const brand = brandingOf(settings);
  const W = drawBrandHeader(doc, brand, 'Measurements');

  const ensure = (h) => { if (doc.y + h > doc.page.height - 80) { doc.addPage(); doc.x = 50; doc.y = 60; } };
  const kv = (k, v) => { doc.x = 50; doc.fontSize(9).fillColor(GRAY).text(k + ': ', { continued: true }).fillColor(DARK).text(String(v == null ? '-' : v)); };

  doc.x = 50;
  doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold').text('PROPERTY');
  doc.moveTo(50, doc.y + 2).lineTo(50 + W, doc.y + 2).lineWidth(1).strokeColor(brand.primary).stroke();
  doc.moveDown(0.5).font('Helvetica');
  kv('Policyholder', claim.policyholder_name);
  kv('Property address', claim.address);
  kv('Claim / job number', claim.carrier_identifier);
  kv('Date of loss', dateOnly(claim.date_of_loss));

  let totalFloor = 0, totalWall = 0, totalBase = 0, totalCeil = 0;
  let assumedCeilings = 0, assumedOpenings = 0;
  let anyRoom = false;

  for (const st of structures) {
    const stRooms = rooms.filter((r) => r.structure_id === st.id);
    if (!stRooms.length) continue;
    const structDefault = Number(st.default_ceiling_height_ft) > 0 ? Number(st.default_ceiling_height_ft) : null;

    ensure(50);
    doc.moveDown(0.8); doc.x = 50;
    const y = doc.y;
    doc.save();
    doc.rect(50, y, W, 24).fill(brand.primary);
    doc.fillColor(brand.onBrand).fontSize(12.5).font('Helvetica-Bold')
      .text(st.name || 'Structure', 56, y + 6.5, { width: W - 12, lineBreak: false });
    doc.restore();
    doc.fillColor(DARK).font('Helvetica');
    doc.x = 50; doc.y = y + 32;

    for (const room of stRooms) {
      const rSketches = sketches.filter((s) => s.room_id === room.id);
      const roomCeiling = Number(room.height_ft) > 0 ? Number(room.height_ft) : structDefault;
      const d = roomDimensions(rSketches, roomCeiling);
      if (!d.F) continue;                       // nothing drawn, nothing to measure
      anyRoom = true;

      ensure(150);
      doc.x = 50;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK).text(room.name || 'Room');
      if (room.affected === false) {
        doc.fontSize(8).fillColor(GRAY).font('Helvetica').text('Context only, not part of the loss');
      }
      doc.font('Helvetica');

      // the plain numbers
      const col = (label, value, x) => {
        doc.fontSize(8).fillColor(GRAY).text(label, x, doc.y, { width: (W - 20) / 4, lineBreak: false });
      };
      const cw = (W - 12) / 4;
      let cy = doc.y + 4;
      const cells = [
        ['Floor', `${num(d.F)} sq ft`],
        ['Ceiling', `${num(d.C)} sq ft`],
        ['Perimeter', `${num(d.PF)} ft`],
        ['Ceiling height', formatFeetInches(d.SH) + (d.assumedCeiling ? ' (assumed)' : '')]
      ];
      cells.forEach(([l, v], i) => {
        const x = 50 + i * cw;
        doc.fontSize(7.5).fillColor(GRAY).text(l, x, cy, { width: cw - 6, lineBreak: false });
        doc.fontSize(10.5).fillColor(d.assumedCeiling && i === 3 ? '#B45309' : DARK).font('Helvetica-Bold')
          .text(v, x, cy + 10, { width: cw - 6, lineBreak: false }).font('Helvetica');
      });
      doc.y = cy + 28;
      void col;

      // THE WALL MATH, step by step
      doc.x = 50;
      const boxY = doc.y + 2;
      const rowsN = 2 + d.openings.length;
      const boxH = 20 + rowsN * 13;
      doc.save().rect(50, boxY, W, boxH).fill('#F1F7FC').restore();

      let ly = boxY + 7;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#1483C2')
        .text('WALL AREA', 58, ly, { lineBreak: false });
      ly += 11;
      doc.font('Helvetica');

      const line = (left, right, bold, color) => {
        doc.fontSize(9).fillColor(color || DARK).font(bold ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(left, 58, ly, { width: W - 120, lineBreak: false });
        doc.text(right, 50 + W - 100, ly, { width: 92, align: 'right', lineBreak: false });
        doc.font('Helvetica');
        ly += 13;
      };
      line(`${num(d.PF)} ft around  x  ${formatFeetInches(d.SH)} high`, `${num(d.grossWallSF)} sq ft`);
      for (const o of d.openings) {
        const lbl = `less ${(OPENING_LABEL[o.kind] || o.kind).toLowerCase()}  ${formatFeetInches(o.widthFt)} x ${formatFeetInches(o.heightFt)}${o.assumedHeight ? '  (size assumed)' : ''}`;
        line(lbl, `-${num(o.sqft)} sq ft`, false, o.assumedHeight ? '#B45309' : GRAY);
        if (o.assumedHeight) assumedOpenings++;
      }
      doc.moveTo(58, ly - 2).lineTo(50 + W - 8, ly - 2).lineWidth(0.6).strokeColor('#BBD7EC').stroke();
      ly += 2;
      line('Wall area to bill', `${num(d.W)} sq ft`, true, '#0E5C8A');
      doc.y = boxY + boxH + 6;

      doc.x = 50;
      doc.fontSize(9).fillColor(GRAY)
        .text(`Walls and ceiling: `, { continued: true }).fillColor(DARK).font('Helvetica-Bold').text(`${num(d.WC)} sq ft`, { continued: true }).font('Helvetica')
        .fillColor(GRAY).text(`     Baseboard: `, { continued: true }).fillColor(DARK).font('Helvetica-Bold').text(`${num(d.baseboardLF)} ft`).font('Helvetica');

      if (d.assumedCeiling) assumedCeilings++;
      totalFloor += d.F; totalCeil += d.C; totalWall += d.W; totalBase += d.baseboardLF;
      doc.moveDown(0.6);
    }
  }

  if (!anyRoom) {
    doc.x = 50;
    doc.moveDown(1).fontSize(10).fillColor(GRAY)
      .text('No rooms have been drawn yet. Sketch a room and its measurements appear here.', 50, doc.y, { width: W });
  } else {
    // totals
    ensure(90); doc.x = 50;
    doc.moveDown(0.8);
    const ty = doc.y;
    doc.save().rect(50, ty, W, 26).fill(NAVY).restore();
    doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
      .text('TOTALS', 56, ty + 7.5, { width: W - 12, lineBreak: false });
    doc.font('Helvetica'); doc.x = 50; doc.y = ty + 34;

    const t = [
      ['Floor area', `${num(totalFloor)} sq ft`],
      ['Ceiling area', `${num(totalCeil)} sq ft`],
      ['Wall area to bill', `${num(totalWall)} sq ft`],
      ['Baseboard', `${num(totalBase)} ft`]
    ];
    const tw = W / 4;
    t.forEach(([l, v], i) => {
      const x = 50 + i * tw;
      doc.fontSize(8).fillColor(GRAY).text(l, x, doc.y, { width: tw - 8, lineBreak: false });
      doc.fontSize(13).fillColor(NAVY).font('Helvetica-Bold').text(v, x, doc.y + 11, { width: tw - 8, lineBreak: false }).font('Helvetica');
    });
    doc.y += 32;

    if (assumedCeilings || assumedOpenings) {
      doc.x = 50;
      doc.moveDown(0.6);
      doc.fontSize(8.5).fillColor('#B45309').text(
        `Note: ${assumedCeilings ? `${assumedCeilings} room${assumedCeilings === 1 ? '' : 's'} without a measured ceiling height` : ''}` +
        `${assumedCeilings && assumedOpenings ? ' and ' : ''}` +
        `${assumedOpenings ? `${assumedOpenings} opening${assumedOpenings === 1 ? '' : 's'} without a measured size` : ''}` +
        `. Those figures use standard sizes and should be measured before they are billed.`,
        50, doc.y, { width: W });
    }
  }

  drawBrandFooter(doc, brand.cfg, W);
  doc.moveDown(0.5);
  doc.x = 50;
  doc.fontSize(7.5).fillColor(GRAY).text(
    'Wall area is the perimeter multiplied by the ceiling height, with every door, window, and opening subtracted. Measurements only, no pricing.',
    50, doc.y, { width: W, align: 'center' }
  );

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