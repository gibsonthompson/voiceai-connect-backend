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
  UPF, areaFt, perimeterFt, edgeLenFt, largestRoomPolygon, equipmentUnitDays, roomScope,
  roomDimensions, dimVarsString
} = require('./resto-scope-quantities');

// Standard opening sizes. Used ONLY when nothing was measured, and every such use is
// recorded as an assumption (see the openings block below). A missing wall is null
// because it is full ceiling height by definition.
const OPENING_DEFAULT_WIDTH_FT = { door: 3, opening: 4, window: 3, missing_wall: 6 };
const OPENING_DEFAULT_HEIGHT_FT = { door: 6 + 8 / 12, window: 4, opening: 6 + 8 / 12, missing_wall: null };
const { EQUIP_CODE, selectorFor, flooringCodeKey } = require('./resto-xactimate-codes');
const { footprintOf, placePoint, blocksOf, latestSketch } = require('./resto-floorplan');

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
      insuredPhone: claim.policyholder_phone || '',
      insuredEmail: claim.policyholder_email || '',
      dateOfLoss: claim.date_of_loss || '',
      dateReceived: claim.date_received || '',
      dateContacted: claim.date_contacted || '',
      dateInspected: claim.date_inspected || '',
      catCode: claim.cat_code || '',
      typeOfLoss: claim.type_of_loss || '',
      causeOfLoss: claim.cause_of_loss || '',
      dateDiscovered: claim.date_discovered || '',
      lossOnset: claim.loss_onset || '',
      policyType: claim.policy_type || '',
      deductible: claim.deductible != null ? claim.deductible : '',
      estimator: claim.estimator || '',
      category: claim.category_of_water || '',
      className: claim.class_of_water || ''
    },
    levels: [],
    lineItems: [],
    photos: []
  };

  // structures -> levels, rooms -> rooms.
  // A room's SHAPE comes from its moisture-map sketch. Its PLACE comes from the
  // structure floor plan (resto_structure_floorplans). Both are Xactimate fields,
  // and until now we only had the first: rooms were emitted in an arbitrary row, so
  // Xactimate received correct rooms in a building that did not exist. With a saved
  // layout the whole level shares one coordinate space, and rooms the tech snapped
  // flush are flush in the export.
  const floorplans = graph.floorplans || [];
  let assumedOpenings = 0;
  let assumedCeilings = 0;

  for (const st of structures) {
    const level = { name: st.name || 'Main Level', rooms: [] };
    const stRooms = rooms.filter((r) => r.structure_id === st.id);
    const blocks = blocksOf(floorplans, st.id);
    // Ceiling height: the ROOM overrides the STRUCTURE default. Most houses have one
    // height with exceptions (a vaulted living room, a low basement), so typing it once
    // per structure is the difference between a tech using this and skipping it.
    const structureCeiling = Number(st.default_ceiling_height_ft) > 0 ? Number(st.default_ceiling_height_ft) : null;
    // Rooms fall back to a laid-out row ONLY when the structure has no floor plan.
    let fallbackX = 0;

    for (const room of stRooms) {
      const rSketches = sketches.filter((s) => s.room_id === room.id);
      const roomName = room.name || 'Room';
      const poly = largestRoomPolygon(rSketches);

      const roomCeiling = Number(room.height_ft) > 0 ? Number(room.height_ft) : structureCeiling;
      const ceilingFt = roomCeiling || 8;                 // last-resort default
      if (!roomCeiling) assumedCeilings++;                // and we say so, rather than bill a guess in silence

      const r = {
        name: roomName, type: roomName, vertices: [], area: 0, perimeter: 0,
        wallHeight: ceilingFt, openings: [], affected: room.affected !== false,
        assumedCeiling: !roomCeiling
      };
      if (poly) {
        // The tech positioned the block against the room's LATEST sketch, so the
        // footprint (and therefore the rotation pivot) must come from that same
        // sketch, or the room lands somewhere they never put it. Line-item
        // quantities still aggregate across every sketch; that is a different question.
        const latest = latestSketch(rSketches);
        const fp = footprintOf(room, latest ? latest.canvas_json : null);
        const block = blocks[room.id];

        const ptsFt = block
          ? poly.points.map((p) => { const w = placePoint(p, fp, block); return [w[0] / UPF, w[1] / UPF]; })
          : poly.points.map((p) => [p[0] / UPF + fallbackX, p[1] / UPF]);

        r.vertices = ptsFt.map((p) => [r3(p[0]), r3(p[1])]);
        r.area = r2(areaFt(poly.points));
        r.perimeter = r2(perimeterFt(poly.points));
        if (!block) {
          const xs = ptsFt.map((p) => p[0]);
          fallbackX = Math.max(...xs) + 6;   // 6 ft gutter, only when there is no plan
        }

        // openings on this room's outline. FIX: scene stores { wallId, edge, t,
        // widthFt, kind }. Old code read op.type/op.offsetFt/op.heightFt (which do
        // not exist), so every opening became a 7 ft door at offset 0. Now we read
        // the real fields: kind, t (0..1 along the edge) -> offset in feet, and a
        // sensible default height per kind.
        // Opening heights are MEASUREMENTS, not guesses.
        //
        // This block used to hardcode `heightFt = kind === 'window' ? 4 : 6.67`, which
        // is fabricated measurement data on an insurance document. It was harmless only
        // while nothing consumed it. Now that wall area deducts openings
        //     W = (perimeter x ceiling height) - SUM(width x HEIGHT)
        // an invented height is an invented dollar amount on every paint and drywall
        // line. So we read the captured height, and when one is genuinely missing we
        // fall back to a standard size AND record that it was assumed, so it surfaces
        // instead of hiding.
        for (const s of rSketches) {
          for (const op of ((s.canvas_json || {}).openings || [])) {
            if (op.wallId !== poly.id) continue;
            const kind = op.kind || 'door';
            const edgeFt = edgeLenFt(poly.points, op.edge || 0);
            let widthFt = op.widthFt != null ? op.widthFt : OPENING_DEFAULT_WIDTH_FT[kind];
            widthFt = Math.max(0, Math.min(widthFt, edgeFt || widthFt));   // never wider than its wall

            let heightFt, assumed = false;
            if (kind === 'missing_wall') {
              heightFt = ceilingFt;                       // a missing wall IS the full height
            } else if (op.heightFt != null && op.heightFt > 0) {
              heightFt = Math.min(op.heightFt, ceilingFt);
            } else {
              heightFt = Math.min(OPENING_DEFAULT_HEIGHT_FT[kind] || ceilingFt, ceilingFt);
              assumed = true;
              assumedOpenings++;
            }

            const offsetFt = r2((op.t != null ? op.t : 0.5) * edgeFt);
            r.openings.push({ kind, edge: op.edge || 0, offsetFt, widthFt: r2(widthFt), heightFt: r2(heightFt), assumedHeight: assumed });
          }
        }
      }
      // Xactimate's own room variables. Its line items bill against these as FORMULAS
      // (the reference file's drywall line is calc="WC"), so Xactimate recomputes each
      // quantity from the sketch. Emit them right and build-back lines come almost free.
      //   F floor SF, C ceiling SF, SY floor sq yards, PF/PC perimeter,
      //   W wall SF = (PF x ceiling height) - openings, WC = W + C
      r.dims = roomDimensions(rSketches, ceilingFt);
      r.lastDims = dimVarsString(r.dims);
      level.rooms.push(r);

      // room-scoped line items (extraction/tear-out, antimicrobial, drywall, containment)
      for (const it of buildRoomLineItems(rSketches, roomName, liContext)) model.lineItems.push(it);
    }
    if (level.rooms.length) {
      // Shift the whole level so its min corner sits at the origin. Relative
      // positions (which is what the floor plan captured) are preserved exactly.
      let mnX = Infinity, mnY = Infinity;
      for (const rm of level.rooms) for (const v of rm.vertices) { if (v[0] < mnX) mnX = v[0]; if (v[1] < mnY) mnY = v[1]; }
      if (isFinite(mnX)) {
        for (const rm of level.rooms) rm.vertices = rm.vertices.map((v) => [r3(v[0] - mnX), r3(v[1] - mnY)]);
      }
      level.hasFloorPlan = Object.keys(blocks).length > 0;
      model.levels.push(level);
    }
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
    // NO PRICE. Xactimate re-prices every line from the Verisk price list for the
    // region and the date of loss. Sending a price is at best ignored and at worst a
    // number an adjuster can argue with. We send WHAT and HOW MUCH (cat, sel, qty,
    // unit); Xactimate decides what it is worth. This was the last place a dollar
    // value leaked into the export.
    model.lineItems.push({ cat: s.cat, sel: s.sel, unit: s.unit, quantity: c.quantity || 1, desc, confidence: s.confidence, room: '', note });
  }

  // Assumptions carried out of the export, so nothing rests on a guess in silence.
  // Wall area is a dollar figure; a tech has to know when one is a default.
  model.assumptions = {
    openingsWithoutMeasuredHeight: assumedOpenings,
    roomsWithoutMeasuredCeiling: assumedCeilings
  };

  // photos placeholder (buffers filled by the caller which has storage access)
  model._photoPaths = (media || []).filter((m) => m.type === 'photo').map((m) => m.storage_path);

  return model;
}

