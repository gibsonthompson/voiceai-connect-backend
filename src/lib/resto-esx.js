// ============================================================================
// ESX EXPORT (Xactimate / Cotality)
// ----------------------------------------------------------------------------
// An .esx is a ZIP containing one project document (XACTDOC.ZIPXML, UTF-8 XML)
// plus embedded photos (1.JPG, 2.JPG, ...). This module:
//   1. mapClaimToProject(graph)  -> a clean, schema-INDEPENDENT project model
//                                    (geometry + real line items). Correct and
//                                    reused regardless of the final XML shape.
//   2. serializeXactdoc(model)   -> the XACTDOC XML  ***REVERSE-ENGINEERING TARGET***
//                                    Element/attribute names + coordinate units
//                                    are BEST-GUESS pending a real reference .esx.
//                                    This is the ONLY part that changes once we
//                                    can unzip a genuine XACTDOC. See
//                                    xactimate-integration-map.md section 8.
//   3. packEsx(xml, photos)      -> the .esx ZIP (correct)
//
// Quantities come from the shared engine (resto-scope-quantities) so the ESX and
// the PDF report bill identical numbers. Selector codes come from the isolated
// lookup (resto-xactimate-codes) so only that table changes on verification.
// Requires: jszip  (npm i jszip)
// ============================================================================
const { fetchClaimGraph } = require('./resto-report');
const {
  UPF, areaFt, perimeterFt, edgeLenFt, largestRoomPolygon, equipmentUnitDays, roomScope
} = require('./resto-scope-quantities');
const { EQUIP_CODE, selectorFor, flooringCodeKey } = require('./resto-xactimate-codes');

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// ============================================================================
// LINE ITEMS: turn a room's measured scope into Xactimate line items.
// ----------------------------------------------------------------------------
// Deliberately CONSERVATIVE so the estimate survives a scrub (no fabricated
// demolition): extraction applies to a wet floor left to dry; antimicrobial only
// on Category 2+; drywall removal only where a flood cut was actually drawn;
// containment where a barrier was placed. Flooring TEAR-OUT is driven by the wet
// area's disposition ('remove' -> FCC/FCV/FCW/FCT via flooringCodeKey); a wet
// floor left to dry in place bills extraction instead, never both on the same SF
// (XactAnalysis flags a same-type, same-SF tear-out + removal overlap as a scrub).
//
// Every emitted line carries an adjuster-facing F9 justification string built
// from the measured facts (sqft, material, category, class, date of loss, room),
// surfaced both as the ESX line-item NOTE and, verbatim, under the same line in
// the PDF report. context = { category, className, dateOfLoss }; a bare category
// number is still accepted for backward compatibility.
// ============================================================================
function buildRoomLineItems(roomSketches, roomName, context) {
  const ctx = (context && typeof context === 'object') ? context : { category: context };
  const categoryOfWater = ctx.category;
  const className = ctx.className;
  const dateOfLoss = ctx.dateOfLoss;

  // shared note fragments so every line reads consistently
  const where = roomName ? ` (${roomName})` : '';
  const catLabel = categoryOfWater ? `Category ${categoryOfWater}` : 'Water';
  const classLabel = className ? `, Class ${className}` : '';
  const dol = dateOfLoss ? ` Date of loss ${dateOfLoss}.` : '';

  const scope = roomScope(roomSketches);
  const items = [];
  const push = (key, quantity, note) => {
    if (!quantity || quantity <= 0) return;
    const s = selectorFor(key, categoryOfWater);
    if (!s) return;
    items.push({ cat: s.cat, sel: s.sel, unit: s.unit, quantity: r2(quantity), desc: s.desc, confidence: s.confidence, room: roomName, note: note || '' });
  };

  // wet floor: dry in place -> extraction; remove -> flooring tear-out.
  // Either/or, never both on the same SF (double-billing is a scrub trigger).
  for (const wf of scope.wetFloorByMaterial) {
    const mat = wf.material || 'flooring';
    if (wf.disposition === 'remove') {
      const key = flooringCodeKey(wf.material);
      if (key) push(key, wf.sqft, `Flooring tear-out, ${r2(wf.sqft)} SF of ${mat}${where}. ${catLabel}${classLabel} loss.${dol} Non-salvageable; removed rather than dried in place. Affected area measured on the moisture map.`);
      else push('extraction_hard', wf.sqft, `Water extraction from ${r2(wf.sqft)} SF of wet ${mat}${where} (no tear-out code for this material; billed as extraction). ${catLabel}${classLabel} loss.${dol} Affected area measured on the moisture map.`);
    } else {
      const key = /carpet/i.test(wf.material) ? 'extraction_carpet' : 'extraction_hard';
      push(key, wf.sqft, `Water extraction from ${r2(wf.sqft)} SF of wet ${mat}${where}. ${catLabel}${classLabel} loss.${dol} Affected area measured on the moisture map.`);
    }
  }

  // antimicrobial: only defensible on Category 2 or 3 (S500 is specific about Cat 1)
  if (Number(categoryOfWater) >= 2 && scope.affectedFloorSqFt > 0) {
    push('antimicrobial', scope.affectedFloorSqFt, `Antimicrobial applied to ${r2(scope.affectedFloorSqFt)} SF of affected flooring${where}. Required for ${catLabel}${classLabel} loss per IICRC S500.${dol}`);
  }

  // flood cuts -> drywall removal, bucketed by cut height
  for (const c of scope.floodCuts) {
    if (c.heightFt <= 0.34) push('drywall_lf_4in', c.lf, `Wet drywall removed, ${r2(c.lf)} LF flood cut at 4 in${where}. ${catLabel}${classLabel} loss.${dol} Cut line documented on the moisture map.`);
    else if (c.heightFt <= 2) push('drywall_lf_2ft', c.lf, `Wet drywall removed, ${r2(c.lf)} LF flood cut at ${c.heightFt} ft${where}. ${catLabel}${classLabel} loss.${dol} Cut line documented on the moisture map.`);
    else push('drywall_sf', c.sqft, `Wet drywall removed, ${r2(c.sqft)} SF flood cut at ${c.heightFt} ft${where}. ${catLabel}${classLabel} loss.${dol} Cut line documented on the moisture map.`);
  }

  // containment barrier
  if (scope.containment.sqft > 0) {
    push('containment', scope.containment.sqft, `Containment barrier, ${r2(scope.containment.sqft)} SF (${scope.containment.count} barrier${scope.containment.count === 1 ? '' : 's'})${where}. Installed to isolate the affected area during ${catLabel}${classLabel} mitigation.${dol}`);
  }

  return items;
}

