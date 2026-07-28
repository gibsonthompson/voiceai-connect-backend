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

// wet area square footage. A typed affected sqft (wa.sqft) ALWAYS wins: it is the
// number a tech confirmed on the material sheet, defensible on a carrier document.
// Only when it is absent do we fall back to the drawn geometry: the painted brush
// stroke (length x width + endcaps) or a filled polygon. The brush fallback is a
// rough visual estimate of a finger drag, never a billed figure on its own, which is
// why the material sheet asks the tech to confirm it. Ported to stay in lockstep with
// sketchModel.ts wetSqFt so app and backend agree.
function wetSqFt(w) {
  if (Number.isFinite(w.sqft) && w.sqft > 0) return w.sqft;
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

// aggregate one room's measured scope from its sketches.
//
// ceilingHeightFt lets us cap affected surface areas at the real surface size, so an
// affected number can only ever REDUCE from the full measured surface, never inflate
// past it. Floor caps at the drawn floor area; walls at gross wall SF; ceiling at the
// (flat) ceiling area, which equals floor. Passing it is optional: without it we still
// cap the floor (from the outline polygon) but leave walls/ceiling uncapped, since we
// cannot know the wall area without a ceiling height.
function roomScope(roomSketches, ceilingHeightFt) {
  const scenes = roomSketches.map((s) => s.canvas_json || {});
  const poly = largestRoomPolygon(roomSketches);

  const floorAreaFt = poly ? areaFt(poly.points) : 0;
  const perimFt = poly ? perimeterFt(poly.points) : 0;
  const SHcap = Number(ceilingHeightFt) > 0 ? Number(ceilingHeightFt) : null;
  // gross wall area for the cap only: perimeter x height, openings NOT deducted (an
  // affected wall area is a subset of the physical wall, and openings are billed over
  // anyway per the report's wall-area rule).
  const grossWallCap = SHcap != null ? perimFt * SHcap : null;
  const ceilingCap = floorAreaFt; // flat ceiling: C = F

  const wetMap = {};    // "surface|material" -> sqft
  const wetFloor = {};  // "material||disposition" -> sqft (drives extraction vs tear-out)
  let affectedFloorSqFt = 0;
  let affectedWallsSqFt = 0;
  let affectedCeilingSqFt = 0;
  for (const sc of scenes) {
    for (const wa of (sc.wetAreas || [])) {
      const surface = wa.surface || 'floor';
      const material = wa.material || '';
      const sqft = wetSqFt(wa); if (!sqft) continue;
      wetMap[surface + '|' + material] = (wetMap[surface + '|' + material] || 0) + sqft;
      if (surface === 'floor') {
        affectedFloorSqFt += sqft;
        // disposition: 'remove' -> flooring tear-out; anything else (incl. absent) -> dry in place (extraction)
        const disposition = wa.disposition === 'remove' ? 'remove' : 'dry';
        const key = material + '||' + disposition;
        wetFloor[key] = (wetFloor[key] || 0) + sqft;
      } else if (surface === 'wall') {
        affectedWallsSqFt += sqft;
      } else if (surface === 'ceiling') {
        affectedCeilingSqFt += sqft;
      }
    }
  }

  // An affected area is a PORTION of a surface, so it can never exceed that surface.
  // Cap each affected sum at its full surface: floor at the drawn floor area, ceiling
  // at the same (flat ceiling), walls at gross wall SF when a ceiling height is known.
  // This is what turns a fabricated brush ribbon (which used to read wildly over the
  // room) back into at most the real surface, even before a tech types a real number.
  if (poly && affectedFloorSqFt > floorAreaFt + 0.5) affectedFloorSqFt = floorAreaFt;
  if (grossWallCap != null && affectedWallsSqFt > grossWallCap + 0.5) affectedWallsSqFt = grossWallCap;
  if (affectedCeilingSqFt > ceilingCap + 0.5) affectedCeilingSqFt = ceilingCap;

  // If the floor total was capped, scale the per-material/disposition floor lines down
  // by the same factor, so the extraction and tear-out lines that feed Xactimate never
  // sum above the floor either.
  const floorLineTotal = Object.values(wetFloor).reduce((a, b) => a + b, 0);
  if (floorLineTotal > affectedFloorSqFt + 0.01 && floorLineTotal > 0) {
    const scale = affectedFloorSqFt / floorLineTotal;
    for (const k of Object.keys(wetFloor)) wetFloor[k] = wetFloor[k] * scale;
  }

  let floodCuts = [];
  let contSqft = 0, contCount = 0;
  for (const sc of scenes) {
    floodCuts = floodCuts.concat(floodCutQuantities(sc));
    const c = containmentQuantities(sc);
    contSqft += c.sqft; contCount += c.count;
  }

  return {
    floorAreaFt: r2(floorAreaFt),
    perimeterFt: r2(perimFt),
    wetBySurfaceMaterial: Object.keys(wetMap).map((k) => {
      const [surface, material] = k.split('|');
      return { surface, material, sqft: r2(wetMap[k]) };
    }),
    wetFloorByMaterial: Object.keys(wetFloor).map((k) => {
      const [material, disposition] = k.split('||');
      return { material, disposition, sqft: r2(wetFloor[k]) };
    }),
    affectedFloorSqFt: r2(affectedFloorSqFt),
    affectedWallsSqFt: r2(affectedWallsSqFt),
    affectedCeilingSqFt: r2(affectedCeilingSqFt),
    floodCuts: floodCuts.map((c) => ({ lf: r2(c.lf), heightFt: c.heightFt, sqft: r2(c.sqft) })),
    containment: { sqft: r2(contSqft), count: contCount }
  };
}


// ============================================================================
// ROOM DIMENSION VARIABLES (Xactimate's own model)
// ----------------------------------------------------------------------------
// Xactimate carries a fixed set of room variables, and its line items bill against
// them as FORMULAS, not numbers. The reference XACTDOC's drywall line reads
// calc="WC" qty="512": Xactimate recomputes the quantity from the sketch. So if we
// emit these correctly, build-back line items are nearly free.
//
// Confirmed three ways: Xactimate's published glossary, the Xactware certification
// syllabus (which lists "Deduct Openings" as a core Sketch skill), and by reverse-
// engineering the real reference file, whose 12x12 room reports
// C=144; F=144; SY=16; PC=48; PF=48; SH=7.667; W=368; WC=512.
//
//   F  = floor SF          C  = ceiling SF (FLAT ceiling: C = F)
//   SY = floor square YARDS = F / 9
//   PF = floor perimeter   PC = ceiling perimeter (= PF)
//   SH = ceiling height
//   W  = (PF x SH) - SUM(opening width x opening height)     <-- WALL SF
//   WC = W + C
//
// Baseboard runs the perimeter, interrupted by anything you can walk through: a
// door, a cased opening, a missing wall. A WINDOW does not interrupt it, because
// baseboard runs underneath a window.
//
// FLAT CEILINGS ONLY. C = F is false for a vaulted or sloped ceiling. Deliberate
// v1 scope, and it is stated here so nobody later assumes it was handled.
// ============================================================================

// Standard heights, used ONLY when a real measurement was not captured. Every one
// of these is an ASSUMPTION, and the result flags itself so a tech can see that a
// dollar figure rests on a default instead of a tape measure.
const OPENING_DEFAULT_HEIGHT_FT = {
  door: 6 + 8 / 12,       // 6 ft 8 in, the standard interior door
  window: 4,
  opening: 6 + 8 / 12,    // cased opening / archway
  missing_wall: null      // null = full ceiling height
};

// Openings that interrupt baseboard (you can walk through them).
const BREAKS_BASEBOARD = { door: true, opening: true, missing_wall: true, window: false };

function openingsOf(scene, ceilingHeightFt) {
  const out = [];
  const walls = scene.walls || [];
  const wmap = {}; walls.forEach((w) => { wmap[w.id] = w; });
  for (const op of (scene.openings || [])) {
    const w = wmap[op.wallId]; if (!w || !w.points) continue;
    const kind = op.kind || 'door';
    const edgeFt = edgeLenFt(w.points, op.edge || 0);
    // An opening can never be wider than the wall it sits in.
    let widthFt = op.widthFt != null ? op.widthFt : (kind === 'opening' ? 4 : 3);
    widthFt = Math.max(0, Math.min(widthFt, edgeFt || widthFt));

    let heightFt = op.heightFt;
    let assumed = false;
    if (kind === 'missing_wall') {
      // A missing wall IS the full ceiling height. That is its definition, not an
      // assumption, so it must never be flagged as one. (The frontend already got
      // this right; this keeps the two engines in agreement.)
      heightFt = ceilingHeightFt;
    } else if (heightFt == null) {
      heightFt = OPENING_DEFAULT_HEIGHT_FT[kind] || ceilingHeightFt;
      assumed = true;
    }
    // A 7 ft door in a 6 ft 8 in ceiling is nonsense; clamp rather than bill it.
    heightFt = Math.max(0, Math.min(heightFt, ceilingHeightFt));

    // raw values kept alongside the rounded ones: rounding BEFORE the arithmetic
    // compounds the error into the wall area, and wall area is a dollar figure.
    out.push({
      id: op.id, kind,
      widthFt: r2(widthFt), heightFt: r2(heightFt), sqft: r2(widthFt * heightFt),
      _wRaw: widthFt, _hRaw: heightFt, _sqftRaw: widthFt * heightFt,
      assumedHeight: assumed, breaksBaseboard: !!BREAKS_BASEBOARD[kind]
    });
  }
  return out;
}

// scene + ceiling height -> every Xactimate room variable, with its work shown.
// ceilingHeightFt is resolved by the caller: room override, else structure default.
// Pass assumedCeiling=true when neither was set, so the UI can say so out loud.
function roomDimensions(roomSketches, ceilingHeightFt, opts) {
  const options = opts || {};
  const poly = largestRoomPolygon(roomSketches);
  const warnings = [];

  const SH = Number(ceilingHeightFt) > 0 ? Number(ceilingHeightFt) : 8;
  if (!(Number(ceilingHeightFt) > 0)) {
    warnings.push('No ceiling height was measured. Wall area is calculated from an assumed 8 ft ceiling.');
  }

  if (!poly) {
    return {
      F: 0, C: 0, SY: 0, PF: 0, PC: 0, SH, W: 0, WC: 0,
      grossWallSF: 0, openingDeductSF: 0, baseboardLF: 0,
      openings: [], warnings: warnings.concat(['This room has no drawn outline, so no dimensions can be computed.']),
      assumedCeiling: !(Number(ceilingHeightFt) > 0) || !!options.assumedCeiling
    };
  }

  // FULL PRECISION for every intermediate; round only what we hand out. Rounding the
  // perimeter to 2 dp and THEN multiplying by the ceiling height compounds the error
  // straight into the wall area, and wall area is what a paint line bills against.
  const Fraw = areaFt(poly.points);
  const PFraw = perimeterFt(poly.points);

  const F = r2(Fraw);
  const PF = r2(PFraw);
  const C = F;                 // FLAT ceiling only
  const PC = PF;
  const SY = r2(Fraw / 9);

  // gather openings across every sketch of this room
  let openings = [];
  for (const s of roomSketches) openings = openings.concat(openingsOf(s.canvas_json || {}, SH));

  const grossRaw = PFraw * SH;
  const deductRaw = openings.reduce((a, o) => a + o._sqftRaw, 0);
  let Wraw = grossRaw - deductRaw;
  if (Wraw < 0) {
    warnings.push('The openings measured are larger than the wall area. Check the opening sizes.');
    Wraw = 0;
  }

  const grossWallSF = r2(grossRaw);
  const openingDeductSF = r2(deductRaw);
  const W = r2(Wraw);
  const WC = r2(Wraw + Fraw);

  const breakLF = openings.filter((o) => o.breaksBaseboard).reduce((a, o) => a + o._wRaw, 0);
  const baseboardLF = r2(Math.max(0, PFraw - breakLF));

  if (openings.some((o) => o.assumedHeight)) {
    warnings.push('Some openings have no measured height and are using a standard size. Measure them before billing wall area.');
  }

  return {
    F, C, SY, PF, PC, SH, W, WC,
    grossWallSF, openingDeductSF, baseboardLF,
    openings: openings.map((o) => ({
      id: o.id, kind: o.kind, widthFt: o.widthFt, heightFt: o.heightFt,
      sqft: o.sqft, assumedHeight: o.assumedHeight, breaksBaseboard: o.breaksBaseboard
    })),
    warnings,
    assumedCeiling: !(Number(ceilingHeightFt) > 0) || !!options.assumedCeiling
  };
}

// The Xactimate lastDims / DIM_VARS string: "C=144;F=144;SY=16;PC=48;PF=48;..."
function dimVarsString(d) {
  return `C=${d.C};F=${d.F};SY=${d.SY};PC=${d.PC};PF=${d.PF};SH=${d.SH};HH=${d.SH};W=${d.W};WC=${d.WC};`;
}

module.exports = {
  UPF, areaFt, perimeterFt, wetSqFt, edgeLenFt,
  floodCutQuantities, containmentSqFt, containmentQuantities,
  largestRoomPolygon, equipDays, equipmentUnitDays, roomScope,
  roomDimensions, dimVarsString, OPENING_DEFAULT_HEIGHT_FT, BREAKS_BASEBOARD
};