// ============================================================================
// 2) SERIALIZER: project model -> XACTDOC XML
// ----------------------------------------------------------------------------
// REWRITTEN against a REAL XACTDOC pulled from an actual Xactimate estimate
// (see xactdoc-reference-findings.md). The previous version was invented and
// wrong in almost every element name. What we now know from the reference:
//
//   * The document is ATTRIBUTE-CENTRIC. Almost nothing is element text.
//   * There is NO <LINEITEM> element. A line item is split in two:
//       - the DEFINITION lives in EMBEDDED_PL/SUMITEMS/SUMITEM
//         (id, cat, sel, act, desc, unit)
//       - the USAGE lives in a room GROUP as ITEMS/ITEM/SUMMARY_REF
//         (sumRef -> the SUMITEM id, plus qty)
//   * A NOTE is its own ITEM with type="N" attached="1", holding
//     ITEM_NOTE/NOTE CDATA. It is a SIBLING of the line item, not a child.
//     (Our F9 justification strings are the right content, wrong place before.)
//   * act is the activity: '+' install/replace, '-' remove, '&' R&R.
//     Our WTR mitigation selectors are services performed, so act='+'.
//     (Flooring tear-out under WTR/FCC is already a removal SELECTOR, which is
//     a different model from the FCC/AV act='-' pairing the reference uses for
//     reconstruction. We stay in the WTR mitigation model.)
//   * Sketch coordinates are integers at 1524 units per foot, held in one flat
//     COORDINATE3 list; walls and vertices INDEX into it.
//   * Cross-references use the NUMERIC part of an id (wallIDs="741 759" refers
//     to SKETCHWALL id="SKT741").
//
// Still unverified: whether XACTDOC.ZIPXML is stored compressed inside the .esx
// (see packEsx). That is a packaging question, not a serialization one.
// ============================================================================

