// ============================================================================
// RESTORATION CLAIM REPORT GENERATOR  (pdfkit, no headless browser)
// Builds the carrier-ready full project export from the claim graph:
// header + per structure/room photos, notes, contents (Schedule of Loss),
// moisture maps (rendered as vectors), and S500 drying logs.
//
// Used by routes/resto.js. Pure-ish: generateReportPdf(graph, downloadImage)
// takes an injected async image downloader so it is testable without storage.
// ============================================================================
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const { buildMapSvg } = require('./resto-map-svg');
const { Writable } = require('stream');
let sharp = null; try { sharp = require('sharp'); } catch (_) { sharp = null; } // optional: shrinks embedded photos
async function fitImage(buf) {
  if (!sharp || !buf) return buf;
  try { return await sharp(buf).rotate().resize(1100, 1100, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer(); }
  catch (_) { return buf; }
}

const NAVY = '#0E2A4D';
const DARK = '#16243B';
const GRAY = '#6b7280';
const EQUIP_LABEL = { air_mover: 'AM', dehumidifier: 'DH', air_scrubber: 'AS' };
const READING_LABEL = {
  psychrometric: 'Affected', exterior: 'Exterior', dehu_outlet: 'Dehu outlet', material_mc: 'Material MC'
};
const money = (n) => (n == null ? '-' : '$' + Number(n).toFixed(0));
const dateOnly = (d) => (d ? new Date(d).toLocaleDateString() : '-');

function docToBuffer(doc) {
  // Pipe into a collecting Writable (robust across Node versions; a direct
  // 'data' listener can race pdfkit's internal stream finalization).
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    doc.on('error', reject);
    doc.pipe(sink);
  });
}

// ---- per-visit reading helpers (canvas_json.moisturePoints[].readings) ----
const readingsOf = (mp) => (Array.isArray(mp && mp.readings) ? mp.readings : []);
const latestVal = (mp) => {
  const r = readingsOf(mp);
  if (!r.length) return mp && mp.label ? String(mp.label) : '';
  return String([...r].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))[r.length - 1].value || '');
};
const valOn = (mp, date) => { const r = readingsOf(mp).find((x) => x.date === date); return r ? String(r.value) : ''; };
const fmtDateShort = (d) => { try { return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }); } catch (_e) { return String(d); } };
const UPF = 40; // scene units per foot (matches the editor)
function polyArea(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const p1 = pts[i], p2 = pts[(i + 1) % pts.length]; a += p1[0] * p2[1] - p2[0] * p1[1]; } return Math.abs(a) / 2; }
function suggestEq(sqft, cls) {
  if (!sqft || sqft <= 0) return { airMovers: 0, dehus: 0 };
  const c = cls >= 1 && cls <= 4 ? cls : 2;
  const perAm = { 1: 70, 2: 60, 3: 50, 4: 50 }[c], perDh = { 1: 500, 2: 400, 3: 300, 4: 300 }[c];
  return { airMovers: Math.max(1, Math.ceil(sqft / perAm) + 1), dehus: Math.max(1, Math.ceil(sqft / perDh)) };
}

// Pick a legible text color for a brand background (white on dark, navy on light).
function contrastText(hex) {
  try {
    const h = String(hex).replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.6 ? '#0E2A4D' : '#ffffff';
  } catch (_e) { return '#ffffff'; }
}

const EQUIP_FULL = { air_mover: 'Air mover', dehumidifier: 'Dehumidifier', air_scrubber: 'Air scrubber', heater: 'Heater' };
function equipDays(e) {
  if (!e.placed_at) return 0;
  const start = new Date(e.placed_at).getTime();
  const end = (e.removed_at ? new Date(e.removed_at) : new Date()).getTime();
  return Math.max(1, Math.round((end - start) / 86400000) + (e.removed_at ? 1 : 0));
}
const MOLD_LABEL = {
  mold_likely: 'Mold likely', mold_possible: 'Mold possible',
  mold_unlikely: 'Mold unlikely', inconclusive: 'Inconclusive'
};

