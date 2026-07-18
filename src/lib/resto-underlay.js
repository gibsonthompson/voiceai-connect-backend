// ============================================================================
// XACTIMATE SKETCH UNDERLAY (PNG)
// ----------------------------------------------------------------------------
// Renders a structure level to a clean, to-scale PNG the estimator imports into
// Xactimate as a Sketch underlay (Estimate > Sketch > Options > Import > Import
// Underlay Image; accepted types jpg/png/bmp/gif), then traces over. This turns
// "draw the house from a blank grid" into "trace a correct, scaled plan."
//
// Placement reuses resto-floorplan.js, the SAME math the ESX export uses, so the
// underlay matches what a native import would draw. Geometry is read live from
// each room's LATEST sketch; nothing is duplicated. No prices, no scope, just the plan.
//
// GEOMETRY FIX: the outline and the rotation pivot must come from the SAME sketch.
// This used to take the largest wall polygon across ALL of a room's historical
// sketches, then rotate it about a pivot computed from only the latest sketch.
// Because the app writes a new resto_sketches row on every edit, rooms accumulate
// several sketches in different coordinate frames, so that pairing placed points
// from one frame around a center from another and threw rooms far off. Both now
// come from the latest sketch, which is what the floor plan editor and the ESX use.
//
// Scale: rendered at a fixed pixels-per-foot with a labelled 10 ft scale bar and
// the overall level size, so the tech scales the underlay in Xactimate until the
// bar reads 10 ft on the grid and the plan is dimensionally correct.
// ============================================================================
const { fetchClaimGraph } = require('./resto-report');
const { blocksOf, footprintOf, placePoint, latestSketch } = require('./resto-floorplan');

const UPF = 40; // scene units per foot (matches resto-scope-quantities and the frontend UNITS_PER_FT)

const OPENING_COLOR = { door: '#1483C2', window: '#11B5C6', opening: '#7C3AED', missing_wall: '#94A3B8' };
const OPENING_LETTER = { door: 'D', window: 'W', opening: 'O', missing_wall: 'M' };

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// canvas_json is jsonb (already an object from Supabase), but tolerate a string too.
function asScene(v) {
  if (v == null) return {};
  if (typeof v === 'string') { try { return JSON.parse(v) || {}; } catch (e) { return {}; } }
  return v;
}

function polyAreaU(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) { const p1 = points[i], p2 = points[(i + 1) % points.length]; a += p1[0] * p2[1] - p2[0] * p1[1]; }
  return Math.abs(a) / 2;
}
function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}
// feet -> feet-inches label, rounded to the nearest inch
function ftIn(ft) {
  const totalIn = Math.round(ft * 12);
  const f = Math.floor(totalIn / 12), i = totalIn % 12;
  return i ? `${f}'${i}"` : `${f}'`;
}

// The largest closed wall polygon WITHIN one set of walls (one sketch). This is the
// room outline. It operates on the footprint's own walls, so the polygon and the
// pivot always come from the same sketch.
function largestPoly(walls) {
  let best = null, bestA = -1;
  for (const w of (walls || [])) {
    if (!w || !Array.isArray(w.points) || w.points.length < 3) continue;
    const a = polyAreaU(w.points);
    if (a > bestA) { bestA = a; best = { id: w.id, points: w.points }; }
  }
  return best;
}

