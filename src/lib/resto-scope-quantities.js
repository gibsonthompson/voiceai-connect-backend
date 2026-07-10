// ============================================================================
// SHARED SCOPE-QUANTITY ENGINE
// ----------------------------------------------------------------------------
// One source of truth for the measured quantities that feed BOTH the carrier
// report (resto-report.js) and the Xactimate export (resto-esx.js), so the PDF
// and the ESX can never disagree on numbers. Mirrors the frontend sketchModel.ts
// math (UPF, wetSqFt, flood cuts, containment, equipment unit-days).
//
// Pure and dependency-free. Takes scene objects (canvas_json) and equipment rows.
// ============================================================================

const UPF = 40; // scene units per foot (law: matches sketchModel / resto-map-svg / resto-report)

// ---- polygon helpers (scene units) ----
function polygonAreaU(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
function polygonPerimeterU(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}
const areaFt = (pts) => polygonAreaU(pts) / (UPF * UPF);
const perimeterFt = (pts) => polygonPerimeterU(pts) / UPF;

// wet area square footage: painted brush stroke (length x width + endcaps) or
// filled polygon. Ported verbatim from sketchModel.ts wetSqFt so app and backend agree.
function wetSqFt(w) {
  if (w.brush) {
    const strokes = w.strokes && w.strokes.length ? w.strokes : (w.points && w.points.length ? [w.points] : []);
    let area = 0;
    for (const st of strokes) {
      let len = 0;
      for (let i = 1; i < st.length; i++) len += Math.hypot(st[i][0] - st[i - 1][0], st[i][1] - st[i - 1][1]);
      area += len * w.brush + Math.PI * (w.brush / 2) ** 2;
    }
    return area / (UPF * UPF);
  }
  if (w.points && w.points.length >= 3) return polygonAreaU(w.points) / (UPF * UPF);
  return 0;
}

// length of a wall edge in feet
function edgeLenFt(wallPts, edge) {
  if (!wallPts || !wallPts.length) return 0;
  const n = wallPts.length;
  const a = wallPts[edge], b = wallPts[(edge + 1) % n];
  if (!a || !b) return 0;
  return Math.hypot(b[0] - a[0], b[1] - a[1]) / UPF;
}

// flood cuts on a scene -> per-cut { lf, heightFt, sqft }
function floodCutQuantities(scene) {
  const walls = scene.walls || [];
  const wmap = {}; walls.forEach((w) => { wmap[w.id] = w; });
  const cuts = [];
  for (const fc of (scene.floodCuts || [])) {
    const w = wmap[fc.wallId]; if (!w || !w.points) continue;
    const full = edgeLenFt(w.points, fc.edge); if (!full) continue;
    const lf = fc.lengthFt != null ? Math.min(fc.lengthFt, full) : full;
    const heightFt = fc.heightFt || 2;
    cuts.push({ lf, heightFt, sqft: lf * heightFt });
  }
  return cuts;
}

function containmentSqFt(c) {
  if (c.widthFt != null) return (c.widthFt || 0) * (c.heightFt || 0);
  if (c.from && c.to) return (Math.hypot(c.to[0] - c.from[0], c.to[1] - c.from[1]) / UPF) * (c.heightFt || 8);
  return 0;
}
function containmentQuantities(scene) {
  const list = scene.containments || [];
  let sqft = 0; for (const c of list) sqft += containmentSqFt(c);
  return { sqft, count: list.length };
}

// largest wall polygon across a room's sketches = the room outline (Xactimate ROOM)
function largestRoomPolygon(sketches) {
  let best = null, bestArea = 0;
  for (const s of sketches) {
    for (const w of ((s.canvas_json || {}).walls || [])) {
      if (!w.points || w.points.length < 3) continue;
      const area = polygonAreaU(w.points);
      if (area > bestArea) { bestArea = area; best = w; }
    }
  }
  return best;
}

// equipment days for one unit (removed_at or now, minimum 1 day). Matches resto-report.
function equipDays(e) {
  if (!e.placed_at) return 0;
  const start = new Date(e.placed_at).getTime();
  const end = (e.removed_at ? new Date(e.removed_at) : new Date()).getTime();
  return Math.max(1, Math.round((end - start) / 86400000) + (e.removed_at ? 1 : 0));
}

// equipment unit-days by type (billable quantity for WTR DRY / DHM / air scrubber)
function equipmentUnitDays(equipment) {
  const out = {};
  for (const e of (equipment || [])) {
    const days = equipDays(e); if (!days) continue;
    const qty = e.actual_placed || 1;
    out[e.type] = (out[e.type] || 0) + days * qty;
  }
  return out; // { air_mover, dehumidifier, air_scrubber, heater }
}

const r2 = (n) => Math.round(n * 100) / 100;

// aggregate one room's measured scope from its sketches
function roomScope(roomSketches) {
  const scenes = roomSketches.map((s) => s.canvas_json || {});
  const poly = largestRoomPolygon(roomSketches);

  const wetMap = {};    // "surface|material" -> sqft
  const wetFloor = {};  // material -> sqft (drives extraction)
  let affectedFloorSqFt = 0;
  for (const sc of scenes) {
    for (const wa of (sc.wetAreas || [])) {
      const surface = wa.surface || 'floor';
      const material = wa.material || '';
      const sqft = wetSqFt(wa); if (!sqft) continue;
      wetMap[surface + '|' + material] = (wetMap[surface + '|' + material] || 0) + sqft;
      if (surface === 'floor') { affectedFloorSqFt += sqft; wetFloor[material] = (wetFloor[material] || 0) + sqft; }
    }
  }

  let floodCuts = [];
  let contSqft = 0, contCount = 0;
  for (const sc of scenes) {
    floodCuts = floodCuts.concat(floodCutQuantities(sc));
    const c = containmentQuantities(sc);
    contSqft += c.sqft; contCount += c.count;
  }

  return {
    floorAreaFt: poly ? r2(areaFt(poly.points)) : 0,
    perimeterFt: poly ? r2(perimeterFt(poly.points)) : 0,
    wetBySurfaceMaterial: Object.keys(wetMap).map((k) => {
      const [surface, material] = k.split('|');
      return { surface, material, sqft: r2(wetMap[k]) };
    }),
    wetFloorByMaterial: Object.keys(wetFloor).map((m) => ({ material: m, sqft: r2(wetFloor[m]) })),
    affectedFloorSqFt: r2(affectedFloorSqFt),
    floodCuts: floodCuts.map((c) => ({ lf: r2(c.lf), heightFt: c.heightFt, sqft: r2(c.sqft) })),
    containment: { sqft: r2(contSqft), count: contCount }
  };
}

module.exports = {
  UPF, areaFt, perimeterFt, wetSqFt, edgeLenFt,
  floodCutQuantities, containmentSqFt, containmentQuantities,
  largestRoomPolygon, equipDays, equipmentUnitDays, roomScope
};