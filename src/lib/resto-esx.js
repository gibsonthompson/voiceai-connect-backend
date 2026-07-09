// ============================================================================
// ESX EXPORT (Xactimate / Cotality) — SCAFFOLD
// ----------------------------------------------------------------------------
// An .esx is a ZIP containing one project document (XACTDOC.ZIPXML, UTF-8 XML)
// plus embedded photos (1.JPG, 2.JPG, ...). This module:
//   1. mapClaimToProject(graph)  -> a clean, schema-INDEPENDENT project model
//                                    (correct; reused regardless of XML shape)
//   2. serializeXactdoc(model)   -> the XACTDOC XML  ***REVERSE-ENGINEERING TARGET***
//                                    Element/attribute names + coordinate units
//                                    are BEST-GUESS pending a real reference .esx.
//                                    This is the ONLY part that changes once we
//                                    can unzip a genuine XACTDOC.
//   3. packEsx(xml, photos)      -> the .esx ZIP (correct)
//
// Everything except serializeXactdoc is production-shaped. When a reference file
// arrives, we adjust serializeXactdoc to match; the model + mapping stay.
// Requires: jszip  (npm i jszip)
// ============================================================================
const { fetchClaimGraph } = require('./resto-report');

const UPF = 40; // scene units per foot (matches resto-map-svg)