// Place every room in the structure into one shared coordinate space, in feet.
// Mirrors mapClaimToProject: outline and pivot from the room's latest sketch,
// position from the floor-plan block, and a laid-out row fallback when the room has
// no block in the saved plan.
function placeLevel(graph, structureId) {
  const { structures = [], rooms = [], sketches = [] } = graph;
  const st = structures.find((s) => s.id === structureId) || structures[0];
  if (!st) return { structure: null, rooms: [], hasFloorPlan: false };

  const blocks = blocksOf(graph.floorplans || [], st.id);
  const stRooms = rooms.filter((r) => r.structure_id === st.id);
  const placed = [];
  let fallbackX = 0;

  for (const room of stRooms) {
    const rSketches = sketches.filter((s) => s.room_id === room.id);
    const latest = latestSketch(rSketches);
    if (!latest) continue;                                 // no sketch, nothing to draw

    const fp = footprintOf(room, latest.canvas_json);
    if (!fp.hasSketch) continue;                           // latest sketch has no closed wall

    // Outline from the SAME sketch as the pivot (fp.center is the bbox center of
    // fp.walls, so the polygon has to be fp.walls' largest too).
    const poly = largestPoly(fp.walls);
    if (!poly) continue;

    const scene = asScene(latest.canvas_json);
    const block = blocks[room.id];

    const vertsFt = block
      ? poly.points.map((p) => { const w = placePoint(p, fp, block); return [w[0] / UPF, w[1] / UPF]; })
      : poly.points.map((p) => [p[0] / UPF + fallbackX, p[1] / UPF]);

    const openings = [];
    for (const op of (scene.openings || [])) {
      if (op.wallId !== poly.id) continue;
      openings.push({ kind: op.kind || 'door', edge: op.edge || 0, t: (op.t != null ? op.t : 0.5), widthFt: op.widthFt != null ? op.widthFt : 3 });
    }

    placed.push({
      name: room.name || 'Room',
      vertsFt,
      areaFt: Math.round(polyAreaU(poly.points) / (UPF * UPF)),
      openings,
      hasBlock: !!block,
      affected: room.affected !== false
    });
    if (!block) { const xs = vertsFt.map((p) => p[0]); fallbackX = Math.max(...xs) + 6; }
  }

  // shift the level so its min corner sits at origin (relative positions preserved)
  let mnX = Infinity, mnY = Infinity;
  for (const r of placed) for (const v of r.vertsFt) { if (v[0] < mnX) mnX = v[0]; if (v[1] < mnY) mnY = v[1]; }
  if (isFinite(mnX)) for (const r of placed) r.vertsFt = r.vertsFt.map((v) => [v[0] - mnX, v[1] - mnY]);

  return { structure: st, rooms: placed, hasFloorPlan: placed.some((r) => r.hasBlock) };
}