// ============================================================================
// 1) MAPPING: resto claim graph -> schema-independent project model
// ============================================================================
function mapClaimToProject(graph) {
  const { claim, structures = [], rooms = [], sketches = [], contents = [], media = [], equipment = [] } = graph;
  const cat = claim.category_of_water;
  // F9 justification context, shared by every room's line items
  const liContext = { category: claim.category_of_water, className: claim.class_of_water, dateOfLoss: claim.date_of_loss };

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
      const roomName = room.name || 'Room';
      const poly = largestRoomPolygon(rSketches);

      const r = { name: roomName, type: roomName, vertices: [], area: 0, perimeter: 0, wallHeight: 8, openings: [] };
      if (poly) {
        // normalize so the room's min corner is the origin (Xactimate rooms are local)
        const ptsFt = poly.points.map((p) => [p[0] / UPF, p[1] / UPF]);
        const xs = ptsFt.map((p) => p[0]), ys = ptsFt.map((p) => p[1]);
        const ox = Math.min(...xs), oy = Math.min(...ys);
        r.vertices = ptsFt.map((p) => [r3(p[0] - ox), r3(p[1] - oy)]);
        r.area = r2(areaFt(poly.points));
        r.perimeter = r2(perimeterFt(poly.points));

        // openings on this room's outline. FIX: scene stores { wallId, edge, t,
        // widthFt, kind }. Old code read op.type/op.offsetFt/op.heightFt (which do
        // not exist), so every opening became a 7 ft door at offset 0. Now we read
        // the real fields: kind, t (0..1 along the edge) -> offset in feet, and a
        // sensible default height per kind.
        for (const s of rSketches) {
          for (const op of ((s.canvas_json || {}).openings || [])) {
            if (op.wallId !== poly.id) continue;
            const kind = op.kind || 'door';
            const edgeFt = edgeLenFt(poly.points, op.edge || 0);
            const widthFt = op.widthFt || (kind === 'opening' ? 4 : 3);
            const heightFt = kind === 'window' ? 4 : 6.67; // ~80 in door/opening, ~4 ft window
            const offsetFt = r2((op.t != null ? op.t : 0.5) * edgeFt);
            r.openings.push({ kind, edge: op.edge || 0, offsetFt, widthFt, heightFt });
          }
        }
      }
      level.rooms.push(r);

      // room-scoped line items (extraction/tear-out, antimicrobial, drywall, containment)
      for (const it of buildRoomLineItems(rSketches, roomName, liContext)) model.lineItems.push(it);
    }
    if (level.rooms.length) model.levels.push(level);
  }

  // claim-level equipment line items (Xactimate bills equipment by unit-days, not
  // by map position; days come from resto_equipment, not the sketch icons).
  // Equipment-days is the single most-scrubbed mitigation line, so the F9 note
  // points the adjuster straight at the daily drying log where the placement and
  // removal dates live, and cites S500 for the sizing.
  const EQUIP_LABEL = { air_mover: 'Air movers', dehumidifier: 'Dehumidifiers', air_scrubber: 'Air scrubbers' };
  const pieceCount = {}; // total units placed by type (sum of actual_placed), for the note only
  for (const e of equipment) { const q = e.actual_placed || 1; pieceCount[e.type] = (pieceCount[e.type] || 0) + q; }
  const ud = equipmentUnitDays(equipment);
  for (const type of Object.keys(EQUIP_CODE)) {
    if (!ud[type]) continue;
    const s = selectorFor(EQUIP_CODE[type], cat);
    if (!s) continue;
    const label = EQUIP_LABEL[type] || type;
    const pieces = pieceCount[type] || 0;
    const piecesTxt = pieces ? ` (${pieces} unit${pieces === 1 ? '' : 's'} placed)` : '';
    const note = `${label}: ${ud[type]} unit-days${piecesTxt}. Placement and removal dates are recorded in the daily drying log; equipment sized per IICRC S500.`;
    model.lineItems.push({ cat: s.cat, sel: s.sel, unit: s.unit, quantity: ud[type], desc: s.desc, confidence: s.confidence, room: '', note });
  }

  // non-salvageable contents (VERIFY code; contents usually live in XactContents)
  for (const c of contents) {
    if (c.disposition !== 'non_restorable' && c.disposition !== 'disposed') continue;
    const s = selectorFor('contents_loss', cat);
    if (!s) continue;
    const desc = c.description || s.desc;
    const dispTxt = c.disposition === 'disposed' ? 'disposed' : 'non-salvageable';
    const note = `${desc}: ${dispTxt} total loss (qty ${c.quantity || 1}). Documented for the Coverage C contents claim; see the Schedule of Loss inventory.`;
    model.lineItems.push({ cat: s.cat, sel: s.sel, unit: s.unit, quantity: c.quantity || 1, unitPrice: Number(c.replacement_cost) || 0, desc, confidence: s.confidence, room: '', note });
  }

  // photos placeholder (buffers filled by the caller which has storage access)
  model._photoPaths = (media || []).filter((m) => m.type === 'photo').map((m) => m.storage_path);

  return model;
}