// ---------- geometry helpers ----------
const toFeet = (v) => +(v / UPF).toFixed(3);
function polyAreaFt(ptsFt) {
  let a = 0;
  for (let i = 0; i < ptsFt.length; i++) {
    const [x1, y1] = ptsFt[i], [x2, y2] = ptsFt[(i + 1) % ptsFt.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
function polyPerimeterFt(ptsFt) {
  let p = 0;
  for (let i = 0; i < ptsFt.length; i++) {
    const [x1, y1] = ptsFt[i], [x2, y2] = ptsFt[(i + 1) % ptsFt.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// ============================================================================
// 1) MAPPING: resto claim graph -> schema-independent project model
// ============================================================================
function mapClaimToProject(graph) {
  const { claim, structures = [], rooms = [], sketches = [], contents = [], media = [] } = graph;

  const [addr = '', cityStateZip = ''] = (claim.address || '').split(/,(.+)/);

  const model = {
    metadata: {
      insured: claim.policyholder_name || '',
      address: (addr || claim.address || '').trim(),
      cityStateZip: (cityStateZip || '').trim(),
      claimNumber: claim.assignment_identifier || claim.carrier_identifier || '',
      policyNumber: claim.policy_number || '',
      carrier: claim.insurance_company || '',
      adjuster: claim.adjuster || '',
      dateOfLoss: claim.date_of_loss || '',
      typeOfLoss: claim.type_of_loss || '',
      category: claim.category_of_water || '',
      className: claim.class_of_water || ''
    },
    levels: [],
    lineItems: [],
    photos: []
  };

  // structures -> levels, rooms -> rooms (geometry from the moisture-map sketch)
  for (const st of structures) {
    const level = { name: st.name || 'Main Level', rooms: [] };
    const stRooms = rooms.filter((r) => r.structure_id === st.id);
    for (const room of stRooms) {
      const rSketches = sketches.filter((s) => s.room_id === room.id);
      // a "wall" polygon in the scene is a room outline; take the largest one
      let best = null, bestArea = 0;
      for (const s of rSketches) {
        for (const w of ((s.canvas_json || {}).walls || [])) {
          if (!w.points || w.points.length < 3) continue;
          const ptsFt = w.points.map((p) => [toFeet(p[0]), toFeet(p[1])]);
          const area = polyAreaFt(ptsFt);
          if (area > bestArea) { bestArea = area; best = { wall: w, ptsFt, sceneWalls: (s.canvas_json || {}).walls }; }
        }
      }
      const r = { name: room.name || 'Room', type: room.name || 'Room', vertices: [], area: 0, perimeter: 0, wallHeight: 8, openings: [] };
      if (best) {
        // normalize so the room's min corner is the origin (Xactimate rooms are local)
        const xs = best.ptsFt.map((p) => p[0]), ys = best.ptsFt.map((p) => p[1]);
        const ox = Math.min(...xs), oy = Math.min(...ys);
        r.vertices = best.ptsFt.map((p) => [+(p[0] - ox).toFixed(3), +(p[1] - oy).toFixed(3)]);
        r.area = +polyAreaFt(r.vertices).toFixed(2);
        r.perimeter = +polyPerimeterFt(r.vertices).toFixed(2);
        // openings (doors/windows) on this room's wall edges
        for (const s of rSketches) {
          for (const op of ((s.canvas_json || {}).openings || [])) {
            if (op.wallId === best.wall.id) {
              r.openings.push({ type: op.type || 'door', edge: op.edge || 0, offsetFt: op.offsetFt || 0, widthFt: op.widthFt || 3, heightFt: op.heightFt || (op.type === 'window' ? 4 : 7) });
            }
          }
        }
      }
      level.rooms.push(r);
    }
    if (level.rooms.length) model.levels.push(level);
  }

  // line items (optional): non-salvageable contents as content line items.
  // NOTE: Xactimate price-list CODES are placeholders pending schema verification.
  for (const c of contents) {
    if (c.disposition === 'non_restorable' || c.disposition === 'disposed') {
      model.lineItems.push({ code: 'CONTENTS', desc: c.description || 'Item', quantity: c.quantity || 1, unit: 'EA', unitPrice: Number(c.replacement_cost) || 0, room: '' });
    }
  }

  // photos placeholder (buffers filled by the caller which has storage access)
  model._photoPaths = (media || []).filter((m) => m.type === 'photo').map((m) => m.storage_path);

  return model;
}

// ============================================================================
// 2) SERIALIZER: project model -> XACTDOC XML   *** BEST-GUESS / VERIFY ***
// ----------------------------------------------------------------------------
// Element/attribute names below are a PLAUSIBLE Xactimate structure inferred
// from public sources, NOT confirmed against a real file. Confirm against a
// reference .esx (unzip -> pretty-print XACTDOC) and correct:
//   - root element + version attributes (xactNetVersion / schema version)
//   - admin/claim block element names
//   - level/room/polygon element + coordinate UNITS (feet vs internal grid)
//   - opening + line-item element names and code format
// Keeping it isolated means only this function changes.
// ============================================================================
function serializeXactdoc(model) {
  const m = model.metadata;
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<!-- SCAFFOLD: structure inferred, verify element names against a real .esx -->');
  L.push('<XACTDOC schemaVersion="TODO-verify" generator="RestorationDocs">');

  // ----- administrative / claim -----
  L.push('  <ADM>');
  L.push('    <ADMINFO>');
  L.push(`      <PROJECTINFO typeOfLoss="${xmlEsc(m.typeOfLoss)}" dateOfLoss="${xmlEsc(m.dateOfLoss)}" catWater="${xmlEsc(m.category)}" classWater="${xmlEsc(m.className)}"/>`);
  L.push(`      <INSUREDINFO name="${xmlEsc(m.insured)}"/>`);
  L.push(`      <LOSSINFO address="${xmlEsc(m.address)}" cityStateZip="${xmlEsc(m.cityStateZip)}"/>`);
  L.push(`      <CLAIMINFO claimNumber="${xmlEsc(m.claimNumber)}" policyNumber="${xmlEsc(m.policyNumber)}" carrier="${xmlEsc(m.carrier)}" adjuster="${xmlEsc(m.adjuster)}"/>`);
  L.push('    </ADMINFO>');
  L.push('  </ADM>');

  // ----- sketch geometry -----
  L.push('  <PROJECT>');
  L.push('    <SKETCHINFO>');
  model.levels.forEach((lvl, li) => {
    L.push(`      <LEVEL id="L${li + 1}" name="${xmlEsc(lvl.name)}">`);
    lvl.rooms.forEach((room, ri) => {
      L.push(`        <ROOM id="L${li + 1}R${ri + 1}" name="${xmlEsc(room.name)}" type="${xmlEsc(room.type)}" wallHeight="${room.wallHeight}" floorArea="${room.area}" perimeter="${room.perimeter}">`);
      L.push('          <POLYGON>');
      room.vertices.forEach((v) => L.push(`            <POINT x="${v[0]}" y="${v[1]}"/>`)); // UNITS = feet (verify)
      L.push('          </POLYGON>');
      room.openings.forEach((op, oi) => {
        L.push(`          <OPENING id="O${oi + 1}" type="${xmlEsc(op.type)}" edge="${op.edge}" offset="${op.offsetFt}" width="${op.widthFt}" height="${op.heightFt}"/>`);
      });
      L.push('        </ROOM>');
    });
    L.push('      </LEVEL>');
  });
  L.push('    </SKETCHINFO>');

  // ----- line items (optional) -----
  if (model.lineItems.length) {
    L.push('    <LINEITEMS>');
    model.lineItems.forEach((it) => {
      L.push(`      <LINEITEM code="${xmlEsc(it.code)}" desc="${xmlEsc(it.desc)}" quantity="${it.quantity}" unit="${xmlEsc(it.unit)}" unitPrice="${it.unitPrice}" room="${xmlEsc(it.room)}"/>`);
    });
    L.push('    </LINEITEMS>');
  }

  L.push('  </PROJECT>');
  L.push('</XACTDOC>');
  return L.join('\n');
}

// ============================================================================
// 3) PACKAGING: XML + photos -> .esx (ZIP)
// ============================================================================
async function packEsx(xml, photos) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('XACTDOC.ZIPXML', xml);
  (photos || []).forEach((buf, i) => { if (buf) zip.file(`${i + 1}.JPG`, buf); });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ============================================================================
// Orchestrator
// ============================================================================
async function buildEsx(claimId, downloadImage) {
  const graph = await fetchClaimGraph(claimId);
  if (!graph.claim) throw new Error('claim not found');
  const model = mapClaimToProject(graph);
  const xml = serializeXactdoc(model);
  let photos = [];
  if (downloadImage && model._photoPaths && model._photoPaths.length) {
    photos = await Promise.all(model._photoPaths.slice(0, 130).map((p) => downloadImage(p).catch(() => null)));
    photos = photos.filter(Boolean);
  }
  const esx = await packEsx(xml, photos);
  return { esx, claim: graph.claim, xml, model };
}

module.exports = { buildEsx, mapClaimToProject, serializeXactdoc, packEsx };