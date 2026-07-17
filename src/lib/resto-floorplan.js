// ============================================================================
// FLOOR PLAN (backend port for the ESX export)
// ----------------------------------------------------------------------------
// resto-esx.js positions each room in the structure using the saved floor plan.
// This is the backend half of frontend/src/features/floorplan/floorPlanModel.ts.
// Only the pieces the export needs are ported, and placePoint is copied VERBATIM
// from the frontend so a room lands at the exact world coordinates the tech placed
// it at. A block is a room footprint placed at { x, y, rotation }; geometry is read
// live from the room's sketch, never copied.
//
// layout_json (on resto_structure_floorplans) stores WHERE rooms sit: { blocks: [] }.
// canvas_json (on resto_sketches) is the normalized scene and holds the walls.
// ============================================================================
const { UPF } = require('./resto-scope-quantities');

const DEG = Math.PI / 180;

function asObject(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return v;
}

// The room's footprint from its latest sketch, or a placeholder rectangle from
// room dimensions (fallback 12x12 ft) when unsketched. center = bbox center =
// the rotation pivot, and it must span ALL walls, matching the frontend, or a
// rotated room lands off its pivot.
function footprintOf(room, sketchJson) {
  const scene = asObject(sketchJson);
  let walls = ((scene && scene.walls) || []).filter((w) => w && Array.isArray(w.points) && w.points.length >= 3);
  const hasSketch = walls.length > 0;
  if (!hasSketch) {
    const w = (Number(room.width_ft) || 12) * UPF;
    const h = (Number(room.length_ft) || 12) * UPF;
    walls = [{ id: 'placeholder', points: [[0, 0], [w, 0], [w, h], [0, h]] }];
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of walls) for (const pt of p.points) {
    const x = pt[0], y = pt[1];
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return {
    roomId: room.id, name: room.name, hasSketch, walls,
    center: [(minX + maxX) / 2, (minY + maxY) / 2],
    w: maxX - minX, h: maxY - minY
  };
}

// Verbatim from floorPlanModel.ts: world = b.xy + R(a) . (local - center).
function placePoint(p, fp, b) {
  const px = p[0], py = p[1];
  const dx = px - fp.center[0], dy = py - fp.center[1];
  const a = (b.rotation || 0) * DEG, cos = Math.cos(a), sin = Math.sin(a);
  return [b.x + dx * cos - dy * sin, b.y + dx * sin + dy * cos];
}

// Blocks for one structure, keyed by room id, from its resto_structure_floorplans
// row. Missing plan or unknown column shape returns {}, and the export falls back
// to a laid-out row (no crash), so this degrades instead of failing.
function blocksOf(floorplans, structureId) {
  const out = {};
  if (!Array.isArray(floorplans)) return out;
  const row = floorplans.find((f) => f && f.structure_id === structureId);
  if (!row) return out;
  const layout = asObject(row.layout_json != null ? row.layout_json : (row.layout != null ? row.layout : row));
  const blocks = Array.isArray(layout) ? layout : (layout && Array.isArray(layout.blocks) ? layout.blocks : []);
  for (const b of blocks) {
    if (!b || b.roomId == null) continue;
    out[b.roomId] = { roomId: b.roomId, x: Number(b.x) || 0, y: Number(b.y) || 0, rotation: Number(b.rotation) || 0 };
  }
  return out;
}

// The room's latest sketch, defined the way FloorPlanEditor defines it: resto_sketches
// ordered by created_at descending, first row. Its walls are the footprint the tech
// placed the block against, so this must pick the SAME sketch or the pivot moves.
function latestSketch(sketches) {
  if (!Array.isArray(sketches) || !sketches.length) return null;
  const ts = (s) => Date.parse((s && (s.created_at || s.updated_at)) || '') || 0;
  return sketches.reduce((best, s) => (ts(s) >= ts(best) ? s : best));
}

module.exports = { footprintOf, placePoint, blocksOf, latestSketch };