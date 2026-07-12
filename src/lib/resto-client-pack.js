// ============================================================================
// CLIENT PACK  (photos + notes, for the homeowner)
// ----------------------------------------------------------------------------
// A DIFFERENT DOCUMENT FOR A DIFFERENT READER. The carrier report is adversarial:
// it exists to survive an adjuster's scrub, so it is full of selector codes,
// measured quantities, equipment-days, RCV/ACV, and scope. Handing that to a
// homeowner is confusing at best, and at worst hands them a negotiation surface
// on their own claim.
//
// So this pack contains NO line items, NO Xactimate codes, NO quantities, NO
// money, NO scope, and NO readiness scoring. Photos of their property, grouped by
// room and dated, and the notes the crew wrote. That is the whole document, and
// the exclusions are the design, not an oversight. Do not "helpfully" add totals.
// ============================================================================
const PDFDocument = require('pdfkit');
const {
  NAVY, DARK, GRAY, docToBuffer, fitImage, brandingOf, drawBrandHeader,
  drawBrandFooter, dateOnly, db, orgSettings, downloadImage
} = require('./resto-pdf-common');

async function generateClientPack(graph, getImage) {
  const { claim, rooms, media, notes, settings } = graph;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  const bufP = docToBuffer(doc);
  const brand = brandingOf(settings);
  const W = drawBrandHeader(doc, brand, 'Photos & Notes', null);

  const ensure = (h) => { if (doc.y + h > doc.page.height - 70) { doc.addPage(); doc.x = 50; doc.y = 60; } };
  const section = (t) => {
    ensure(44);
    doc.x = 50;
    const y = doc.y + 6;
    doc.save();
    doc.rect(50, y, W, 24).fill(brand.primary);
    doc.fillColor(brand.onBrand).fontSize(12.5).font('Helvetica-Bold').text(t, 56, y + 6.5, { width: W - 12, lineBreak: false });
    doc.restore();
    doc.fillColor(DARK).font('Helvetica');
    doc.x = 50; doc.y = y + 34;
  };

  // ---- plain-language intro (no jargon, no numbers) ----
  doc.x = 50;
  doc.fillColor(NAVY).fontSize(15).font('Helvetica-Bold').text(claim.policyholder_name || 'Your property', 50, doc.y, { width: W });
  doc.font('Helvetica').fontSize(9.5).fillColor(GRAY);
  if (claim.address) doc.text(claim.address, 50, doc.y + 2, { width: W });
  if (claim.date_of_loss) doc.text('Date of loss: ' + dateOnly(claim.date_of_loss), 50, doc.y + 1, { width: W });
  doc.moveDown(0.8);
  doc.fontSize(10).fillColor(DARK).text(
    'This is a record of the work at your property: the photographs our crew took on site, and the notes they wrote as they worked. It is for your records. Anything about pricing or your insurance estimate is handled separately.',
    50, doc.y, { width: W }
  );
  doc.moveDown(0.5);

  const photos = (media || []).filter((m) => m.type === 'photo');
  const roomName = {};
  (rooms || []).forEach((r) => { roomName[r.id] = r.name || 'Room'; });

  // group photos by room, rooms in their sort order, unassigned last
  const groups = [];
  for (const r of (rooms || [])) {
    const items = photos.filter((p) => p.room_id === r.id);
    if (items.length) groups.push({ label: r.name || 'Room', items });
  }
  const orphans = photos.filter((p) => !p.room_id || !roomName[p.room_id]);
  if (orphans.length) groups.push({ label: 'Other photos', items: orphans });

  // ---- photos: 2 per row, big enough to actually look at ----
  if (!photos.length) {
    section('Photos');
    doc.fontSize(9.5).fillColor(GRAY).text('No photos have been captured for this job yet.', 50, doc.y, { width: W });
  }

  for (const g of groups) {
    section(g.label);
    const gap = 14;
    const cell = (W - gap) / 2;         // 2 across, much larger than the carrier report's 3
    const capH = 26;
    let col = 0, rowY = doc.y;

    for (const p of g.items) {
      let buf = null;
      try { buf = await fitImage(await getImage(p.storage_path)); } catch (_) { buf = null; }
      if (col === 0) { ensure(cell + capH + 12); rowY = doc.y; }
      const x = 50 + col * (cell + gap);

      if (buf) {
        try { doc.image(buf, x, rowY, { width: cell, height: cell, fit: [cell, cell], align: 'center', valign: 'center' }); } catch (_) {}
      } else {
        doc.save().rect(x, rowY, cell, cell).fill('#EEF2F6').restore();
        doc.fontSize(8).fillColor('#9AA5B1').text('Photo unavailable', x, rowY + cell / 2 - 4, { width: cell, align: 'center' });
      }

      // date only. No GPS coordinates: this is the homeowner's own house, and a
      // lat/lng stamp reads as surveillance rather than proof to this reader.
      if (p.captured_at) {
        let when = '';
        try { when = new Date(p.captured_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) {}
        if (when) doc.fontSize(7.5).fillColor('#9AA5B1').text(when, x, rowY + cell + 3, { width: cell, height: 10, ellipsis: true });
      }
      if (p.caption) doc.fontSize(8.5).fillColor(DARK).text(String(p.caption), x, rowY + cell + 13, { width: cell, height: 12, ellipsis: true });

      col++;
      if (col === 2) { col = 0; doc.y = rowY + cell + capH + gap; doc.x = 50; }
    }
    if (col !== 0) { doc.y = rowY + cell + capH + gap; doc.x = 50; }
  }

  // ---- notes ----
  const noteList = (notes || []).filter((n) => (n.body || '').trim());
  if (noteList.length) {
    section('Notes from the crew');
    for (const n of noteList) {
      ensure(30);
      doc.x = 50;
      const where = n.room_id && roomName[n.room_id] ? roomName[n.room_id] : null;
      const when = n.created_at ? dateOnly(n.created_at) : null;
      const head = [where, when].filter(Boolean).join('  \u00b7  ');
      if (head) doc.fontSize(8).fillColor(GRAY).text(head, 50, doc.y, { width: W });
      doc.fontSize(10).fillColor(DARK).text(String(n.body), 50, doc.y + 1, { width: W });
      doc.moveDown(0.6);
    }
  }

  drawBrandFooter(doc, brand.cfg, W);
  doc.moveDown(0.5);
  doc.fontSize(7.5).fillColor(GRAY).text(
    'Questions about anything you see here? Call us, we are happy to walk you through it.',
    50, doc.y, { width: W, align: 'center' }
  );

  doc.end();
  return bufP;
}

// Targeted fetch: only what this document actually shows. Deliberately does not
// pull readings, equipment, contents, chambers, or signatures, so a client pack
// can never accidentally leak scope or pricing into the homeowner's copy.
async function fetchClientGraph(claimId) {
  const supabase = db();
  const { data: claim } = await supabase.from('resto_claims').select('*').eq('id', claimId).single();
  if (!claim) throw new Error('claim not found');

  const settings = await orgSettings(claim.org_id);

  const { data: structures } = await supabase.from('resto_structures').select('id').eq('claim_id', claimId).order('sort_order');
  const structureIds = (structures || []).map((s) => s.id);
  const { data: rooms } = structureIds.length
    ? await supabase.from('resto_rooms').select('id, name, sort_order').in('structure_id', structureIds).order('sort_order')
    : { data: [] };
  const roomIds = (rooms || []).map((r) => r.id);

  const { data: media } = await supabase.from('resto_media').select('*').eq('claim_id', claimId).eq('type', 'photo').order('captured_at');
  const { data: notes } = roomIds.length
    ? await supabase.from('resto_notes').select('*').in('room_id', roomIds).order('created_at')
    : { data: [] };

  return { claim, rooms: rooms || [], media: media || [], notes: notes || [], settings };
}

async function buildClientPack(claimId) {
  const graph = await fetchClientGraph(claimId);
  const pdf = await generateClientPack(graph, downloadImage);
  return { pdf, claim: graph.claim };
}

module.exports = { buildClientPack, generateClientPack, fetchClientGraph };