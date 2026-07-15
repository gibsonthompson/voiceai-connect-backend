// ============================================================================
// RESTORATION CLAIM REPORT  (verbatim)
// ============================================================================
const SVGtoPDF = require('svg-to-pdfkit');
const { buildMapSvg } = require('./resto-map-svg');
const {
  T, M, newDoc, docToBuffer, brandingOf, kit, coverPage, brandFooterBlock,
  dateOnly, db, downloadImage
} = require('./resto-pdf-common');

let roomDimensions = null;
try { roomDimensions = require('./resto-scope-quantities').roomDimensions; } catch (_e) { roomDimensions = null; }

const UPF = 40;

const READING_LABEL = { psychrometric: 'Affected', exterior: 'Exterior', dehu_outlet: 'Dehu outlet', material_mc: 'Material MC' };
const EQUIP_FULL = { air_mover: 'Air mover', dehumidifier: 'Dehumidifier', air_scrubber: 'Air scrubber', heater: 'Heater' };
const MOLD_LABEL = { mold_likely: 'Mold likely', mold_possible: 'Mold possible', mold_unlikely: 'Mold unlikely', inconclusive: 'Inconclusive' };
const TOL_LABEL = { water: 'Water', fire: 'Fire', mold: 'Mold', other: 'Other' };

const readingsOf = (mp) => (Array.isArray(mp && mp.readings) ? mp.readings : []);
const valOn = (mp, date) => { const r = readingsOf(mp).find((x) => x.date === date); return r ? String(r.value) : ''; };
const fmtDateShort = (d) => { try { return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }); } catch (_e) { return String(d); } };

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p1 = pts[i], p2 = pts[(i + 1) % pts.length]; a += p1[0] * p2[1] - p2[0] * p1[1]; }
  return Math.abs(a) / 2;
}
function suggestEq(sqft, cls) {
  if (!sqft || sqft <= 0) return { airMovers: 0, dehus: 0 };
  const c = cls >= 1 && cls <= 4 ? cls : 2;
  const perAm = { 1: 70, 2: 60, 3: 50, 4: 50 }[c], perDh = { 1: 500, 2: 400, 3: 300, 4: 300 }[c];
  return { airMovers: Math.max(1, Math.ceil(sqft / perAm) + 1), dehus: Math.max(1, Math.ceil(sqft / perDh)) };
}
function equipDays(e) {
  if (!e.placed_at) return 0;
  const start = new Date(e.placed_at).getTime();
  const end = (e.removed_at ? new Date(e.removed_at) : new Date()).getTime();
  return Math.max(1, Math.round((end - start) / 86400000) + (e.removed_at ? 1 : 0));
}

// The flooring material for a room, read from the floor wet-area a tech marked.
// Lets the report say "Floor (carpet)" when the floor IS carpet, without hard-coding
// carpet for a tile or hardwood room, which on a carrier-facing document would be a
// misstatement. Returns null when no floor material was recorded.
function floorMaterialOf(rSketches) {
  for (const s of (rSketches || [])) {
    for (const wa of ((s.canvas_json || {}).wetAreas || [])) {
      if ((wa.surface || 'floor') === 'floor' && wa.material) return String(wa.material);
    }
  }
  return null;
}

