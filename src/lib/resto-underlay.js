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

function bboxOf(verts) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of verts) { if (v[0] < minx) minx = v[0]; if (v[1] < miny) miny = v[1]; if (v[0] > maxx) maxx = v[0]; if (v[1] > maxy) maxy = v[1]; }
  return { minx, miny, maxx, maxy, w: maxx - minx, h: maxy - miny };
}

// Re-lay every room into a tidy, non-overlapping grid, each at its true scale and shape,
// wrapping rows toward a roughly square overall footprint. Used when the level was not
// laid out, so the underlay is a clean set of rooms to trace instead of a pile.
function gridLayout(rooms) {
  // The vertical gap must clear TWO label bands stacked in it: an opening label hanging below
  // the room above, and the name plus dimensions sitting above the room below. Too tight and
  // a missing-wall label lands on the next room's name.
  const GX = 5, GY = 14;
  const cells = rooms.map((r) => {
    const bb = bboxOf(r.vertsFt);
    return { r, w: bb.w, h: bb.h, local: r.vertsFt.map((v) => [v[0] - bb.minx, v[1] - bb.miny]) };
  });
  const areaSum = cells.reduce((s, c) => s + Math.max(c.w, 1) * Math.max(c.h, 1), 0);
  const maxW = Math.max(1, ...cells.map((c) => c.w));
  const rowTarget = Math.max(maxW, Math.sqrt(areaSum) * 1.6);
  let x = 0, y = 0, rowH = 0;
  for (const c of cells) {
    if (x > 0 && x + c.w > rowTarget) { x = 0; y += rowH + GY; rowH = 0; }
    c.r.vertsFt = c.local.map((p) => [p[0] + x, p[1] + y]);
    x += c.w + GX;
    if (c.h > rowH) rowH = c.h;
  }
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

  // ROOMS ARE ALWAYS DRAWN SEPARATED, on purpose, even when the level has a saved layout.
  // The workflow is to trace one clean room at a time and then push the rooms together in
  // Xactimate, where the walls snap flush. Drawing them already flush would mean tracing
  // shared walls twice, and it would leave nowhere to put a room's name and size except
  // inside the outline being traced. Separate rooms keep every label outside the box.
  gridLayout(placed);

  // shift the level so its min corner sits at origin (relative positions preserved)
  let mnX = Infinity, mnY = Infinity;
  for (const r of placed) for (const v of r.vertsFt) { if (v[0] < mnX) mnX = v[0]; if (v[1] < mnY) mnY = v[1]; }
  if (isFinite(mnX)) for (const r of placed) r.vertsFt = r.vertsFt.map((v) => [v[0] - mnX, v[1] - mnY]);

  return { structure: st, rooms: placed };
}