// Pure renderer: placed level -> SVG string. Testable without a database.
function buildLevelUnderlaySvg({ title, structureName, rooms, hasFloorPlan }) {
  let maxX = 0, maxY = 0;
  for (const r of rooms) for (const v of r.vertsFt) { if (v[0] > maxX) maxX = v[0]; if (v[1] > maxY) maxY = v[1]; }
  const wFt = Math.max(maxX, 1), hFt = Math.max(maxY, 1);

  const PX = clamp(2200 / Math.max(wFt, hFt), 14, 40); // pixels per foot
  const padX = 80, padTop = 96, padBottom = 160;
  const W = Math.round(wFt * PX) + padX * 2;
  const H = Math.round(hFt * PX) + padTop + padBottom;
  const X = (x) => padX + x * PX;
  const Y = (y) => padTop + y * PX;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<style>text{font-family:Arial,Helvetica,sans-serif;fill:#111}</style>`);

  // title band
  parts.push(`<text x="${padX}" y="40" font-size="26" font-weight="700">${xmlEsc(title)} \u00b7 ${xmlEsc(structureName)}</text>`);
  parts.push(`<text x="${padX}" y="66" font-size="16" fill="#555">Xactimate Sketch underlay \u00b7 trace over this plan</text>`);

  // rooms
  for (const r of rooms) {
    const pts = r.vertsFt.map((v) => `${X(v[0]).toFixed(1)},${Y(v[1]).toFixed(1)}`).join(' ');
    const fill = r.affected ? '#eef4fb' : '#f3f4f6';
    parts.push(`<polygon points="${pts}" fill="${fill}" stroke="#111" stroke-width="2.5" stroke-linejoin="round"/>`);
  }

  // edge length labels
  for (const r of rooms) {
    const n = r.vertsFt.length;
    for (let i = 0; i < n; i++) {
      const a = r.vertsFt[i], b = r.vertsFt[(i + 1) % n];
      const lenFt = dist(a, b);
      if (lenFt < 1.5) continue;
      const mid = lerp(a, b, 0.5);
      // outward normal (rooms wound CW or CCW; a small offset either way is fine for a label)
      let nx = -(b[1] - a[1]), ny = (b[0] - a[0]);
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      const lx = X(mid[0]) + nx * 14, ly = Y(mid[1]) + ny * 14;
      const label = ftIn(lenFt);
      const w = label.length * 8 + 8;
      parts.push(`<rect x="${(lx - w / 2).toFixed(1)}" y="${(ly - 10).toFixed(1)}" width="${w}" height="16" rx="3" fill="#ffffff" fill-opacity="0.85"/>`);
      parts.push(`<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" font-size="12" text-anchor="middle" fill="#333">${label}</text>`);
    }
  }

  // openings drawn over the wall
  for (const r of rooms) {
    const n = r.vertsFt.length;
    for (const op of r.openings) {
      const a = r.vertsFt[op.edge % n], b = r.vertsFt[(op.edge + 1) % n];
      const edgeLen = dist(a, b) || 1;
      const half = clamp((op.widthFt / edgeLen) / 2, 0, 0.5);
      const p0 = lerp(a, b, clamp(op.t - half, 0, 1));
      const p1 = lerp(a, b, clamp(op.t + half, 0, 1));
      const color = OPENING_COLOR[op.kind] || OPENING_COLOR.door;
      const dash = op.kind === 'missing_wall' ? ' stroke-dasharray="6 5"' : '';
      parts.push(`<line x1="${X(p0[0]).toFixed(1)}" y1="${Y(p0[1]).toFixed(1)}" x2="${X(p1[0]).toFixed(1)}" y2="${Y(p1[1]).toFixed(1)}" stroke="${color}" stroke-width="6"${dash} stroke-linecap="round"/>`);
      const m = lerp(p0, p1, 0.5);
      parts.push(`<text x="${X(m[0]).toFixed(1)}" y="${(Y(m[1]) - 8).toFixed(1)}" font-size="12" font-weight="700" text-anchor="middle" fill="${color}">${OPENING_LETTER[op.kind] || ''}</text>`);
    }
  }

  // room name + area labels
  for (const r of rooms) {
    const c = centroid(r.vertsFt);
    const cx = X(c[0]), cy = Y(c[1]);
    parts.push(`<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="16" font-weight="700" text-anchor="middle">${xmlEsc(r.name)}</text>`);
    parts.push(`<text x="${cx.toFixed(1)}" y="${(cy + 18).toFixed(1)}" font-size="13" text-anchor="middle" fill="#555">${r.areaFt} sf</text>`);
  }

  // bottom band: a long, exact CALIBRATION LINE the tech traces to scale the import.
  // A long line at a round length scales far more accurately than a short 10 ft bar, and
  // the red crosshair ends give an exact click target. Its pixel length is calLen feet at
  // the image scale, so tracing it end to end and entering calLen ft scales the whole plan.
  const calLen = Math.max(10, Math.floor((wFt * 0.85) / 5) * 5);
  const by = padTop + Math.round(hFt * PX) + 46;
  const cx0 = padX, cx1 = padX + calLen * PX;
  const cross = (x) => `<line x1="${x}" y1="${by - 9}" x2="${x}" y2="${by + 9}" stroke="#B91C1C" stroke-width="2.5"/>`;
  parts.push(`<line x1="${cx0}" y1="${by}" x2="${cx1.toFixed(1)}" y2="${by}" stroke="#B91C1C" stroke-width="3"/>`);
  parts.push(cross(cx0));
  parts.push(cross(cx1.toFixed(1)));
  parts.push(`<text x="${((cx0 + cx1) / 2).toFixed(1)}" y="${by - 14}" font-size="16" font-weight="700" text-anchor="middle" fill="#B91C1C">SCALE LINE = ${ftIn(calLen)}</text>`);
  parts.push(`<text x="${padX}" y="${by + 30}" font-size="14" fill="#333">To scale: after Import Underlay Image, choose Set Scale, draw from one red cross to the other, and enter ${calLen} ft 0 in.</text>`);
  parts.push(`<text x="${padX}" y="${by + 50}" font-size="13" fill="#555">Level size ${ftIn(wFt)} x ${ftIn(hFt)}.</text>`);

  const legend = ['door', 'window', 'opening', 'missing_wall'];
  let lx = padX;
  const ly = by + 74;
  for (const k of legend) {
    parts.push(`<line x1="${lx}" y1="${ly - 4}" x2="${lx + 22}" y2="${ly - 4}" stroke="${OPENING_COLOR[k]}" stroke-width="6" stroke-linecap="round"/>`);
    const label = k.replace('_', ' ');
    parts.push(`<text x="${lx + 30}" y="${ly}" font-size="13" fill="#333">${label}</text>`);
    lx += 30 + label.length * 7 + 30;
  }

  if (!hasFloorPlan) {
    parts.push(`<text x="${padX}" y="${by + 98}" font-size="14" font-weight="700" fill="#B45309">No saved floor plan: rooms are shown separately, not in their true relative positions.</text>`);
  }

  parts.push(`</svg>`);
  return parts.join('\n');
}

// Load the claim graph and attach the structures' floor plan rows once, so a single
// fetch serves either one level or all of them.
async function loadGraphWithFloorplans(claimId) {
  const graph = await fetchClaimGraph(claimId);
  if (!graph || !graph.claim) throw new Error('claim not found');
  const structureIds = (graph.structures || []).map((s) => s.id);
  if (structureIds.length) {
    const { supabase } = require('./supabase');
    const { data: floorplans } = await supabase
      .from('resto_structure_floorplans').select('*').in('structure_id', structureIds);
    graph.floorplans = floorplans || [];
  }
  return graph;
}

// Render one structure to a PNG, or null when that structure has no drawn rooms.
async function renderStructurePng(graph, structureId) {
  const sharp = require('sharp');
  const level = placeLevel(graph, structureId);
  if (!level.structure || !level.rooms.length) return null;
  const svg = buildLevelUnderlaySvg({
    title: graph.claim.policyholder_name || graph.claim.address || 'Claim',
    structureName: level.structure.name || 'Structure',
    rooms: level.rooms,
    hasFloorPlan: level.hasFloorPlan
  });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { png, svg, structure: level.structure };
}

// One level. structureId defaults to the claim's first structure.
async function buildClaimUnderlay(claimId, structureId) {
  const graph = await loadGraphWithFloorplans(claimId);
  const ids = (graph.structures || []).map((s) => s.id);
  const out = await renderStructurePng(graph, structureId || ids[0]);
  if (!out) throw new Error('no drawn rooms for this structure');
  return { png: out.png, svg: out.svg, structure: out.structure, claim: graph.claim };
}

// Every level that has drawn rooms, one PNG each. Xactimate imports an underlay per
// level, so this is what the button uses: it yields one underlay per floor instead of
// only the first structure.
async function buildAllUnderlays(claimId) {
  const graph = await loadGraphWithFloorplans(claimId);
  const underlays = [];
  for (const st of (graph.structures || [])) {
    const out = await renderStructurePng(graph, st.id);
    if (out) underlays.push(out);
  }
  if (!underlays.length) throw new Error('no drawn rooms for this claim');
  return { claim: graph.claim, underlays };
}

module.exports = { buildClaimUnderlay, buildAllUnderlays, placeLevel, buildLevelUnderlaySvg };