async function generateReportPdf(graph, downloadImage) {
  const { claim, structures, rooms, media, notes, contents, sketches, chambers, readings, dryStandards, signatures, equipment, moldScans } = graph;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  const bufP = docToBuffer(doc);
  const W = doc.page.width - 100; // content width

  const ensure = (h) => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };
  const h1 = (t) => { ensure(30); doc.moveDown(0.5).fillColor(NAVY).fontSize(15).font('Helvetica-Bold').text(t); doc.moveDown(0.2).fillColor(DARK).font('Helvetica'); };
  const h2 = (t) => { ensure(22); doc.moveDown(0.3).fillColor(DARK).fontSize(12).font('Helvetica-Bold').text(t); doc.font('Helvetica'); };
  const kv = (k, v) => { doc.fontSize(9).fillColor(GRAY).text(k + ': ', { continued: true }).fillColor(DARK).text(String(v ?? '-')); };

  // ---- Cover / header (org branding) ----
  const rawSettings = graph.settings || {};
  const brandCfg = rawSettings.report_branding || rawSettings;   // branding stored in report_branding jsonb
  const brand = /^#[0-9a-fA-F]{6}$/.test(brandCfg.primary_color || '') ? brandCfg.primary_color : NAVY;
  const stampGps = (rawSettings.stamp_gps !== false);   // GPS stamping honors the org toggle (default on)
  const onBrand = contrastText(brand);
  const toc = [];
  const currentDisplayPage = () => doc.bufferedPageRange().count; // cover=1, toc=2, body=3+
  const section = (t) => {
    ensure(46);
    toc.push({ title: t, page: currentDisplayPage() });
    doc.moveDown(0.4);
    const y = doc.y;
    doc.save();
    doc.rect(50, y, W, 24).fill(brand);
    doc.fillColor(contrastText(brand)).fontSize(12.5).font('Helvetica-Bold').text(t, 56, y + 6.5, { width: W - 12, lineBreak: false });
    doc.restore();
    doc.fillColor(DARK).font('Helvetica');
    doc.y = y + 32;
  };
  doc.rect(0, 0, doc.page.width, 90).fill(brand);
  if (brandCfg.logo_data_url) {
    try {
      const b64 = String(brandCfg.logo_data_url).split(',').pop();
      if (b64) doc.image(Buffer.from(b64, 'base64'), doc.page.width - 50 - 150, 20, { fit: [150, 50], align: 'right', valign: 'center' });
    } catch (_e) {}
  }
  const titleW = doc.page.width - 250;
  doc.fillColor(onBrand).font('Helvetica-Bold').fontSize(20).text('Property Restoration Report', 50, 24, { width: titleW, lineBreak: false });
  const headSub = [brandCfg.company_name, brandCfg.phone].filter(Boolean).join('  ·  ');
  doc.font('Helvetica');
  if (headSub) doc.fillColor(onBrand).fontSize(10).text(headSub, 50, 52, { width: titleW, lineBreak: false });
  doc.fillColor(onBrand).fontSize(9).text('Prepared ' + new Date().toLocaleString(), 50, headSub ? 68 : 58, { width: titleW, lineBreak: false });
  doc.fillColor(DARK).font('Helvetica');
  doc.y = 110;

  doc.moveDown(0.2);
  doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold').text('LOSS SUMMARY');
  doc.moveTo(50, doc.y + 2).lineTo(50 + W, doc.y + 2).lineWidth(1).strokeColor(brand).stroke();
  doc.moveDown(0.5).font('Helvetica');
  h1(claim.policyholder_name || 'Claim');
  kv('Property address', claim.address);
  kv('Type of loss', claim.type_of_loss);
  kv('Water category / drying class', `Category ${claim.category_of_water ?? '-'} / Class ${claim.class_of_water ?? '-'}`);
  kv('Date of loss', dateOnly(claim.date_of_loss));
  kv('Insurance company', claim.insurance_company);
  kv('Claim / job number', claim.carrier_identifier);
  kv('Policy number', claim.policy_number);
  kv('Adjuster', claim.adjuster);
  kv('Project manager', claim.project_manager);

  const _addr = claim.address || '';
  const _comp = brandCfg.company_name || 'Property Restoration Report';
  doc.addPage();   // page 2: reserved for the table of contents (filled at the end)
  doc.addPage();   // page 3: body starts here (running header stamped at the end)

  // ---- Per structure ----
  let solTotalRcv = 0, solTotalAcv = 0;
  const eqTotals = {};   // type -> unit-days, for the claim-level equipment summary
  const allContents = [];   // { room, item } for the claim-level non-salvageable inventory

  const sketchHasContent = (s) => {
    const cj = s.canvas_json || {};
    return (cj.wetAreas && cj.wetAreas.length) || (cj.moisturePoints && cj.moisturePoints.length) ||
           (cj.equipment && cj.equipment.length) || cj.roomShape || (cj.walls && cj.walls.length) ||
           (cj.vertices && cj.vertices.length) || (cj.lines && cj.lines.length);
  };
  const roomHasContent = (room) => {
    const rMedia = media.filter((m) => m.room_id === room.id);
    const rSketches = sketches.filter((s) => s.room_id === room.id);
    return notes.some((n) => n.room_id === room.id) ||
           rMedia.some((m) => m.type === 'photo') ||
           contents.some((c) => c.room_id === room.id) ||
           (moldScans || []).some((sc) => rMedia.some((m) => m.id === sc.media_id)) ||
           rSketches.some(sketchHasContent);
  };

  for (const st of structures) {
    const stRooms = rooms.filter((r) => r.structure_id === st.id);
    const contentRooms = stRooms.filter(roomHasContent);
    if (!contentRooms.length) continue;   // skip structures with no documented rooms (no blank pages)
    section('Structure: ' + st.name);

    for (const room of contentRooms) {
      h2('Room: ' + room.name);
      const rNotes = notes.filter((n) => n.room_id === room.id);
      const rMedia = media.filter((m) => m.room_id === room.id);
      const rContents = contents.filter((c) => c.room_id === room.id);
      const rSketches = sketches.filter((s) => s.room_id === room.id);
      const rScans = (moldScans || []).filter((sc) => rMedia.some((m) => m.id === sc.media_id));

      if (rNotes.length) {
        doc.fontSize(9).fillColor(DARK);
        rNotes.forEach((n) => { ensure(20); doc.text('• ' + (n.body || '')); });
      }

      // photos (3 per row, with caption/note under each)
      const photos = rMedia.filter((m) => m.type === 'photo');
      if (photos.length && downloadImage) {
        const cell = (W - 20) / 3, gap = 10, capH = 30;
        let col = 0, rowY = 0;
        for (const p of photos) {
          let buf = null;
          try { buf = await fitImage(await downloadImage(p.storage_path)); } catch (_) { buf = null; }
          if (col === 0) { ensure(cell + capH + 10); rowY = doc.y; }
          const x = 50 + col * (cell + gap);
          if (buf) {
            try { doc.image(buf, x, rowY, { width: cell, height: cell, fit: [cell, cell] }); } catch (_) {}
            // clickable: link the thumbnail to the full-resolution original (view/download in a browser)
            try {
              const { data: su } = await db().storage.from('resto-media').createSignedUrl(p.storage_path, 60 * 60 * 24 * 365);
              if (su && su.signedUrl) {
                doc.link(x, rowY, cell, cell, su.signedUrl);
                doc.save().fillColor('#0E2A4D').rect(x + cell - 15, rowY + cell - 12, 15, 12).fillOpacity(0.65).fill().restore();
                doc.fillColor('#ffffff').fontSize(8).text('\u2197', x + cell - 12, rowY + cell - 11, { lineBreak: false }).fillColor(DARK);
              }
            } catch (_) {}
          }
          // timestamp + GPS stamp (proof of when/where the photo was taken)
          const stampParts = [];
          if (p.captured_at) { try { stampParts.push(new Date(p.captured_at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' })); } catch (_) {} }
          if (stampGps && p.lat != null && p.lng != null) stampParts.push(`${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}`);
          if (stampParts.length) doc.fontSize(6.5).fillColor('#9AA5B1').text(stampParts.join('  \u00b7  '), x, rowY + cell + 2, { width: cell, height: 9, ellipsis: true });
          if (p.caption) doc.fontSize(7).fillColor(GRAY).text(String(p.caption), x, rowY + cell + 12, { width: cell, height: 16, ellipsis: true });
          col++;
          if (col === 3) { col = 0; doc.y = rowY + cell + capH + gap; }
        }
        if (col !== 0) doc.y = rowY + cell + capH + gap;
      }

      // AI mold screening (visual, not a lab diagnosis)
      if (rScans.length) {
        h2('Mold Screening');
        doc.fontSize(8).fillColor(GRAY).text('AI visual screening only, not a lab diagnosis. Confirm suspected growth with lab or air sampling.');
        rScans.forEach((sc) => {
          ensure(16);
          const lab = sc.recommend_lab_sampling ? ' · lab sampling recommended' : '';
          doc.fontSize(9).fillColor(DARK).text(
            `${MOLD_LABEL[sc.verdict] || sc.verdict} (${sc.confidence ?? 0}% confidence)${lab}${sc.summary ? ' — ' + sc.summary : ''}`
          );
        });
      }

      // contents (Schedule of Loss rows)
      if (rContents.length) {
        h2('Contents');
        const dispLabel = (d) => d === 'non_restorable' ? 'Total loss' : d === 'disposed' ? 'Disposed' : d === 'restorable' ? 'Restorable' : '-';
        rContents.forEach((c) => {
          ensure(16);
          const loss = c.disposition === 'non_restorable' || c.disposition === 'disposed';
          if (loss) {
            solTotalRcv += (Number(c.replacement_cost) || 0) * (c.quantity || 1);
            solTotalAcv += (Number(c.acv) || 0) * (c.quantity || 1);
          }
          allContents.push({ room: room.name, item: c });
          const idParts = [c.category, [c.brand, c.model].filter(Boolean).join(' ')].filter(Boolean).join(' \u00b7 ') || 'n/a';
          const valParts = loss ? ` \u00b7 RCV ${money(c.replacement_cost)} \u00b7 ACV ${money(c.acv)}` : '';
          doc.fontSize(9).fillColor(DARK).text(
            `${c.description || 'Item'} (${idParts}) \u00b7 qty ${c.quantity ?? 1} \u00b7 ${dispLabel(c.disposition)}${c.packed_out ? ' \u00b7 packed out' : ''}${valParts}`
          );
        });
      }

      // moisture maps — only sketches that actually contain data (skip empty grids)
      for (const s of rSketches.filter(sketchHasContent)) {
        const svg = buildMapSvg(s.canvas_json || {}, { width: 760, draw: 520 });
        const mm = svg.match(/width="(\d+)" height="(\d+)"/);
        const aspect = mm ? Number(mm[2]) / Number(mm[1]) : 0.6;
        const renderH = W * aspect;
        ensure(renderH + 60);
        doc.moveDown(0.3).fillColor(NAVY).fontSize(12).font('Helvetica-Bold').text('Moisture Map \u2014 ' + (room.name || 'Room'));
        doc.font('Helvetica');
        const mapY = doc.y + 2;
        SVGtoPDF(doc, svg, 50, mapY, { width: W });
        doc.y = mapY + renderH + 4;
        // legend (only the symbols actually used stay meaningful, but show the full key)
        const legend = [
          ['#7DD3FC', 'Wet area'], ['#29ABE6', 'Air mover'], ['#11B5C6', 'Dehumidifier'],
          ['#64748B', 'Air scrubber'], ['#1483C2', 'Moisture reading'], ['#F59E0B', 'Flood cut'],
          ['#8B5CF6', 'Containment'], ['#DC2626', 'Origin of loss']
        ];
        doc.fontSize(7.5).font('Helvetica');
        let lx = 50, ly = doc.y;
        legend.forEach(([c, lbl]) => {
          const wItem = doc.widthOfString(lbl) + 16;
          if (lx + wItem > 50 + W) { lx = 50; ly += 13; }
          doc.circle(lx + 3, ly + 3.5, 3).fill(c);
          doc.fillColor(GRAY).text(lbl, lx + 9, ly, { lineBreak: false });
          lx += wItem + 8;
        });
        doc.y = ly + 16; doc.fillColor(DARK).font('Helvetica');
      }

      // drying trend: per-visit moisture readings for this room
      const roomPoints = [];
      for (const s of rSketches) for (const mp of ((s.canvas_json && s.canvas_json.moisturePoints) || [])) roomPoints.push(mp);
      const dateSet = new Set();
      for (const mp of roomPoints) for (const r of readingsOf(mp)) if (r.date) dateSet.add(r.date);
      const dates = [...dateSet].sort();
      const trendPts = roomPoints.filter((mp) => readingsOf(mp).some((r) => r.date));
      if (dates.length && trendPts.length) {
        ensure(30 + trendPts.length * 14);
        h2('Moisture Readings (Drying Trend)');
        const startX = 50, labelW = 130;
        const colW = Math.min(70, (W - labelW) / dates.length);
        let ty = doc.y + 2;
        doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY);
        doc.text('Location / Material', startX, ty, { width: labelW });
        dates.forEach((d, i) => doc.text(fmtDateShort(d), startX + labelW + i * colW, ty, { width: colW, align: 'center' }));
        ty += 13;
        doc.font('Helvetica');
        trendPts.forEach((mp, idx) => {
          const locName = mp.label || '';
          const cell = mp.material && locName ? `${mp.material} — ${locName}` : (mp.material || locName || ('Point ' + (idx + 1)));
          doc.fontSize(8).fillColor(DARK).text(cell, startX, ty, { width: labelW });
          dates.forEach((d, i) => doc.fillColor(DARK).text(valOn(mp, d) || '-', startX + labelW + i * colW, ty, { width: colW, align: 'center' }));
          ty += 12;
        });
        doc.y = ty + 8;
      }

      // affected materials + S500 equipment adequacy (from the room's maps)
      const wallsAll = [];
      let placedAm = 0, placedDh = 0, clsRoom = 0;
      for (const s of rSketches) {
        const cj = s.canvas_json || {};
        if (cj.classOfLoss) clsRoom = cj.classOfLoss;
        for (const w of (cj.walls || [])) wallsAll.push(w);
        for (const e of (cj.equipment || [])) { if (e.type === 'air_mover') placedAm++; else if (e.type === 'dehumidifier') placedDh++; }
      }
      const wetMats = [];
      for (const s2 of rSketches) for (const wa of ((s2.canvas_json || {}).wetAreas || [])) if (wa.material) wetMats.push(wa.surface && wa.surface !== 'floor' ? `${wa.surface} ${wa.material}` : wa.material);
      const materials = [...new Set([...wallsAll.map((w) => w && w.material).filter(Boolean), ...wetMats])];
      if (materials.length) { ensure(16); h2('Affected Materials'); doc.fontSize(9).fillColor(DARK).text(materials.join(', ')); }
      let sqft = 0;
      for (const w of wallsAll) if (w.points && w.points.length >= 3) sqft += polyArea(w.points);
      sqft = sqft / (UPF * UPF);
      if (sqft > 0) {
        const sug = suggestEq(sqft, clsRoom);
        ensure(16); h2('Equipment Check (S500 guide)');
        doc.fontSize(9).fillColor(DARK).text(
          `Class ${clsRoom || 2} · ${Math.round(sqft)} sq ft · Air movers ${placedAm} placed / ${sug.airMovers} suggested · Dehumidifiers ${placedDh} / ${sug.dehus}`
        );
      }

      // demolition + containment scope — measured quantities mapped to Xactimate categories
      let fcLf = 0, fcSqft = 0, contSqft = 0, contCount = 0; const fcByH = {};
      for (const s of rSketches) {
        const cj = s.canvas_json || {}; const wmap = {}; (cj.walls || []).forEach((w) => { wmap[w.id] = w; });
        for (const fc of (cj.floodCuts || [])) {
          const w = wmap[fc.wallId]; if (!w || !w.points) continue;
          const n = w.points.length, A = w.points[fc.edge], B = w.points[(fc.edge + 1) % n];
          if (!A || !B) continue;
          const full = Math.hypot(B[0] - A[0], B[1] - A[1]) / UPF;
          const lf = fc.lengthFt != null ? Math.min(fc.lengthFt, full) : full;
          const hLabel = fc.heightFt < 1 ? '4"' : fc.heightFt + "'";
          fcLf += lf; fcSqft += lf * fc.heightFt; fcByH[hLabel] = (fcByH[hLabel] || 0) + lf;
        }
        for (const ct of (cj.containments || [])) {
          if (ct.widthFt != null) { contSqft += ct.widthFt * ct.heightFt; contCount++; }
          else if (ct.from && ct.to) { contSqft += (Math.hypot(ct.to[0] - ct.from[0], ct.to[1] - ct.from[1]) / UPF) * (ct.heightFt || 8); contCount++; }
        }
      }
      if (fcLf > 0 || contCount > 0) {
        ensure(16); h2('Demolition & Containment (Xactimate scope)');
        if (fcLf > 0) {
          const byH = Object.keys(fcByH).map((h) => `${Math.round(fcByH[h])} linear ft @ ${h}`).join(', ');
          doc.fontSize(9).fillColor(DARK).text(`Flood cut (DRYW): ${byH} = ${Math.round(fcSqft)} sq ft drywall removed`);
        }
        if (contCount > 0) {
          doc.fontSize(9).fillColor(DARK).text(`Containment (PLASTIC 4 mil): ${contCount} barrier${contCount === 1 ? '' : 's'} = ${Math.round(contSqft)} sq ft`);
        }
      }
    }

    // ---- Hydro for this structure ----
    const stChambers = chambers.filter((c) => c.structure_id === st.id);
    if (stChambers.length) {
      h2('Structural Drying (S500)');
      for (const ch of stChambers) {
        ensure(40);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK).text(ch.name).font('Helvetica');
        kv('Dimensions', ch.length_ft && ch.width_ft ? `${ch.length_ft} x ${ch.width_ft} x ${ch.height_ft ?? 8} ft (Class ${ch.class_of_loss ?? '-'})` : '-');

        const cStd = dryStandards.filter((d) => d.chamber_id === ch.id);
        cStd.forEach((d) => kv('Dry standard', `${d.material} = ${d.goal_value ?? '-'}`));

        const cReadings = readings.filter((r) => r.chamber_id === ch.id)
          .sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));

        // ---- Drying analysis (the "dry map") ----
        const affected = cReadings.filter((r) => r.reading_type === 'psychrometric');
        const dehu = cReadings.filter((r) => r.reading_type === 'dehu_outlet');
        const mc = cReadings.filter((r) => r.reading_type === 'material_mc' && r.material_mc != null);
        const lastOf = (a) => (a.length ? a[a.length - 1] : null);
        const la = lastOf(affected), ld = lastOf(dehu);
        const prevA = affected.length >= 2 ? affected[affected.length - 2] : null;
        if (la || mc.length) {
          ensure(24);
          doc.moveDown(0.2).fontSize(8.5).fillColor(DARK).font('Helvetica-Bold').text('Drying status').font('Helvetica');
          const bits = [];
          if (la && la.gpp != null) bits.push(`Affected ${la.gpp} GPP`);
          if (la && prevA && la.gpp != null && prevA.gpp != null) { const t = (la.gpp - prevA.gpp).toFixed(0); bits.push(`trend ${Number(t) >= 0 ? '+' : ''}${t} GPP`); }
          if (la && ld && la.gpp != null && ld.gpp != null) bits.push(`grain depression ${(la.gpp - ld.gpp).toFixed(0)} GPP`);
          if (la && la.rh_pct != null) bits.push(`affected RH ${la.rh_pct}%`);
          if (bits.length) doc.fontSize(8.5).fillColor(GRAY).text('   ' + bits.join('  \u00b7  '));
          const trend = la && prevA && la.gpp != null && prevA.gpp != null ? la.gpp - prevA.gpp : null;
          if (trend != null && trend >= -1 && affected.length >= 2)
            doc.fontSize(8.5).fillColor('#B91C1C').text('   Stalled: GPP not dropping \u2014 check air infiltration, dehumidification capacity, or hidden moisture.');

          const goalFor = (m) => { const x = cStd.find((z) => (z.material || '').toLowerCase() === (m || '').toLowerCase()); return x ? x.goal_value : null; };
          const locMap = {};
          mc.forEach((r) => { const k = (r.location_label || 'Point') + '|' + (r.material || ''); (locMap[k] = locMap[k] || []).push(r); });
          const locs = Object.keys(locMap).map((k) => { const rs = locMap[k]; const l = rs[rs.length - 1]; const goal = goalFor(l.material); return { label: l.location_label || 'Point', material: l.material, val: l.material_mc, goal, atGoal: goal != null && l.material_mc != null ? l.material_mc <= goal : null }; });
          const withGoal = locs.filter((l) => l.atGoal !== null);
          const atGoalN = withGoal.filter((l) => l.atGoal).length;
          if (locs.length) {
            doc.moveDown(0.15).fontSize(8.5).fillColor(DARK).font('Helvetica-Bold').text('Material moisture vs dry goal').font('Helvetica');
            locs.forEach((l) => { ensure(11); doc.fontSize(8.5).fillColor(l.atGoal === false ? '#B45309' : DARK).text(`   ${l.label}${l.material ? ' \u00b7 ' + l.material : ''}: ${l.val}${l.goal != null ? ' (goal ' + l.goal + ')' : ''}${l.atGoal === true ? ' \u2014 at goal' : l.atGoal === false ? ' \u2014 above goal' : ''}`); });
            if (withGoal.length) doc.fontSize(8.5).fillColor(atGoalN === withGoal.length ? '#15803D' : '#B45309').font('Helvetica-Bold').text(`   ${atGoalN === withGoal.length ? 'All monitored points at dry goal' : atGoalN + ' of ' + withGoal.length + ' points at goal'}`).font('Helvetica');
          }
        }
        if (cReadings.length) {
          doc.moveDown(0.2).fontSize(8.5).fillColor(GRAY).text('Drying log (date · location · temp/RH · GPP · dew):');
          let lastDay = '';
          cReadings.forEach((r) => {
            ensure(13);
            const day = dateOnly(r.captured_at);
            if (day !== lastDay) { doc.fontSize(8.5).fillColor(DARK).font('Helvetica-Bold').text(day); doc.font('Helvetica'); lastDay = day; }
            doc.fontSize(8.5).fillColor(DARK).text(
              `   ${READING_LABEL[r.reading_type] || r.reading_type}${r.location_label ? ' · ' + r.location_label : ''} · ${r.temp_f}F/${r.rh_pct}% · ${r.gpp} GPP · dew ${r.dew_point}F`
            );
          });
        }

        // Equipment usage — the equipment-days billing justification
        const cEquip = (equipment || []).filter((e) => e.chamber_id === ch.id);
        if (cEquip.length) {
          h2('Equipment usage');
          const cols = [{ t: 'Equipment', w: 0.30 }, { t: 'Qty', w: 0.08 }, { t: 'Placed', w: 0.18 }, { t: 'Removed', w: 0.18 }, { t: 'Days', w: 0.09 }, { t: 'Unit-days', w: 0.17 }];
          const x0 = doc.x, tblW = W;
          const row = (cells, bold) => {
            ensure(14); const y = doc.y; let cx = x0;
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(DARK);
            cols.forEach((c, i) => { doc.text(String(cells[i] ?? ''), cx + 2, y, { width: tblW * c.w - 4, ellipsis: true }); cx += tblW * c.w; });
            doc.font('Helvetica'); doc.moveTo(x0, doc.y + 2).lineTo(x0 + tblW, doc.y + 2).strokeColor('#E5EAF0').stroke(); doc.moveDown(0.25);
          };
          row(cols.map((c) => c.t), true);
          cEquip.forEach((e) => {
            const days = equipDays(e), qty = e.actual_placed || 1;
            row([EQUIP_FULL[e.type] || e.type, qty, e.placed_at ? dateOnly(e.placed_at) : '-', e.removed_at ? dateOnly(e.removed_at) : 'on site', days, qty * days]);
            eqTotals[e.type] = (eqTotals[e.type] || 0) + qty * days;
          });
          doc.moveDown(0.3);
        }
      }
    }
  }

  // ---- Schedule of Loss total ----
  // ---- Contents: Non-Salvageable (Total-Loss) Inventory ----
  const lossList = allContents.filter(({ item }) => item.disposition === 'non_restorable' || item.disposition === 'disposed');
  if (lossList.length) {
    doc.addPage();
    section('Contents \u2014 Non-Salvageable Inventory');
    doc.fontSize(8.5).fillColor(GRAY).text('Personal property documented as a total loss, for the Coverage C replacement claim.').moveDown(0.5);
    const cols = [
      { t: 'Room', w: 0.16 }, { t: 'Item', w: 0.26 }, { t: 'Make / model', w: 0.20 },
      { t: 'Qty', w: 0.06 }, { t: 'Age', w: 0.08 }, { t: 'RCV', w: 0.12 }, { t: 'ACV', w: 0.12 }
    ];
    const x0 = doc.x, tblW = W;
    const drawRow = (cells, bold) => {
      ensure(15); const y = doc.y; let cx = x0;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(bold ? DARK : DARK);
      cols.forEach((c, i) => { doc.text(String(cells[i] ?? ''), cx + 2, y, { width: tblW * c.w - 4, ellipsis: true }); cx += tblW * c.w; });
      doc.font('Helvetica');
      doc.moveTo(x0, doc.y + 2).lineTo(x0 + tblW, doc.y + 2).strokeColor('#E5EAF0').stroke();
      doc.moveDown(0.3);
    };
    drawRow(cols.map((c) => c.t), true);
    lossList.forEach(({ room, item }) => {
      const age = item.age_years != null ? `${item.age_years}y` : (item.year_purchased ? String(item.year_purchased) : '-');
      drawRow([room || '-', item.description || 'Item', [item.brand, item.model].filter(Boolean).join(' ') || '-', item.quantity ?? 1, age, money(item.replacement_cost), money(item.acv)]);
    });
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text(`Total  \u00b7  ${lossList.length} item${lossList.length === 1 ? '' : 's'}  \u00b7  RCV ${money(solTotalRcv)}  \u00b7  ACV ${money(solTotalAcv)}`).font('Helvetica');
    doc.moveDown(0.8);
  }

  if (Object.keys(eqTotals).length) {
    section('Equipment Usage Summary');
    doc.fontSize(8.5).fillColor(GRAY).text('Total equipment-days across all drying chambers, for estimate line-item justification.').moveDown(0.3).fillColor(DARK);
    Object.keys(eqTotals).forEach((t) => kv(EQUIP_FULL[t] || t, `${eqTotals[t]} unit-days`));
  }

  section('Schedule of Loss Summary');
  kv('Total RCV (non-salvageable contents)', money(solTotalRcv));
  kv('Total ACV (non-salvageable contents)', money(solTotalAcv));

  // ---- Authorizations & Signatures ----
  if (signatures && signatures.length) {
    doc.addPage();
    section('Authorizations & Signatures');
    const titleFor = (t) => t === 'work_authorization' ? 'Work Authorization & Direction to Pay' : t === 'completion_certificate' ? 'Certificate of Completion & Satisfaction' : t;
    for (const sig of signatures) {
      ensure(70);
      doc.fontSize(10.5).font('Helvetica-Bold').fillColor(DARK).text(titleFor(sig.doc_type)).font('Helvetica');
      const snap = sig.doc_snapshot || {};
      if (snap.intro) doc.moveDown(0.15).fontSize(8.5).fillColor(DARK).text(snap.intro);
      (snap.items || []).forEach((it, i) => { ensure(12); doc.fontSize(8).fillColor(GRAY).text(`${i + 1}. ${it}`); });
      doc.moveDown(0.3);
      if (sig.signature_data && sig.signature_data.indexOf('base64,') >= 0) {
        try { const buf = Buffer.from(sig.signature_data.split('base64,')[1], 'base64'); doc.image(buf, { width: 150 }); } catch (e) { /* skip bad image */ }
      }
      doc.fontSize(8.5).fillColor(DARK).font('Helvetica-Bold').text(`Signed by ${sig.signer_name || '-'} on ${new Date(sig.signed_at).toLocaleDateString()}`).font('Helvetica');
      doc.moveDown(0.8);
    }
  }

  // ---- Branding footer ----
  {
    const bits = [brandCfg.company_name, brandCfg.phone, brandCfg.email, brandCfg.website, brandCfg.license_number ? ('Lic# ' + brandCfg.license_number) : null].filter(Boolean).join('  ·  ');
    if (bits) doc.moveDown(1).font('Helvetica-Bold').fontSize(8).fillColor(DARK).text(bits, { width: W, align: 'center' }).font('Helvetica');
    if (brandCfg.report_footer) doc.moveDown(0.2).fontSize(8).fillColor(GRAY).text(brandCfg.report_footer, { width: W, align: 'center' });
  }

  // ---- Integrity note ----
  doc.moveDown(0.6).fontSize(7.5).fillColor(GRAY).text(
    `Generated ${new Date().toLocaleString()}. Timestamps and readings reflect captured field data.`,
    { width: W, align: 'center' }
  );

  // Render the table of contents on the reserved page 2.
  try {
    const r0 = doc.bufferedPageRange();
    doc.switchToPage(r0.start + 1);
    doc.fillColor(NAVY).fontSize(15).font('Helvetica-Bold').text('Contents', 50, 60);
    doc.moveTo(50, doc.y + 3).lineTo(50 + W, doc.y + 3).lineWidth(1).strokeColor(brand).stroke();
    doc.moveDown(0.6).font('Helvetica');
    toc.forEach((e) => {
      const y = doc.y;
      doc.fontSize(10).fillColor(DARK).text(e.title, 50, y, { width: W - 40, lineBreak: false });
      doc.fontSize(10).fillColor(GRAY).text(String(e.page), 50, y, { width: W, align: 'right', lineBreak: false });
      doc.moveDown(0.55);
    });
  } catch (_e) { /* TOC is best-effort */ }

  // Stamp a running header + footer on every page except the cover (page 0).
  try {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      if (i === range.start) continue; // cover keeps its own header band
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;  // footer sits below the normal margin; without this pdfkit appends a blank page per draw
      doc.save();
      doc.fontSize(7).font('Helvetica').fillColor(GRAY);
      doc.text(_comp, 50, 24, { width: W, lineBreak: false });
      if (_addr) doc.text(_addr, 50, 24, { width: W, align: 'right', lineBreak: false });
      doc.moveTo(50, 38).lineTo(doc.page.width - 50, 38).lineWidth(0.5).strokeColor('#E5EAF0').stroke();
      const fy = doc.page.height - 34;
      if (_addr) doc.text('Claim: ' + _addr, 50, fy, { width: W, lineBreak: false });
      doc.text('Page ' + (i - range.start + 1), 50, fy, { width: W, align: 'right', lineBreak: false });
      doc.restore();
    }
  } catch (_e) { /* header/footer stamping is best-effort */ }

  doc.end();
  return bufP;
}