const XU = 1524;                                  // Xactimate sketch units per foot
const ftToU = (ft) => Math.round(ft * XU);        // feet -> Xactimate integer units
const numOf = (id) => String(id).replace(/^\D+/, '');   // 'SKT741' -> '741'
const cdata = (s) => `<![CDATA[${String(s == null ? '' : s).replace(/]]>/g, ']]&gt;')}]]>`;

// TOL code, from the loss type. The reference uses <TOL code="FLOOD" desc="Flood"/>.
const TOL_CODE = { water: 'WATER', fire: 'FIRE', mold: 'MOLD', other: 'OTHER' };

function serializeXactdoc(model) {
  const m = model.metadata;
  const L = [];
  const p = (s) => L.push(s);

  // ---- id allocation -------------------------------------------------------
  let nSum = 0, nItm = 0, nGrp = 0, nSkt = 0, nCnt = 0, nExt = 0;

  // SUMITEM definitions, deduped: many rooms can share one definition, and the
  // reference does exactly that (one SUMITEM, referenced from several rooms).
  const sums = [];
  const sumByKey = new Map();
  const sumFor = (it) => {
    const act = '+';
    const key = [it.cat, it.sel, act, it.unit, it.desc].join('\u0000');
    if (!sumByKey.has(key)) {
      const s = { id: 'SUM' + (++nSum), cat: it.cat, sel: it.sel, act, unit: it.unit || '', desc: it.desc || '' };
      sumByKey.set(key, s); sums.push(s);
    }
    return sumByKey.get(key);
  };
  for (const it of model.lineItems) sumFor(it);

  const byRoom = new Map();     // room name -> line items
  const claimLevel = [];
  for (const it of model.lineItems) {
    if (it.room) { if (!byRoom.has(it.room)) byRoom.set(it.room, []); byRoom.get(it.room).push(it); }
    else claimLevel.push(it);
  }

  // ---- header --------------------------------------------------------------
  p('<?xml version="1.0" encoding="UTF-8"?>');
  p('<XACTDOC>');
  p('  <XACTNET_INFO estimateType="CONTR"/>');
  p('  <ATTACHMENTS/>');
  p(`  <PROJECT_INFO type="Standard" dataType="Residential" name="${xmlEsc(m.insured || 'Claim')}" status="Completed" created="${new Date().toISOString().slice(0, 19)}">`);
  p('    <NOTES/><XPERT_VARS/><IMAGE/>');
  p('  </PROJECT_INFO>');

  // ---- ADM: dates, type/cause of loss, coverage ----------------------------
  const admAttrs = [
    m.dateReceived ? `dateReceived="${xmlEsc(m.dateReceived)}"` : null,
    m.dateOfLoss ? `dateOfLoss="${xmlEsc(m.dateOfLoss)}"` : null,
    m.dateContacted ? `dateContacted="${xmlEsc(m.dateContacted)}"` : null,
    m.dateInspected ? `dateInspected="${xmlEsc(m.dateInspected)}"` : null
  ].filter(Boolean).join(' ');
  p(`  <ADM ${admAttrs}>`);
  p('    <SUBROGATION_NOTES/>');
  p('    <TYPESOFLOSS>');
  p(`      <TYPEOFLOSS deductible="${m.deductible === '' ? 0 : m.deductible}" catastrophe="${xmlEsc(m.catCode || '')}" claimNumber="${xmlEsc(m.claimNumber)}" policyNumber="${xmlEsc(m.policyNumber)}">`);
  const tolCode = TOL_CODE[String(m.typeOfLoss || '').toLowerCase()] || 'OTHER';
  p(`        <TOL code="${tolCode}" desc="${xmlEsc(m.typeOfLoss || '')}">`);
  // COL = cause of loss. This is the sudden-vs-gradual evidence, and the single
  // most common ground a water claim is denied on. It belongs in the file.
  if (m.causeOfLoss) p(`          <COL desc="${xmlEsc(m.causeOfLoss)}"/>`);
  p('        </TOL>');
  p('      </TYPEOFLOSS>');
  p('    </TYPESOFLOSS>');
  p(`    <COVERAGE_INFO policyType="${xmlEsc(m.policyType || 'homeowner')}">`);
  p('      <HOMEOWNER_COVERAGE_INFO><FORMS/><ADD_SUBLIMITS/></HOMEOWNER_COVERAGE_INFO>');
  p('    </COVERAGE_INFO>');
  p('  </ADM>');

  // Xactimate re-prices from its own price list, so we deliberately set no
  // prices. overhead/profit are left at Xactimate's defaults.
  p('  <PARAMS><PCA/><BURDENTAXES/><WORKERSCOMPS/><FRINGEBENEFITS/><GENERAL_LIABILITIES/><SALESTAXES/></PARAMS>');

  // ---- CONTACTS ------------------------------------------------------------
  p('  <CONTACTS>');
  const [street = '', rest = ''] = String(m.address || '').split(/,(.+)/);
  const csz = (m.cityStateZip || rest || '').trim();
  const mCsz = csz.match(/^(.*?)[,\s]+([A-Za-z]{2})\s+(\d{5})/);
  const city = mCsz ? mCsz[1].trim() : csz;
  const state = mCsz ? mCsz[2] : '';
  const postal = mCsz ? mCsz[3] : '';
  p(`    <CONTACT type="Client" id="CNT${++nCnt}" name="${xmlEsc(m.insured || '')}">`);
  p('      <ADDRESSES>');
  p(`        <ADDRESS type="Property" street="${xmlEsc(street.trim())}" city="${xmlEsc(city)}" state="${xmlEsc(state)}" postal="${xmlEsc(postal)}" country="US" primary="1"/>`);
  p('      </ADDRESSES>');
  p('      <CONTACTMETHODS>');
  if (m.insuredPhone) p(`        <PHONE type="Home" number="${xmlEsc(m.insuredPhone)}" primary="1"/>`);
  if (m.insuredEmail) p(`        <EMAIL address="${xmlEsc(m.insuredEmail)}"/>`);
  p('      </CONTACTMETHODS>');
  p('    </CONTACT>');
  if (m.adjuster) p(`    <CONTACT type="ClaimRep" id="CNT${++nCnt}" name="${xmlEsc(m.adjuster)}"><ADDRESSES/><CONTACTMETHODS/></CONTACT>`);
  if (m.estimator) p(`    <CONTACT type="Estimator" id="CNT${++nCnt}" name="${xmlEsc(m.estimator)}"><ADDRESSES/><CONTACTMETHODS/></CONTACT>`);
  if (m.carrier) p(`    <COMPANY type="Reference" id="CNT${++nCnt}"><ADDRESSES/><CONTACTMETHODS/></COMPANY>`);
  p('  </CONTACTS>');
  p('  <CLAIM_INFO><ADMIN_INFO><AGENCY/><INSURANCE_CLIENT/></ADMIN_INFO><SERVICE_HISTORY><RESERVE/></SERVICE_HISTORY><LOSS_INFO/></CLAIM_INFO>');

  // ---- EMBEDDED_PL: the line-item DEFINITIONS ------------------------------
  p('  <EMBEDDED_PL>');
  p('    <SUMITEMS>');
  for (const s of sums) {
    p(`      <SUMITEM id="${s.id}" cat="${xmlEsc(s.cat)}" sel="${xmlEsc(s.sel)}" act="${xmlEsc(s.act)}" desc="${xmlEsc(s.desc)}" unit="${xmlEsc(s.unit)}">`);
    p('        <XPERT_VARS/><SUM_ACTIVITIES/>');   // no prices: Xactimate applies its own price list
    p('      </SUMITEM>');
  }
  p('    </SUMITEMS>');
  p('    <COMPONENTS/><CATEGORIES/><SUPP_EVENTS/>');
  p('  </EMBEDDED_PL>');

  // ---- GROUP: the estimate, room by room -----------------------------------
  // Emits the ITEMS for one group: each line item as an ITEM/SUMMARY_REF, and
  // its F9 justification immediately after as a sibling ITEM type="N".
  const roomItemIds = [];
  const emitItems = (items, indent, collectIds) => {
    p(`${indent}<ITEMS>`);
    for (const it of items) {
      const s = sumFor(it);
      const itmId = 'ITM' + (++nItm);
      if (collectIds) collectIds.push(numOf(itmId));
      p(`${indent}  <ITEM id="${itmId}" type="S">`);
      p(`${indent}    <SUMMARY_REF sumRef="${s.id}" qty="${it.quantity}" depType="P" recoverable="1"><XPERT_VARS/><RESTORED_MATERIALS/></SUMMARY_REF>`);
      p(`${indent}  </ITEM>`);
      if (it.note) {
        p(`${indent}  <ITEM id="ITM${++nItm}" type="N" attached="1">`);
        p(`${indent}    <ITEM_NOTE addedByWaste="0"><NOTE>${cdata(it.note)}</NOTE></ITEM_NOTE>`);
        p(`${indent}  </ITEM>`);
      }
    }
    p(`${indent}</ITEMS>`);
  };

  const rootGrp = 'GRP' + (++nGrp);
  p(`  <GROUP id="${rootGrp}" source="List">`);
  p('    <ITEMS/>');

  const levelGroups = [];   // { grpId, rooms: [{ grpId, room, itemIds }] }
  model.levels.forEach((lvl) => {
    const lvlGrp = 'GRP' + (++nGrp);
    const lvlRec = { grpId: lvlGrp, name: lvl.name, rooms: [] };
    levelGroups.push(lvlRec);
    p(`    <GROUP id="${lvlGrp}" code="${xmlEsc(lvl.name)}" type="Non_Room" source="Sketch">`);
    p('      <DIM><DIM_VARS_SUM/></DIM>');
    for (const room of lvl.rooms) {
      const rGrp = 'GRP' + (++nGrp);
      const ids = [];
      lvlRec.rooms.push({ grpId: rGrp, room, itemIds: ids });
      // A context-only space (a hallway drawn for flow) is a real room in the
      // building and a real SKETCHROOM, but it carries no line items. A real XACTDOC
      // models exactly this: every room is a SKETCHROOM, some GROUPs hold an empty
      // <ITEMS/>. type is left off rather than invented: the reference uses real room
      // types (Living, etc) from a Verisk list we do not have.
      p(`      <GROUP id="${rGrp}" code="${xmlEsc(room.name)}" desc="${xmlEsc(room.name)}" source="Sketch">`);
      emitItems(byRoom.get(room.name) || [], '        ', ids);
      // The dimension variables a line item's calc formula references. Xactimate
      // RECOMPUTES quantities from these, so they are not decoration: a wrong ceiling
      // height here corrupts every calc="W" line at once.
      const d = room.dims;
      p(d
        ? `        <DIM><DIM_VARS_SUM C="${d.C}" F="${d.F}" SY="${d.SY}" PC="${d.PC}" PF="${d.PF}" W="${d.W}" WC="${d.WC}"/></DIM>`
        : `        <DIM><DIM_VARS_SUM F="${room.area}" PF="${room.perimeter}"/></DIM>`);
      p('      </GROUP>');
    }
    // Claim-level lines (equipment unit-days, contents) hang off the level, not a room.
    emitItems(lvl === model.levels[0] ? claimLevel : [], '      ');
    p('    </GROUP>');
  });
  if (!model.levels.length && claimLevel.length) {
    const lvlGrp = 'GRP' + (++nGrp);
    p(`    <GROUP id="${lvlGrp}" code="General" type="Non_Room" source="List">`);
    emitItems(claimLevel, '      ');
    p('    </GROUP>');
  }
  p('  </GROUP>');

  p('  <AUDIT_DOC><ESTIMATE/></AUDIT_DOC><CHKLIST/><AUDIT_ENTRIES/><IMAGES/>');
  p('  <PAYMENT_TRACKER><PT_WORKSHEET/></PAYMENT_TRACKER>');
  p('  <UI_LAYOUT/>');
  p('  <PROJECT_SETTING><SKTOPTS/><LINDETAILOPTS/></PROJECT_SETTING>');
  p('  <SESSION_STATS/><CUSTOM_ITEMS/><XPERTS/>');

  // ---- SKETCHDOCUMENT ------------------------------------------------------
  // One flat COORDINATE3 list of "x y z" integers at 1524 units/ft. For an
  // n-corner room we emit n bottom coords then n top coords, so wall i is the
  // quad [bot_i, bot_i+1, top_i+1, top_i], matching the reference's ordering.
  const coords = [];
  const pushCoord = (xU, yU, zU) => { coords.push(`${xU} ${yU} ${zU}`); return coords.length - 1; };

  const sketchDocId = 'SKT' + (++nSkt);
  p(`  <SKETCHDOCUMENT id="${sketchDocId}" majorVersion="1" minorVersion="19" compassRotation="0.0">`);
  const structId = 'SKT' + (++nSkt);
  p(`    <SKETCHSTRUCTURE structureType="0" id="${structId}" name="Proposed" key="${rootGrp}" grpType="1" parentKey="${rootGrp}" grpDesc="Proposed">`);

  // Room vertices are already in real structure coordinates (placed from the floor
  // plan in mapClaimToProject), so there is no layout to invent here any more.
  levelGroups.forEach((lvlRec, li) => {
    const lvlId = 'SKT' + (++nSkt);
    // key/parentKey/grpType are what BIND the geometry to the estimate: a SKETCHLEVEL
    // whose key is a GROUP id, holding SKETCHROOMs whose keys are the room GROUP ids.
    // Without them Xactimate has geometry and line items but no idea which belongs to
    // which. This was the single worst omission in the previous serializer.
    p(`      <SKETCHLEVEL id="${lvlId}" name="${xmlEsc(lvlRec.name)}" key="${lvlRec.grpId}" grpType="11" parentKey="${rootGrp}" grpDesc="" levelNumber="${li + 1}" floorElevation="${ftToU(100)}">`);

    const wallRecs = [];
    const vertRecs = [];
    const roomRecs = [];

    for (const { room, itemIds, grpId } of lvlRec.rooms) {
      const verts = room.vertices || [];
      if (verts.length < 3) continue;
      const n = verts.length;
      const hU = ftToU(room.wallHeight || 8);
      const z0 = ftToU(100), z1 = z0 + hU;

      const base = coords.length;
      for (const v of verts) pushCoord(ftToU(v[0]), ftToU(v[1]), z0);   // bottoms
      for (const v of verts) pushCoord(ftToU(v[0]), ftToU(v[1]), z1);   // tops

      const wallIds = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const wid = 'SKT' + (++nSkt);
        wallIds.push(numOf(wid));
        wallRecs.push({
          id: wid,
          name: String.fromCharCode(65 + (i % 26)),
          coordIndex: [base + i, base + j, base + n + j, base + n + i].join(' '),
          height: hU
        });
      }
      const roomId = 'SKT' + (++nSkt);
      // a vertex record per corner, naming the two walls that meet there
      for (let i = 0; i < n; i++) {
        const vid = 'SKT' + (++nSkt);
        const prev = wallIds[(i - 1 + n) % n], cur = wallIds[i];
        vertRecs.push({ id: vid, vertex: base + i, wallIDs: `${cur} ${prev}` });
      }
      roomRecs.push({
        id: roomId, room, grpId, wallIDs: wallIds.join(' '),
        itemIds: itemIds.join(' '),
        lastDims: `C=${room.area};F=${room.area};PC=${room.perimeter};PF=${room.perimeter};`
      });
      // fix wall roomIDs now that the room has an id
      for (let i = wallRecs.length - n; i < wallRecs.length; i++) wallRecs[i].roomIDs = `${numOf(roomId)} 0`;
    }

    for (const w of wallRecs) {
      p(`        <SKETCHWALL id="${w.id}" name="${w.name}" roomIDs="${w.roomIDs}" coordIndex="${w.coordIndex}" thickness="${ftToU(1 / 3)}" wallHeight="${w.height}">`);
      p('          <SKETCHWALLSURFACE side="0"/><SKETCHWALLSURFACE side="1"/>');
      p('        </SKETCHWALL>');
    }
    for (const v of vertRecs) p(`        <SKETCHLEVELVERTEX id="${v.id}" vertex="${v.vertex}" wallIDs="${v.wallIDs}"/>`);
    for (const r of roomRecs) {
      // ceilingHeight is the room's MEASURED height (room override, else structure
      // default). lastDims carries the full variable set the reference file uses.
      p(`        <SKETCHROOM id="${r.id}" lineItems="${r.itemIds}" key="${r.grpId}" grpType="1" parentKey="${lvlRec.grpId}" grpDesc="${xmlEsc(r.room.name)}" wallIDs="${r.wallIDs}" ceilingHeight="${r.room.wallHeight}" lastDims="${xmlEsc(r.room.lastDims || r.lastDims)}">`);
      p(`          <SKETCHLABEL><SKETCHCDATACHILD>${cdata(r.room.name)}</SKETCHCDATACHILD></SKETCHLABEL>`);
      p('        </SKETCHROOM>');
    }
    p('      </SKETCHLEVEL>');
  });

  p('    </SKETCHSTRUCTURE>');
  p('    <SKETCHDOCUMENTPREFS displayGridSize="1524" gridSize="127" wallThickness="508"/>');
  p('    <SKETCHVIEW name="Default Print View" type="0" zoom="1.0" scale="96.0"/>');
  p(`    <COORDINATE3>${coords.join(' ')}</COORDINATE3>`);
  p('  </SKETCHDOCUMENT>');

  // ---- photos --------------------------------------------------------------
  p('  <EXT_FILES>');
  (model._photoPaths || []).slice(0, 130).forEach((_path, i) => {
    p(`    <EXT_FILE id="EXT${++nExt}" fileName="${i + 1}.JPG" fileType="image/jpeg"/>`);
  });
  p('  </EXT_FILES>');

  p('</XACTDOC>');
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

  // The structure floor plan is where the rooms actually SIT. Fetched here rather
  // than in fetchClaimGraph so the carrier report (which does not need it) is left
  // untouched.
  const structureIds = (graph.structures || []).map((s) => s.id);
  if (structureIds.length) {
    const { supabase } = require('./supabase');
    const { data: floorplans } = await supabase
      .from('resto_structure_floorplans').select('*').in('structure_id', structureIds);
    graph.floorplans = floorplans || [];
  }

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