// Pure renderer: placed level -> SVG string. Testable without a database.
function buildLevelUnderlaySvg({ title, structureName, rooms }) {
  let maxX = 0, maxY = 0;
  for (const r of rooms) for (const v of r.vertsFt) { if (v[0] > maxX) maxX = v[0]; if (v[1] > maxY) maxY = v[1]; }
  const wFt = Math.max(maxX, 1), hFt = Math.max(maxY, 1);

  const longFt = Math.max(wFt, hFt);
  // WHOLE pixels per foot. An integer scale means one foot is always exactly PX pixels, so
  // the scale line (a whole number of feet) is a whole number of pixels and every room edge
  // lands on an exact pixel boundary. Bounded so a big level stays a manageable PNG.
  const PX = Math.max(12, Math.min(64, Math.floor(2800 / longFt)));
  const drawW = Math.round(wFt * PX), drawH = Math.round(hFt * PX);

  // Type and line weights scale WITH the image. A large level makes a large PNG, and a
  // fixed 16 px label or 3 px line becomes a hairline once that image is scaled to fit a
  // screen or the Xactimate import preview. f never drops below 1, so a small plan keeps
  // the base sizes. FS scales fonts, SW scales stroke widths, P scales spacing/offsets.
  const f = Math.max(1, Math.max(drawW, drawH) / 800);
  const FS = (n) => Math.round(n * f);
  const SW = (n) => +(n * f).toFixed(1);
  const P = (n) => Math.round(n * f);

  // Extra margin on the LEFT and BOTTOM: dimensions sit OUTSIDE each room (width below,
  // height to the left), so a tech reading a wall's length never has the number sitting on
  // the wall they are tracing. That was the sloppy part before.
  const padL = P(90), padR = P(90), padTop = P(210), padBottom = P(210);
  const W = drawW + padL + padR;
  const H = drawH + padTop + padBottom;
  // Snap to whole pixels. A wall drawn at a fractional pixel gets anti-aliased into a soft
  // two-pixel smear, and a smear is exactly what makes "where is the wall" ambiguous.
  const X = (x) => Math.round(padL + x * PX);
  const Y = (y) => Math.round(padTop + y * PX);

  // The wall line is drawn THIN and at a FIXED width, never scaled up with the image.
  // This is the whole ballgame for accuracy. A stroke is centered on the true geometry, so a
  // line W pixels thick means the tracer can be off by W/2 on each side. The old line was
  // 9 px at 54 px/ft, which is 2 in of real-world thickness, so tracing outer edges instead
  // of inner edges swung the room by 4 in. At 3 px the worst case is under a quarter inch.
  const WALL_W = 3;

  // Text with a white halo so it reads over any line. rot rotates about its own anchor.
  const halo = (s, x, y, size, color, weight, anchor, rot) => {
    const t = rot ? ` transform="rotate(${rot} ${x} ${y})"` : '';
    return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight || 400}" text-anchor="${anchor || 'middle'}" fill="${color}" stroke="#ffffff" stroke-width="${SW(3.2)}" paint-order="stroke"${t}>${s}</text>`;
  };

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<style>text{font-family:Arial,Helvetica,sans-serif;fill:#111}</style>`);

  // title band
  parts.push(`<text x="${padL}" y="${P(42)}" font-size="${FS(26)}" font-weight="700">${xmlEsc(title)} \u00b7 ${xmlEsc(structureName)}</text>`);
  parts.push(`<text x="${padL}" y="${P(68)}" font-size="${FS(15)}" fill="#555">Xactimate Sketch underlay \u00b7 trace over this plan</text>`);

  // rooms. Thin crisp outline over a light tint: the tint edge and the line are the same
  // place, so there is one obvious thing to trace.
  for (const r of rooms) {
    const pts = r.vertsFt.map((v) => `${X(v[0])},${Y(v[1])}`).join(' ');
    const fill = r.affected ? '#e8f1fb' : '#f1f2f4';
    parts.push(`<polygon points="${pts}" fill="${fill}" stroke="#111" stroke-width="${WALL_W}" stroke-linejoin="miter" shape-rendering="crispEdges"/>`);
  }

  // LABEL BANDS above each room, so nothing collides. Reading upward from the box:
  //   box top, then the opening labels (P(22) out), then the room dimensions (P(56)),
  //   then the room name (P(82)). Each band is clear of the next.
  const BAND_OPENING = P(22), BAND_DIMS = P(56), BAND_NAME = P(82);

  // On a level that was really laid out, rooms sit FLUSH against each other, so the band
  // above a room is the inside of the room above it. Writing the label there would print a
  // room's name across its neighbour. So each room is checked: if the band above it is clear,
  // the label goes outside (the preferred spot, nothing on the outline being traced). If the
  // band is occupied, the label tucks just inside that room's own top edge instead, which is
  // where a real floor plan puts it and is still clear of the middle of the room.
  const bandFt = BAND_NAME / PX;
  const boxes = rooms.map((r) => bboxOf(r.vertsFt));
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i], bb = boxes[i];
    const cx = X((bb.minx + bb.maxx) / 2);
    const topY = Y(bb.miny);
    let clear = true;
    for (let j = 0; j < rooms.length && clear; j++) {
      if (j === i) continue;
      const o = boxes[j];
      if (o.minx < bb.maxx - 0.25 && o.maxx > bb.minx + 0.25
        && o.maxy > bb.miny - bandFt - 0.25 && o.miny < bb.miny - 0.25) clear = false;
    }
    if (clear) {
      parts.push(halo(`${ftIn(bb.w)} x ${ftIn(bb.h)}  \u00b7  ${r.areaFt} sf`, cx, topY - BAND_DIMS, FS(14), '#334155', 600, 'middle'));
      parts.push(halo(xmlEsc(r.name), cx, topY - BAND_NAME, FS(18), '#0E2A4D', 700, 'middle'));
    } else {
      parts.push(halo(xmlEsc(r.name), cx, topY + P(54), FS(15), '#0E2A4D', 700, 'middle'));
      parts.push(halo(`${ftIn(bb.w)} x ${ftIn(bb.h)}  \u00b7  ${r.areaFt} sf`, cx, topY + P(76), FS(13), '#334155', 600, 'middle'));
    }
  }

  // OPENINGS, drawn to read: a bold colored bar across the opening, a jamb tick at each end,
  // a swing arc for a door, and the width and type labeled OUTSIDE the wall. Before, these
  // were a thin line and a single letter, too small to see and with no measurement.
  const OPENING_WORD = { door: 'Door', window: 'Window', opening: 'Opening', missing_wall: 'Missing wall' };
  for (const r of rooms) {
    const cen = centroid(r.vertsFt);
    const n = r.vertsFt.length;
    for (const op of r.openings) {
      const a = r.vertsFt[op.edge % n], b = r.vertsFt[(op.edge + 1) % n];
      const edgeLen = dist(a, b) || 1;
      const half = clamp((op.widthFt / edgeLen) / 2, 0, 0.5);
      const p0 = lerp(a, b, clamp(op.t - half, 0, 1));
      const p1 = lerp(a, b, clamp(op.t + half, 0, 1));
      const color = OPENING_COLOR[op.kind] || OPENING_COLOR.door;

      let ex = b[0] - a[0], ey = b[1] - a[1]; const el = Math.hypot(ex, ey) || 1; ex /= el; ey /= el;
      let nx = -ey, ny = ex;                                   // wall normal
      const mid = lerp(p0, p1, 0.5);
      if ((mid[0] - cen[0]) * nx + (mid[1] - cen[1]) * ny < 0) { nx = -nx; ny = -ny; } // point OUT of the room

      const dash = op.kind === 'missing_wall' ? ` stroke-dasharray="${P(7)} ${P(6)}"` : '';
      parts.push(`<line x1="${X(p0[0])}" y1="${Y(p0[1])}" x2="${X(p1[0])}" y2="${Y(p1[1])}" stroke="${color}" stroke-width="${WALL_W * 2}"${dash} stroke-linecap="butt"/>`);
      // jamb ticks (perpendicular to the wall) at each end
      const jt = P(9);
      for (const pe of [p0, p1]) {
        parts.push(`<line x1="${(X(pe[0]) - nx * jt).toFixed(1)}" y1="${(Y(pe[1]) - ny * jt).toFixed(1)}" x2="${(X(pe[0]) + nx * jt).toFixed(1)}" y2="${(Y(pe[1]) + ny * jt).toFixed(1)}" stroke="${color}" stroke-width="${WALL_W}"/>`);
      }
      // width + type. Normally just outside the wall; but on a flush layout the outside of
      // that wall is the neighbouring room, so flip the label to the inside of this room
      // rather than print it across the room next door.
      const outPt = [mid[0] + (nx * BAND_OPENING) / PX, mid[1] + (ny * BAND_OPENING) / PX];
      let occupied = false;
      for (let j = 0; j < rooms.length && !occupied; j++) {
        if (rooms[j] === r) continue;
        const o = boxes[j];
        if (outPt[0] > o.minx - 0.25 && outPt[0] < o.maxx + 0.25 && outPt[1] > o.miny - 0.25 && outPt[1] < o.maxy + 0.25) occupied = true;
      }
      const s = occupied ? -1 : 1;
      parts.push(halo(`${ftIn(op.widthFt)} ${OPENING_WORD[op.kind] || ''}`, X(mid[0]) + s * nx * BAND_OPENING, Y(mid[1]) + s * ny * BAND_OPENING + P(4), FS(13), color, 700, 'middle'));
    }
  }

  // (room labels are drawn ABOVE each box, above; nothing is drawn inside)


  // bottom band: a long, exact CALIBRATION LINE the tech traces to scale the import. A long
  // line at a round length scales far more accurately than a short bar, and the red crosshair
  // ends give an exact click target. Its pixel length is calLen feet at the image scale, so
  // tracing it end to end and entering calLen ft scales the whole plan. Everything here is
  // sized up with the image so it never renders as a faint hairline on a large plan.
  // A longer reference line is MORE accurate, not less: a fixed clicking error is a smaller
  // fraction of a long line than a short one. So the line spans as much of the plan width as
  // fits, at a whole-foot length, with a red dot at each exact endpoint to click and a tip to
  // zoom in first. Its pixel length is calLen feet at the image scale.
  // THE SCALE LINE. Accuracy here sets the accuracy of the whole sketch, so it is built to
  // remove ambiguity rather than to look bold:
  //   - it is a whole number of feet, and PX is a whole number of pixels, so its pixel length
  //     is exact;
  //   - its endpoints sit on exact pixel positions;
  //   - the line itself is THIN, so there is no thick band to click somewhere inside of;
  //   - the target rings do NOT extend past the endpoint. The old crosshair arms ran 106 px
  //     (about 23 in) beyond the true point, so clicking an arm tip instead of the center
  //     threw the scale off badly.
  // Click the small center dot at each end and enter the printed length.
  const calLen = Math.max(10, Math.floor(wFt * 0.9));
  const by = padTop + drawH + P(64);
  const cx0 = padL, cx1 = padL + calLen * PX;   // exact integers: PX and calLen are integers
  const ring = P(15);
  // BULLSEYE at each end: a ring to find it, a crosshair to aim, and a solid center dot that
  // marks the exact point. The dot is the click target and it sits precisely on the endpoint,
  // so the ring around it is only an aid and never something to click.
  const target = (x) => `<circle cx="${x}" cy="${by}" r="${ring}" fill="#ffffff" fill-opacity="0.9" stroke="#B91C1C" stroke-width="${WALL_W}"/>`
    + `<line x1="${x - ring}" y1="${by}" x2="${x + ring}" y2="${by}" stroke="#B91C1C" stroke-width="${Math.max(1, WALL_W - 1)}"/>`
    + `<line x1="${x}" y1="${by - ring}" x2="${x}" y2="${by + ring}" stroke="#B91C1C" stroke-width="${Math.max(1, WALL_W - 1)}"/>`
    + `<circle cx="${x}" cy="${by}" r="${Math.round(WALL_W * 1.5)}" fill="#B91C1C"/>`;
  parts.push(`<line x1="${cx0}" y1="${by}" x2="${cx1}" y2="${by}" stroke="#B91C1C" stroke-width="${WALL_W}" stroke-linecap="butt"/>`);
  parts.push(target(cx0));
  parts.push(target(cx1));
  parts.push(`<text x="${Math.round((cx0 + cx1) / 2)}" y="${by - P(30)}" font-size="${FS(24)}" font-weight="700" text-anchor="middle" fill="#B91C1C" stroke="#ffffff" stroke-width="${SW(3.2)}" paint-order="stroke">SCALE LINE = ${ftIn(calLen)}</text>`);
  parts.push(`<text x="${padL}" y="${by + P(50)}" font-size="${FS(17)}" fill="#333">Set Scale: zoom in and click the small red dot at the center of each bullseye, then enter ${calLen} ft 0 in.</text>`);
  parts.push(`<text x="${padL}" y="${by + P(70)}" font-size="${FS(15)}" fill="#333">Then trace along the CENTER of each wall line. The line is thin so it cannot shift a room by an inch either way.</text>`);
  parts.push(`<text x="${padL}" y="${by + P(92)}" font-size="${FS(14)}" fill="#555">Check your scale: a traced room should match the size printed above it. Level size ${ftIn(wFt)} x ${ftIn(hFt)}. 1 ft = ${PX} px.</text>`);

  const legend = ['door', 'window', 'opening', 'missing_wall'];
  let lx = padL;
  const ly = by + P(120);
  for (const k of legend) {
    parts.push(`<line x1="${lx}" y1="${ly - P(4)}" x2="${lx + P(24)}" y2="${ly - P(4)}" stroke="${OPENING_COLOR[k]}" stroke-width="${SW(6)}" stroke-linecap="round"/>`);
    const label = k.replace('_', ' ');
    parts.push(`<text x="${lx + P(32)}" y="${ly}" font-size="${FS(13)}" fill="#333">${label}</text>`);
    lx += P(32) + label.length * FS(7) + P(30);
  }

  parts.push(`<text x="${padL}" y="${by + P(146)}" font-size="${FS(16)}" font-weight="700" fill="#0E2A4D">Rooms are drawn separately on purpose. Trace one room at a time, then drag the rooms together in Xactimate and the walls snap flush.</text>`);

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
    rooms: level.rooms
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