// ============================================================================
// 2) SERIALIZER: project model -> XACTDOC XML   *** BEST-GUESS / VERIFY ***
// ----------------------------------------------------------------------------
// Element/attribute names below are a PLAUSIBLE Xactimate structure inferred from
// public sources, NOT confirmed against a real file. The MODEL above is correct;
// only the names + coordinate units here change once we diff a reference .esx.
// Confirm and correct:
//   - root element + version attributes (schema version)
//   - admin/claim block element names
//   - level/room/polygon element + coordinate UNITS (feet vs internal grid)
//   - opening element names + how offset/kind are encoded
//   - line-item element: exact CAT + SEL attribute names, modifier/activity codes
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
        L.push(`          <OPENING id="O${oi + 1}" kind="${xmlEsc(op.kind)}" edge="${op.edge}" offset="${op.offsetFt}" width="${op.widthFt}" height="${op.heightFt}"/>`);
      });
      L.push('        </ROOM>');
    });
    L.push('      </LEVEL>');
  });
  L.push('    </SKETCHINFO>');

  // ----- line items -----
  if (model.lineItems.length) {
    L.push('    <LINEITEMS>');
    model.lineItems.forEach((it) => {
      if (it.confidence === 'verify') L.push(`      <!-- VERIFY selector: ${xmlEsc(it.desc || '')} -->`);
      const attrs = `cat="${xmlEsc(it.cat)}" sel="${xmlEsc(it.sel)}" desc="${xmlEsc(it.desc || '')}" quantity="${it.quantity}" unit="${xmlEsc(it.unit || '')}" unitPrice="${it.unitPrice || 0}" room="${xmlEsc(it.room || '')}"`;
      if (it.note) {
        // F9 line-item note. Element name <NOTE> is BEST-GUESS like the rest of the
        // wrapper; the note CONTENT is correct and reused verbatim in the PDF report.
        L.push(`      <LINEITEM ${attrs}>`);
        L.push(`        <NOTE>${xmlEsc(it.note)}</NOTE>`);
        L.push('      </LINEITEM>');
      } else {
        L.push(`      <LINEITEM ${attrs}/>`);
      }
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

module.exports = { buildEsx, mapClaimToProject, serializeXactdoc, packEsx, buildRoomLineItems };