async function generateReportPdf(graph, getImage) {
  const { claim, structures, rooms, media, notes, contents, sketches, chambers, readings, dryStandards, signatures, equipment, moldScans } = graph;

  const brand = brandingOf(graph.settings);
  const cfg = brand.cfg || {};
  const stampGps = ((graph.settings || {}).stamp_gps !== false);

  const doc = newDoc();
  const bufP = docToBuffer(doc);

  let esxByRoom = {}, esxClaimLevel = [];
  try {
    const { mapClaimToProject } = require('./resto-esx');
    const model = mapClaimToProject(graph);
    for (const it of (model.lineItems || [])) {
      if (it.room) (esxByRoom[it.room] = esxByRoom[it.room] || []).push(it);
      else esxClaimLevel.push(it);
    }
  } catch (_e) { esxByRoom = {}; esxClaimLevel = []; }

  const cat = claim.category_of_water, cls = claim.class_of_water;
  const k = coverPage(doc, brand, {
    title: 'Property Restoration Report',
    heading: claim.policyholder_name || 'Claim',
    sub: claim.address || '',
    factPairs: [
      ['Type of loss', TOL_LABEL[claim.type_of_loss] || claim.type_of_loss],
      ['Cause of loss', [claim.cause_of_loss, claim.cause_other].filter(Boolean).join('  \u00b7  ')],
      ['Date of loss', dateOnly(claim.date_of_loss)],
      ['Date discovered', dateOnly(claim.date_discovered)],
      ['Water category', cat ? 'Category ' + cat : '-'],
      ['Drying class', cls ? 'Class ' + cls : '-'],
      ['Insurance company', claim.insurance_company],
      ['Claim / job number', claim.carrier_identifier],
      ['Policy number', claim.policy_number],
      ['Adjuster / claim rep', claim.adjuster],
      ['Estimator', claim.estimator],
      ['Project manager', claim.project_manager]
    ]
  });
  const { W } = k;

  const gap = (() => {
    if (!claim.date_of_loss || !claim.date_discovered) return null;
    const a = new Date(claim.date_of_loss + 'T00:00:00').getTime();
    const b = new Date(claim.date_discovered + 'T00:00:00').getTime();
    return isNaN(a) || isNaN(b) ? null : Math.round((b - a) / 86400000);
  })();
  if (claim.loss_onset === 'sudden') {
    k.callout('Onset: SUDDEN. The failure happened at once, from a specific event. The narrative and the cause photographs are below.', 'ok');
  } else if (claim.loss_onset === 'gradual' || (gap != null && gap > 14)) {
    k.callout('Onset: ' + String(claim.loss_onset || 'not recorded').toUpperCase() +
      (gap != null ? '. ' + gap + ' days between the date of loss and its discovery.' : '.') +
      ' Supporting documentation of the cause is included in this report.', 'warn');
  }
  if (claim.cause_notes) { k.h3('Cause and origin'); k.para(claim.cause_notes); }

  doc.addPage();
  doc.addPage();

  const renderScope = (list) => {
    k.table(
      [{ t: 'Code', w: 0.16 }, { t: 'Description', w: 0.58 }, { t: 'Qty', w: 0.14, align: 'right' }, { t: 'Unit', w: 0.12 }],
      (list || []).map((it) => [`${it.cat} ${it.sel}`, it.desc || '', it.quantity, it.unit || ''])
    );
    const notesOn = (list || []).filter((it) => it.note);
    if (notesOn.length) {
      k.h3('Justification');
      k.bullets(notesOn.map((it) => `${it.cat} ${it.sel}: ${it.note}`), { size: T.size.small, color: T.muted });
      k.gap(1);
    }
    const unverified = (list || []).filter((it) => it.confidence === 'verify');
    if (unverified.length) {
      k.callout('Selector pending verification against a reference Xactimate file: ' +
        unverified.map((it) => `${it.cat} ${it.sel}`).join(', '), 'warn');
    }
  };

  const sketchHasContent = (s) => {
    const cj = s.canvas_json || {};
    return (cj.wetAreas && cj.wetAreas.length) || (cj.moisturePoints && cj.moisturePoints.length) ||
           (cj.equipment && cj.equipment.length) || (cj.walls && cj.walls.length) ||
           (cj.openings && cj.openings.length) || (cj.floodCuts && cj.floodCuts.length);
  };
  const roomHasContent = (room) => {
    const rMedia = media.filter((m) => m.room_id === room.id);
    return notes.some((n) => n.room_id === room.id) ||
           rMedia.some((m) => m.type === 'photo') ||
           contents.some((c) => c.room_id === room.id) ||
           (moldScans || []).some((sc) => rMedia.some((m) => m.id === sc.media_id)) ||
           sketches.filter((s) => s.room_id === room.id).some(sketchHasContent);
  };

  const ceilingFor = (room, structure) => {
    const own = Number(room && room.height_ft);
    if (own > 0) return own;
    const def = Number(structure && structure.default_ceiling_height_ft);
    return def > 0 ? def : null;
  };

  const eqTotals = {};
  const allContents = [];

  for (const st of structures) {
    const stRooms = rooms.filter((r) => r.structure_id === st.id);
    const shown = stRooms.filter(roomHasContent);
    const stChambers = chambers.filter((c) => c.structure_id === st.id);
    if (!shown.length && !stChambers.length) continue;

    k.section(st.name || 'Structure');

    for (const room of shown) {
      const rNotes = notes.filter((n) => n.room_id === room.id);
      const rMedia = media.filter((m) => m.room_id === room.id);
      const photos = rMedia.filter((m) => m.type === 'photo');
      const rContents = contents.filter((c) => c.room_id === room.id);
      const rSketches = sketches.filter((s) => s.room_id === room.id);
      const rScans = (moldScans || []).filter((sc) => rMedia.some((m) => m.id === sc.media_id));

      const ceil = ceilingFor(room, st);
      k.h2(room.name || 'Room', ceil ? ceil + ' ft ceiling' : 'Ceiling height not measured');

      if (roomDimensions && rSketches.length) {
        let d = null;
        try { d = roomDimensions(rSketches, ceil); } catch (e) { console.error('roomDimensions failed:', e.message); d = null; }
        if (d && d.F > 0) {
          // Floor square footage IS the carpet / flooring area for the whole room:
          // it is what a re-carpet or replace-flooring line bills against. Wall square
          // footage is the paintable / drywall area after openings. Both are stated in
          // square feet, and named, because each drives its own line items.
          //
          // Per-surface scope: a surface a tech marked out of scope (an unaffected tile
          // floor under wet walls) is still shown, marked "not in scope", so nothing looks
          // hidden, but it is left out of the plain floor/wall summary line.
          const incFloor = room.include_floor !== false;
          const incWalls = room.include_walls !== false;
          const incCeiling = room.include_ceiling !== false;
          const incBase = room.include_baseboard !== false;
          const nis = ' (not in scope)';

          // WALL AREA is the ENTIRE wall: perimeter x ceiling height, doors and windows
          // NOT deducted. This is the full square footage to paint or clean, as if the
          // openings were painted straight over. The openings are still measured and listed
          // for reference, but they are included in this total, never subtracted.
          const hasOpenings = !!(d.openings && d.openings.length);
          const wallSF = d.grossWallSF;

          const floorMat = floorMaterialOf(rSketches);
          const floorLabel = floorMat ? `Floor (${floorMat.toLowerCase()})` : 'Floor';
          k.h3('Measurements');
          k.facts([
            [floorLabel, d.F + ' sq ft' + (incFloor ? '' : nis)],
            ['Ceiling', d.C + ' sq ft' + (incCeiling ? '' : nis)],
            ['Perimeter', d.PF + ' ft'],
            ['Ceiling height', d.SH + ' ft'],
            ['Baseboard', d.baseboardLF + ' ft' + (incBase ? '' : nis)],
            ['Wall area', wallSF + ' sq ft' + (incWalls ? '' : nis)]
          ], 3);
          const sumParts = [];
          if (incFloor) sumParts.push(`Floor${floorMat ? ' (' + floorMat.toLowerCase() + ')' : ''}: ${d.F} sq ft`);
          if (incWalls) sumParts.push(`Walls: ${wallSF} sq ft`);
          if (sumParts.length) {
            k.para(sumParts.join('.   ') + '.', { weight: 'b', size: T.size.small, color: T.ink });
          }
          const outOf = [];
          if (!incFloor) outOf.push('floor');
          if (!incWalls) outOf.push('walls');
          if (!incCeiling) outOf.push('ceiling');
          if (!incBase) outOf.push('baseboard');
          if (outOf.length) {
            k.callout('Not part of the loss in this room: ' + outOf.join(', ') +
              '. Measured and shown for reference, not billed.', 'warn');
          }
          k.para(
            `Wall area = perimeter ${d.PF} ft x height ${d.SH} ft = ${d.grossWallSF} sq ft, the entire wall with doors and windows included (not deducted).`,
            { size: T.size.small, color: T.muted }
          );
          if (hasOpenings) {
            k.table(
              [{ t: 'Opening', w: 0.34 }, { t: 'Width', w: 0.22, align: 'right' }, { t: 'Height', w: 0.22, align: 'right' }, { t: 'Area', w: 0.22, align: 'right' }],
              d.openings.map((o) => [
                (o.kind || '').replace('_', ' ') + (o.assumedHeight ? ' (height assumed)' : ''),
                o.widthFt + ' ft', o.heightFt + ' ft', o.sqft + ' sq ft'
              ])
            );
            k.para('Openings are measured and shown for reference. They are part of the wall area above, not deducted from it.',
              { size: T.size.small, color: T.muted });
          }
          (d.warnings || []).forEach((w) => k.callout(w, 'warn'));
        }
      }

      if (rNotes.length) {
        k.h3('Field notes');
        k.bullets(rNotes.map((n) => n.body).filter(Boolean));
        k.gap(1);
      }

      if (photos.length && getImage) {
        k.h3('Photographs', 150);
        await k.photoGrid(photos, getImage, {
          perRow: 3,
          stamp: (p) => {
            const bits = [];
            if (p.captured_at) { try { bits.push(new Date(p.captured_at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' })); } catch (_e) {} }
            if (stampGps && p.lat != null && p.lng != null) bits.push(Number(p.lat).toFixed(4) + ', ' + Number(p.lng).toFixed(4));
            return bits.join('   ');
          },
          onCell: async (p, x, y, cell) => {
            try {
              const { data: su } = await db().storage.from('resto-media').createSignedUrl(p.storage_path, 60 * 60 * 24 * 365);
              if (su && su.signedUrl) doc.link(x, y, cell, cell, su.signedUrl);
            } catch (_e) {}
          }
        });
        k.gap(1);
      }

      if (rScans.length) {
        k.h3('Mold screening');
        k.para('AI visual screening only, not a lab diagnosis. Confirm suspected growth with lab or air sampling.', { size: T.size.small, color: T.muted });
        k.table(
          [{ t: 'Result', w: 0.24 }, { t: 'Confidence', w: 0.16, align: 'right' }, { t: 'Notes', w: 0.60 }],
          rScans.map((sc) => [
            MOLD_LABEL[sc.verdict] || sc.verdict,
            (sc.confidence ?? 0) + '%',
            (sc.summary || '') + (sc.recommend_lab_sampling ? ' Lab sampling recommended.' : '')
          ])
        );
      }

      for (const s of rSketches.filter(sketchHasContent)) {
        const svg = buildMapSvg(s.canvas_json || {}, { width: 760, draw: 520 });
        const mm = svg.match(/width="(\d+)" height="(\d+)"/);
        const aspect = mm ? Number(mm[2]) / Number(mm[1]) : 0.6;
        const renderH = W * aspect;
        k.h3('Moisture map', renderH + 46);
        const y = k.ensure(renderH + 40);
        SVGtoPDF(doc, svg, M, y, { width: W });
        doc.x = M; doc.y = y + renderH + 6;

        const legend = [
          ['#7DD3FC', 'Wet area'], ['#29ABE6', 'Air mover'], ['#11B5C6', 'Dehumidifier'],
          ['#64748B', 'Air scrubber'], ['#1483C2', 'Moisture reading'], ['#F59E0B', 'Flood cut'],
          ['#8B5CF6', 'Containment'], ['#DC2626', 'Origin of loss']
        ];
        let lx = M, ly = doc.y;
        k.font('', T.size.tiny, T.muted);
        legend.forEach(([c, lbl]) => {
          const wItem = doc.widthOfString(lbl) + 16;
          if (lx + wItem > M + W) { lx = M; ly += 12; }
          doc.circle(lx + 3, ly + 3.5, 3).fill(c);
          doc.fillColor(T.muted).text(lbl, lx + 9, ly, { lineBreak: false });
          lx += wItem + 8;
        });
        doc.x = M; doc.y = ly + 16;
        k.gap(1);
      }

      const roomPoints = [];
      for (const s of rSketches) for (const mp of ((s.canvas_json && s.canvas_json.moisturePoints) || [])) roomPoints.push(mp);
      const dateSet = new Set();
      for (const mp of roomPoints) for (const r of readingsOf(mp)) if (r.date) dateSet.add(r.date);
      const dates = [...dateSet].sort();
      const trendPts = roomPoints.filter((mp) => readingsOf(mp).some((r) => r.date));
      if (dates.length && trendPts.length) {
        k.h3('Moisture readings (drying trend)');
        const dw = Math.min(0.5, 0.5 / Math.max(1, dates.length));
        const labelW = 1 - dw * dates.length;
        const cols = [{ t: 'Location / material', w: labelW }].concat(
          dates.map((d) => ({ t: fmtDateShort(d), w: dw, align: 'right' })));
        k.table(cols, trendPts.map((mp, i) => {
          const loc = mp.label || '';
          const mat = mp.material || '';
          const dup = mat && loc && loc.toLowerCase().indexOf(mat.toLowerCase()) >= 0;
          const head = mat && loc && !dup ? `${mat}, ${loc}` : (loc || mat || 'Point ' + (i + 1));
          return [head].concat(dates.map((d) => valOn(mp, d) || '-'));
        }));
      }

      const wallsAll = [];
      let placedAm = 0, placedDh = 0, clsRoom = 0;
      for (const s of rSketches) {
        const cj = s.canvas_json || {};
        if (cj.classOfLoss) clsRoom = cj.classOfLoss;
        for (const w of (cj.walls || [])) wallsAll.push(w);
        for (const e of (cj.equipment || [])) { if (e.type === 'air_mover') placedAm++; else if (e.type === 'dehumidifier') placedDh++; }
      }
      const wetMats = [];
      for (const s of rSketches) for (const wa of ((s.canvas_json || {}).wetAreas || [])) if (wa.material) {
        wetMats.push(wa.surface && wa.surface !== 'floor' ? `${wa.surface} ${wa.material}` : wa.material);
      }
      const materials = [...new Set([...wallsAll.map((w) => w && w.material).filter(Boolean), ...wetMats])];
      if (materials.length) { k.h3('Affected materials'); k.para(materials.join(', ')); k.gap(1); }

      let sqft = 0;
      for (const w of wallsAll) if (w.points && w.points.length >= 3) sqft += polyArea(w.points);
      sqft = sqft / (UPF * UPF);
      if (sqft > 0) {
        const sug = suggestEq(sqft, clsRoom);
        k.h3('Equipment check (S500 guide)');
        k.facts([
          ['Class of loss', 'Class ' + (clsRoom || 2)],
          ['Floor area', Math.round(sqft) + ' sq ft'],
          ['Air movers', placedAm + ' placed / ' + sug.airMovers + ' suggested'],
          ['Dehumidifiers', placedDh + ' placed / ' + sug.dehus + ' suggested']
        ], 4);
      }

      let fcLf = 0, fcSqft = 0, contSqft = 0, contCount = 0; const fcByH = {};
      for (const s of rSketches) {
        const cj = s.canvas_json || {}; const wmap = {};
        (cj.walls || []).forEach((w) => { wmap[w.id] = w; });
        for (const fc of (cj.floodCuts || [])) {
          const w = wmap[fc.wallId]; if (!w || !w.points) continue;
          const n = w.points.length, A = w.points[fc.edge], B = w.points[(fc.edge + 1) % n];
          if (!A || !B) continue;
          const full = Math.hypot(B[0] - A[0], B[1] - A[1]) / UPF;
          const lf = fc.lengthFt != null ? Math.min(fc.lengthFt, full) : full;
          const hLabel = fc.heightFt < 1 ? '4 in' : fc.heightFt + ' ft';
          fcLf += lf; fcSqft += lf * fc.heightFt; fcByH[hLabel] = (fcByH[hLabel] || 0) + lf;
        }
        for (const ct of (cj.containments || [])) {
          if (ct.widthFt != null) { contSqft += ct.widthFt * ct.heightFt; contCount++; }
          else if (ct.from && ct.to) { contSqft += (Math.hypot(ct.to[0] - ct.from[0], ct.to[1] - ct.from[1]) / UPF) * (ct.heightFt || 8); contCount++; }
        }
      }
      if (fcLf > 0 || contCount > 0) {
        k.h3('Demolition and containment');
        const rowsD = [];
        if (fcLf > 0) {
          Object.keys(fcByH).forEach((h) => rowsD.push(['Flood cut (DRYW)', 'at ' + h, Math.round(fcByH[h]) + ' lf', '']));
          rowsD.push(['Flood cut total', '', Math.round(fcLf) + ' lf', Math.round(fcSqft) + ' sq ft removed']);
        }
        if (contCount > 0) rowsD.push(['Containment (PLASTIC)', contCount + ' barrier' + (contCount === 1 ? '' : 's'), '', Math.round(contSqft) + ' sq ft']);
        k.table([{ t: 'Item', w: 0.32 }, { t: 'Detail', w: 0.24 }, { t: 'Length', w: 0.18, align: 'right' }, { t: 'Area', w: 0.26, align: 'right' }], rowsD);
      }

      const roomLines = esxByRoom[room.name] || [];
      if (roomLines.length) { k.h3('Estimate scope (Xactimate line items)'); renderScope(roomLines); }

      rContents.forEach((c) => { allContents.push({ room: room.name, item: c }); });

      k.gap(2);
    }

    if (stChambers.length) {
      k.h2('Structural drying (IICRC S500)');
      for (const ch of stChambers) {
        k.h3(ch.name || 'Chamber');
        const cStd = dryStandards.filter((d) => d.chamber_id === ch.id);
        k.facts([
          ['Dimensions', ch.length_ft && ch.width_ft ? `${ch.length_ft} x ${ch.width_ft} x ${ch.height_ft ?? 8} ft` : '-'],
          ['Class of loss', ch.class_of_loss ? 'Class ' + ch.class_of_loss : '-'],
          ['Dry standards', cStd.length ? cStd.map((d) => `${d.material} ${d.goal_value ?? '-'}`).join(', ') : 'Not set']
        ], 3);

        const cReadings = readings.filter((r) => r.chamber_id === ch.id)
          .sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
        const affected = cReadings.filter((r) => r.reading_type === 'psychrometric');
        const dehu = cReadings.filter((r) => r.reading_type === 'dehu_outlet');
        const mc = cReadings.filter((r) => r.reading_type === 'material_mc' && r.material_mc != null);
        const last = (a) => (a.length ? a[a.length - 1] : null);
        const la = last(affected), ld = last(dehu);
        const prevA = affected.length >= 2 ? affected[affected.length - 2] : null;

        if (la || mc.length) {
          const trend = la && prevA && la.gpp != null && prevA.gpp != null ? la.gpp - prevA.gpp : null;
          k.facts([
            ['Affected air', la && la.gpp != null ? la.gpp + ' GPP' : '-'],
            ['Trend', trend != null ? (trend >= 0 ? '+' : '') + trend.toFixed(0) + ' GPP' : '-'],
            ['Grain depression', la && ld && la.gpp != null && ld.gpp != null ? (la.gpp - ld.gpp).toFixed(0) + ' GPP' : '-'],
            ['Affected RH', la && la.rh_pct != null ? la.rh_pct + '%' : '-']
          ], 4);
          if (trend != null && trend >= -1 && affected.length >= 2) {
            k.callout('Drying is stalled: GPP is not dropping. Check air infiltration, dehumidification capacity, or hidden moisture.', 'bad');
          }

          const goalFor = (m) => { const x = cStd.find((z) => (z.material || '').toLowerCase() === (m || '').toLowerCase()); return x ? x.goal_value : null; };
          const locMap = {};
          mc.forEach((r) => { const key = (r.location_label || 'Point') + '|' + (r.material || ''); (locMap[key] = locMap[key] || []).push(r); });
          const locs = Object.keys(locMap).map((key) => {
            const rs = locMap[key], l = rs[rs.length - 1], goal = goalFor(l.material);
            return { label: l.location_label || 'Point', material: l.material || '-', val: l.material_mc, goal, atGoal: goal != null && l.material_mc != null ? l.material_mc <= goal : null };
          });
          if (locs.length) {
            k.h3('Material moisture vs dry goal');
            k.table(
              [{ t: 'Location', w: 0.34 }, { t: 'Material', w: 0.24 }, { t: 'Reading', w: 0.14, align: 'right' }, { t: 'Goal', w: 0.12, align: 'right' }, { t: 'Status', w: 0.16, align: 'right' }],
              locs.map((l) => [l.label, l.material, String(l.val), l.goal != null ? String(l.goal) : '-',
                l.atGoal === true ? 'At goal' : l.atGoal === false ? 'Above goal' : '-'])
            );
            const withGoal = locs.filter((l) => l.atGoal !== null);
            const atGoal = withGoal.filter((l) => l.atGoal).length;
            if (withGoal.length) {
              k.callout(atGoal === withGoal.length
                ? 'All monitored points are at the dry goal.'
                : atGoal + ' of ' + withGoal.length + ' monitored points are at the dry goal.',
                atGoal === withGoal.length ? 'ok' : 'warn');
            }
          }
        }

        const atmos = cReadings.filter((r) => r.reading_type !== 'material_mc');
        if (atmos.length) {
          k.h3('Drying log (atmospheric)');
          k.table(
            [{ t: 'Date', w: 0.16 }, { t: 'Reading', w: 0.18 }, { t: 'Location', w: 0.22 }, { t: 'Temp / RH', w: 0.16, align: 'right' }, { t: 'GPP', w: 0.14, align: 'right' }, { t: 'Dew', w: 0.14, align: 'right' }],
            atmos.map((r) => [
              dateOnly(r.captured_at),
              READING_LABEL[r.reading_type] || r.reading_type,
              r.location_label || '-',
              (r.temp_f != null ? r.temp_f + 'F' : '-') + ' / ' + (r.rh_pct != null ? r.rh_pct + '%' : '-'),
              r.gpp != null ? String(r.gpp) : '-',
              r.dew_point != null ? r.dew_point + 'F' : '-'
            ])
          );
        }

        const cEquip = (equipment || []).filter((e) => e.chamber_id === ch.id);
        if (cEquip.length) {
          k.h3('Equipment usage');
          let unitDays = 0;
          const rowsE = cEquip.map((e) => {
            const days = equipDays(e), qty = e.actual_placed || 1;
            eqTotals[e.type] = (eqTotals[e.type] || 0) + qty * days;
            unitDays += qty * days;
            return [EQUIP_FULL[e.type] || e.type, String(qty), e.placed_at ? dateOnly(e.placed_at) : '-',
                    e.removed_at ? dateOnly(e.removed_at) : 'On site', String(days), String(qty * days)];
          });
          k.table(
            [{ t: 'Equipment', w: 0.28 }, { t: 'Qty', w: 0.08, align: 'right' }, { t: 'Placed', w: 0.18 }, { t: 'Removed', w: 0.18 }, { t: 'Days', w: 0.12, align: 'right' }, { t: 'Unit-days', w: 0.16, align: 'right' }],
            rowsE,
            { total: ['Total', '', '', '', '', String(unitDays)] }
          );
        }
        k.gap(1);
      }
    }
  }

  const DISPOSITION = {
    non_restorable: 'Non-salvageable', disposed: 'Disposed', restorable: 'Restorable',
    packed_out: 'Packed out', moved: 'Moved', cleaned: 'Cleaned', in_place: 'Left in place'
  };
  if (allContents.length) {
    doc.addPage();
    k.section('Contents Inventory');
    k.para('What was in each room, and what the crew did with it. Valuation is established in Xactimate and XactContents from the carrier price list, and is deliberately not stated here.',
      { size: T.size.small, color: T.muted });
    k.gap(1);
    k.table(
      [{ t: 'Room', w: 0.16 }, { t: 'Item', w: 0.26 }, { t: 'Make / model', w: 0.22 },
       { t: 'Qty', w: 0.07, align: 'right' }, { t: 'Age', w: 0.09, align: 'right' },
       { t: 'Disposition', w: 0.20 }],
      allContents.map(({ room, item }) => [
        room || '-', item.description || 'Item',
        [item.brand, item.model].filter(Boolean).join(' ') || '-',
        String(item.quantity ?? 1),
        item.age_years != null ? item.age_years + 'y' : (item.year_purchased ? String(item.year_purchased) : '-'),
        DISPOSITION[item.disposition] || '-'
      ])
    );
    const lossCount = allContents.filter(({ item }) => item.disposition === 'non_restorable' || item.disposition === 'disposed').length;
    if (lossCount) {
      k.callout(lossCount + ' item' + (lossCount === 1 ? '' : 's') +
        ' documented as non-salvageable. Photographs of each are in the room sections above, taken before disposal.', 'warn');
    }
  }

  if (Object.keys(eqTotals).length) {
    k.section('Equipment Usage Summary');
    k.para('Total equipment-days across every drying chamber on this claim. Equipment days are the most-scrubbed line on a mitigation invoice, so the daily placement record is in the drying log above.',
      { size: T.size.small, color: T.muted });
    k.gap(1);
    k.table(
      [{ t: 'Equipment', w: 0.6 }, { t: 'Unit-days', w: 0.4, align: 'right' }],
      Object.keys(eqTotals).map((t) => [EQUIP_FULL[t] || t, String(eqTotals[t])])
    );
    const equipScope = esxClaimLevel.filter((it) => it.cat === 'WTR');
    if (equipScope.length) { k.h3('Billable equipment line items'); renderScope(equipScope); }
  }

  if (signatures && signatures.length) {
    doc.addPage();
    k.section('Authorizations and Signatures');
    const titleFor = (t) => t === 'work_authorization' ? 'Work Authorization and Direction to Pay'
      : t === 'completion_certificate' ? 'Certificate of Completion and Satisfaction' : t;
    for (const sig of signatures) {
      k.h2(titleFor(sig.doc_type));
      const snap = sig.doc_snapshot || {};
      if (snap.intro) k.para(snap.intro, { size: T.size.small });
      if (snap.items && snap.items.length) k.bullets(snap.items, { size: T.size.small, color: T.muted });
      k.gap(1);
      if (sig.signature_data && sig.signature_data.indexOf('base64,') >= 0) {
        try {
          const buf = Buffer.from(sig.signature_data.split('base64,')[1], 'base64');
          const y = k.ensure(50);
          doc.image(buf, M, y, { fit: [160, 42] });
          doc.x = M; doc.y = y + 46;
        } catch (_e) { }
      }
      k.font('b', T.size.small, T.ink).text(
        `Signed by ${sig.signer_name || '-'} on ${new Date(sig.signed_at).toLocaleDateString()}`,
        M, doc.y, { width: W });
      doc.x = M; doc.y += 16;
    }
  }

  brandFooterBlock(k, cfg);
  k.gap(1);
  k.para('Generated ' + new Date().toLocaleString() + '. Timestamps and readings reflect data captured in the field.',
    { size: T.size.tiny, color: T.faint });

  k.contentsPage(1);
  k.furniture({
    company: cfg.company_name || 'Property Restoration Report',
    address: claim.address || '',
    coverPages: 1,
    footNote: [claim.policyholder_name, claim.carrier_identifier].filter(Boolean).join('   \u00b7   ')
  });

  doc.end();
  return bufP;
}

function dedupeLatest(rows) {
  const seen = new Set(); const out = [];
  for (const r of rows) if (!seen.has(r.media_id)) { seen.add(r.media_id); out.push(r); }
  return out;
}

async function fetchClaimGraph(claimId) {
  const supabase = db();
  const { data: claim } = await supabase.from('resto_claims').select('*').eq('id', claimId).single();
  let settings = null;
  if (claim) {
    const { data: sRows } = await supabase.from('resto_org_settings').select('*').eq('org_id', claim.org_id).limit(1);
    settings = (sRows && sRows[0]) || null;
  }
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
    signatures: signatures || [], equipment: equipment || [],
    moldScans: dedupeLatest(moldScans || []), settings
  };
}

async function buildClaimReport(claimId) {
  const graph = await fetchClaimGraph(claimId);
  if (!graph.claim) throw new Error('claim not found');
  const pdf = await generateReportPdf(graph, downloadImage);
  return { pdf, claim: graph.claim };
}

module.exports = { generateReportPdf, buildMapSvg, fetchClaimGraph, buildClaimReport };