// --- Supabase-backed helpers (lazy require so generateReportPdf stays testable) ---
function db() { return require('./supabase').supabase; }

// Keep only the most recent scan per media (rows arrive newest-first).
function dedupeLatest(rows) {
  const seen = new Set(); const out = [];
  for (const r of rows) { if (!seen.has(r.media_id)) { seen.add(r.media_id); out.push(r); } }
  return out;
}

async function fetchClaimGraph(claimId) {
  const supabase = db();
  const { data: claim } = await supabase.from('resto_claims').select('*').eq('id', claimId).single();
  let settings = null;
  if (claim) { const { data: sRows } = await supabase.from('resto_org_settings').select('*').eq('org_id', claim.org_id).limit(1); settings = (sRows && sRows[0]) || null; }
  const { data: structures } = await supabase.from('resto_structures').select('*').eq('claim_id', claimId).order('sort_order');
  const structureIds = (structures || []).map((s) => s.id);
  const { data: rooms } = structureIds.length
    ? await supabase.from('resto_rooms').select('*').in('structure_id', structureIds).order('sort_order')
    : { data: [] };
  const roomIds = (rooms || []).map((r) => r.id);
  const byRoom = (tbl) => (roomIds.length ? supabase.from(tbl).select('*').in('room_id', roomIds) : Promise.resolve({ data: [] }));
  const [{ data: media }, { data: notes }, { data: contents }, { data: sketches }] = await Promise.all([
    byRoom('resto_media'), byRoom('resto_notes'), byRoom('resto_contents_items'), byRoom('resto_sketches')
  ]);
  const mediaIds = (media || []).map((m) => m.id);
  const { data: moldScans } = mediaIds.length
    ? await supabase.from('resto_mold_scans').select('*').in('media_id', mediaIds).order('created_at', { ascending: false })
    : { data: [] };
  const { data: chambers } = structureIds.length
    ? await supabase.from('resto_drying_chambers').select('*').in('structure_id', structureIds)
    : { data: [] };
  const chamberIds = (chambers || []).map((c) => c.id);
  const byChamber = (tbl) => (chamberIds.length ? supabase.from(tbl).select('*').in('chamber_id', chamberIds) : Promise.resolve({ data: [] }));
  const [{ data: readings }, { data: dryStandards }, { data: equipment }] = await Promise.all([
    byChamber('resto_readings'), byChamber('resto_dry_standards'), byChamber('resto_equipment')
  ]);
  const { data: signatures } = await supabase.from('resto_claim_signatures').select('*').eq('claim_id', claimId);
  return {
    claim, structures: structures || [], rooms: rooms || [], media: media || [],
    notes: notes || [], contents: contents || [], sketches: sketches || [],
    chambers: chambers || [], readings: readings || [], dryStandards: dryStandards || [],
    signatures: signatures || [], equipment: equipment || [], moldScans: dedupeLatest(moldScans || []), settings
  };
}

async function downloadImage(path) {
  try {
    const { data, error } = await db().storage.from('resto-media').download(path);
    if (error || !data) return null;
    const ab = await data.arrayBuffer();
    return Buffer.from(ab);
  } catch (_) { return null; }
}

async function buildClaimReport(claimId) {
  const graph = await fetchClaimGraph(claimId);
  if (!graph.claim) throw new Error('claim not found');
  const pdf = await generateReportPdf(graph, downloadImage);
  return { pdf, claim: graph.claim };
}

module.exports = { generateReportPdf, buildMapSvg, fetchClaimGraph, buildClaimReport };