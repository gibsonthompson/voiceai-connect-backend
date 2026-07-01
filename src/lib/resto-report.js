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

// Render a moisture-map scene (canvas_json) as vectors at (ox,oy) within `size`.
function drawScene(doc, scene, ox, oy, size) {
  if (!scene) return;
  const sc = size / 1000;
  doc.save().rect(ox, oy, size, size).lineWidth(0.5).stroke('#e5e7eb').restore();
  (scene.wetAreas || []).forEach((p) => {
    if (!p.points || p.points.length < 2) return;
    doc.save();
    p.points.forEach((pt, i) => (i === 0 ? doc.moveTo(ox + pt[0] * sc, oy + pt[1] * sc) : doc.lineTo(ox + pt[0] * sc, oy + pt[1] * sc)));
    doc.closePath().fill('#bae6fd');
    doc.restore();
  });
  (scene.walls || []).forEach((p) => {
    if (!p.points || p.points.length < 2) return;
    doc.save();
    p.points.forEach((pt, i) => (i === 0 ? doc.moveTo(ox + pt[0] * sc, oy + pt[1] * sc) : doc.lineTo(ox + pt[0] * sc, oy + pt[1] * sc)));
    doc.closePath().lineWidth(2).stroke('#111827');
    doc.restore();
  });
  const EQ_FILL = { air_mover: '#29ABE6', dehumidifier: '#11B5C6', air_scrubber: '#64748B' };
  (scene.equipment || []).forEach((eq) => {
    const x = ox + eq.x * sc, y = oy + eq.y * sc, r = 22 * sc;
    doc.save().circle(x, y, r).fill(EQ_FILL[eq.type] || '#64748B').restore();
    doc.fillColor('#ffffff').fontSize(Math.max(6, r)).text(EQUIP_LABEL[eq.type] || '', x - r, y - r / 1.7, { width: r * 2, align: 'center' });
  });
  (scene.moisturePoints || []).forEach((mp) => {
    const x = ox + mp.x * sc, y = oy + mp.y * sc, r = 15 * sc;
    doc.save().circle(x, y, r).fill('#F26B3A').restore();
    doc.fillColor('#ffffff').fontSize(Math.max(5, r * 0.85)).text(String(mp.label || '').slice(0, 4), x - r, y - r / 1.9, { width: r * 2, align: 'center' });
  });
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

      // moisture maps
      for (const s of rSketches) {
        ensure(220);
        h2('Moisture Map');
        drawScene(doc, s.canvas_json, 50, doc.y, 200);
        doc.y += 210;
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

// Keep only the most recent scan per media (rows arrive newest-first).
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

module.exports = { generateReportPdf, drawScene, fetchClaimGraph, buildClaimReport };