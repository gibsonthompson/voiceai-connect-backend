// ============================================================================
// RESTORATION CLAIM REPORT GENERATOR  (pdfkit, no headless browser)
// Builds the carrier-ready full project export from the claim graph:
// header + per structure/room photos, notes, contents (Schedule of Loss),
// moisture maps (embedded single-source SVG), and S500 drying logs.
// ============================================================================
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const { buildMapSvg } = require('./resto-map-svg');
const { Writable } = require('stream');

const NAVY = '#0E2A4D';
const DARK = '#16243B';
const GRAY = '#6b7280';
const READING_LABEL = {
  psychrometric: 'Affected', exterior: 'Exterior', dehu_outlet: 'Dehu outlet', material_mc: 'Material MC'
};
const money = (n) => (n == null ? '-' : '$' + Number(n).toFixed(0));
const dateOnly = (d) => (d ? new Date(d).toLocaleDateString() : '-');

function docToBuffer(doc) {
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

  // ---- Cover / header ----
  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor('white').fontSize(20).font('Helvetica-Bold').text('Property Restoration Report', 50, 32);
  doc.fontSize(10).font('Helvetica').text('Prepared ' + new Date().toLocaleString(), 50, 60);
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

      // photos (3 per row)
      const photos = rMedia.filter((m) => m.type === 'photo');
      if (photos.length && downloadImage) {
        const cell = (W - 20) / 3, gap = 10;
        let col = 0, rowY = 0;
        for (const p of photos) {
          let buf = null;
          try { buf = await downloadImage(p.storage_path); } catch (_) { buf = null; }
          if (!buf) continue;
          if (col === 0) { ensure(cell + 10); rowY = doc.y; }
          const x = 50 + col * (cell + gap);
          try { doc.image(buf, x, rowY, { width: cell, height: cell, fit: [cell, cell] }); } catch (_) {}
          col++;
          if (col === 3) { col = 0; doc.y = rowY + cell + gap; }
        }
        if (col !== 0) doc.y = rowY + cell + gap;
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
        rContents.forEach((c) => {
          ensure(16);
          const rcv = (Number(c.replacement_cost) || 0) * (c.quantity || 1);
          const acv = (Number(c.acv) || 0) * (c.quantity || 1);
          solTotalRcv += rcv; solTotalAcv += acv;
          doc.fontSize(9).fillColor(DARK).text(
            `${c.description || 'Item'} (${[c.brand, c.model].filter(Boolean).join(' ') || 'n/a'}) · qty ${c.quantity ?? 1} · ${c.disposition || '-'} · RCV ${money(c.replacement_cost)} · ACV ${money(c.acv)}`
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
        doc.text('Location', startX, ty, { width: labelW });
        dates.forEach((d, i) => doc.text(fmtDateShort(d), startX + labelW + i * colW, ty, { width: colW, align: 'center' }));
        ty += 13;
        doc.font('Helvetica');
        trendPts.forEach((mp, idx) => {
          doc.fontSize(8).fillColor(DARK).text(mp.label || ('Point ' + (idx + 1)), startX, ty, { width: labelW });
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
      const materials = [...new Set(wallsAll.map((w) => w && w.material).filter(Boolean))];
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
  h1('Schedule of Loss Summary');
  kv('Total RCV', money(solTotalRcv));
  kv('Total ACV', money(solTotalAcv));

  // ---- Integrity note ----
  doc.moveDown(1).fontSize(7.5).fillColor(GRAY).text(
    `Generated ${new Date().toLocaleString()}. Timestamps and readings reflect captured field data.`,
    { width: W, align: 'center' }
  );

  doc.end();
  return bufP;
}


// --- Supabase-backed helpers (lazy require so generateReportPdf stays testable) ---
function db() { return require('./supabase').supabase; }

function dedupeLatest(rows) {
  const seen = new Set(); const out = [];
  for (const r of rows) { if (!seen.has(r.media_id)) { seen.add(r.media_id); out.push(r); } }
  return out;
}

async function fetchClaimGraph(claimId) {
  const supabase = db();
  const { data: claim } = await supabase.from('resto_claims').select('*').eq('id', claimId).single();
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
    moldScans: dedupeLatest(moldScans || [])
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