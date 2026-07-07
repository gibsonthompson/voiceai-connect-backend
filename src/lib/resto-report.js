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

const MOLD_LABEL = {
  mold_likely: 'Mold likely', mold_possible: 'Mold possible',
  mold_unlikely: 'Mold unlikely', inconclusive: 'Inconclusive'
};

async function generateReportPdf(graph, downloadImage) {
  const { claim, structures, rooms, media, notes, contents, sketches, chambers, readings, dryStandards, moldScans } = graph;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
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
  const onBrand = contrastText(brand);
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

  h1(claim.policyholder_name || 'Claim');
  kv('Address', claim.address);
  kv('Type of loss', claim.type_of_loss);
  kv('Category / Class', `${claim.category_of_water ?? '-'} / ${claim.class_of_water ?? '-'}`);
  kv('Date of loss', dateOnly(claim.date_of_loss));
  kv('Carrier / Job #', claim.carrier_identifier);
  kv('Policy #', claim.policy_number);
  kv('Insurance company', claim.insurance_company);
  kv('Adjuster', claim.adjuster);
  kv('Project manager', claim.project_manager);

  // ---- Per structure ----
  let solTotalRcv = 0, solTotalAcv = 0;
  const allContents = [];   // { room, item } for the claim-level non-salvageable inventory

  for (const st of structures) {
    h1('Structure: ' + st.name);
    const stRooms = rooms.filter((r) => r.structure_id === st.id);

    for (const room of stRooms) {
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
        const cell = (W - 20) / 3, gap = 10, capH = 24;
        let col = 0, rowY = 0;
        for (const p of photos) {
          let buf = null;
          try { buf = await downloadImage(p.storage_path); } catch (_) { buf = null; }
          if (col === 0) { ensure(cell + capH + 10); rowY = doc.y; }
          const x = 50 + col * (cell + gap);
          if (buf) { try { doc.image(buf, x, rowY, { width: cell, height: cell, fit: [cell, cell] }); } catch (_) {} }
          if (p.caption) { doc.fontSize(7).fillColor(GRAY).text(String(p.caption), x, rowY + cell + 2, { width: cell, height: capH, ellipsis: true }); }
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

      // moisture maps — embed the single-source SVG (identical to the app)
      for (const s of rSketches) {
        const svg = buildMapSvg(s.canvas_json || {}, { width: 760, draw: 520 });
        const mm = svg.match(/width="(\d+)" height="(\d+)"/);
        const aspect = mm ? Number(mm[2]) / Number(mm[1]) : 0.6;
        const renderH = W * aspect;
        ensure(renderH + 28);
        h2('Moisture Map');
        const mapY = doc.y;
        SVGtoPDF(doc, svg, 50, mapY, { width: W });
        doc.y = mapY + renderH + 10;
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
      }
    }
  }

  // ---- Schedule of Loss total ----
  // ---- Contents: Non-Salvageable (Total-Loss) Inventory ----
  const lossList = allContents.filter(({ item }) => item.disposition === 'non_restorable' || item.disposition === 'disposed');
  if (lossList.length) {
    doc.addPage();
    h1('Contents \u2014 Non-Salvageable Inventory');
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

  h1('Schedule of Loss Summary');
  kv('Total RCV (non-salvageable contents)', money(solTotalRcv));
  kv('Total ACV (non-salvageable contents)', money(solTotalAcv));

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
  const [{ data: readings }, { data: dryStandards }] = await Promise.all([
    byChamber('resto_readings'), byChamber('resto_dry_standards')
  ]);
  return {
    claim, structures: structures || [], rooms: rooms || [], media: media || [],
    notes: notes || [], contents: contents || [], sketches: sketches || [],
    chambers: chambers || [], readings: readings || [], dryStandards: dryStandards || [],
    moldScans: dedupeLatest(moldScans || []), settings
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