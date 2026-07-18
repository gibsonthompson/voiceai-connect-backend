// ============================================================================
// XACTIMATE ENTRY SHEET
// ----------------------------------------------------------------------------
// A per-room, human-keyable list of line items in Xactimate's own vocabulary
// (CAT, SEL, quantity, unit) with the F9 justification note beneath each line.
// A tech keys these straight into a blank Xactimate estimate in minutes, with no
// re-deriving of scope.
//
// This file is ONLY a renderer. The line items come from mapClaimToProject(graph),
// the same model that feeds the esx, so the entry sheet and the (future) native
// import always agree. No quantity logic lives here.
//
// NO PRICES. Xactimate reprices every line from its own price list, so a price
// here is at best ignored and at worst an argument. We send WHAT and HOW MUCH
// only (cat, sel, quantity, unit), the same rule as the esx.
// ============================================================================

const {
  newDoc, docToBuffer, brandingOf, coverPage, brandFooterBlock, T, M
} = require('./resto-pdf-common');

const CLAIM_BUCKET = '\u0000claim';
const CLAIM_LABEL = 'Equipment & claim-level items';

// Up to two decimals, trailing zeros trimmed. Xactimate areas carry decimals,
// counts do not, so 3.00 should read as 3 and 12.50 as 12.5.
function fmtQty(n) {
  if (n == null || n === '') return '';
  const num = Number(n);
  if (!isFinite(num)) return String(n);
  return String(Math.round(num * 100) / 100);
}

// CAT then SEL, the format confirmed against the real 1474 estimate.
function codeOf(item) {
  const cat = (item.cat == null ? '' : String(item.cat)).trim();
  const sel = (item.sel == null ? '' : String(item.sel)).trim();
  return [cat, sel].filter(Boolean).join(' ');
}

// Bucket line items by room, in first-appearance order, with claim-level lines
// (equipment unit-days, contents) collected into one bucket at the end.
function groupByRoom(lineItems) {
  const order = [];
  const buckets = new Map();
  for (const it of (lineItems || [])) {
    const key = it && it.room ? String(it.room) : CLAIM_BUCKET;
    if (!buckets.has(key)) { buckets.set(key, []); if (key !== CLAIM_BUCKET) order.push(key); }
    buckets.get(key).push(it);
  }
  const groups = order.map((name) => ({ name, items: buckets.get(name) }));
  if (buckets.has(CLAIM_BUCKET)) groups.push({ name: CLAIM_LABEL, items: buckets.get(CLAIM_BUCKET) });
  return groups;
}

function renderLine(k, it, L) {
  const doc = k.doc;
  const cd = codeOf(it);
  const desc = (it.desc == null ? '' : String(it.desc));
  const qtyUnit = [fmtQty(it.quantity), (it.unit == null ? '' : String(it.unit)).trim()].filter(Boolean).join(' ');
  const note = (it.note == null ? '' : String(it.note)).trim();

  doc.font('Helvetica').fontSize(T.size.body);
  const descH = doc.heightOfString(desc || ' ', { width: L.descW, lineGap: 1.5 });
  const codeH = doc.heightOfString(cd || ' ', { width: L.codeW });
  const topH = Math.max(descH, codeH);

  let noteH = 0;
  if (note) {
    doc.font('Helvetica-Oblique').fontSize(T.size.small);
    noteH = doc.heightOfString('F9: ' + note, { width: L.descW, lineGap: 1.2 }) + 2;
  }
  const rowH = topH + noteH + 8;
  const y = k.ensure(rowH);

  k.font('b', T.size.body, T.navy).text(cd, M, y, { width: L.codeW });
  k.font('', T.size.body, T.ink).text(desc, L.descX, y, { width: L.descW, lineGap: 1.5 });
  k.font('', T.size.body, T.ink).text(qtyUnit, L.tailX, y, { width: L.tailW, align: 'right', lineBreak: false });

  if (note) {
    k.font('i', T.size.small, T.muted).text('F9: ' + note, L.descX, y + topH + 2, { width: L.descW, lineGap: 1.2 });
  }

  doc.x = M; doc.y = y + rowH;
  doc.save().moveTo(M, doc.y - 3).lineTo(M + k.W, doc.y - 3).lineWidth(0.4).strokeColor(T.line).stroke().restore();
}

function renderGroup(k, group) {
  const doc = k.doc;
  const W = k.W;
  const count = group.items.length;
  k.h2(group.name, count + (count === 1 ? ' line' : ' lines'));

  const codeW = 82, tailW = 88, g = 8;
  const descW = W - codeW - tailW - g * 2;
  const L = { codeW, tailW, g, descW, descX: M + codeW + g, tailX: M + W - tailW };

  // Column header. Keep it with at least the first line so it never orphans.
  const hy = k.ensure(16 + 40);
  k.font('b', T.size.tiny, T.muted).text('CODE', M, hy, { width: codeW, characterSpacing: 0.4, lineBreak: false });
  k.font('b', T.size.tiny, T.muted).text('DESCRIPTION', L.descX, hy, { width: descW, characterSpacing: 0.4, lineBreak: false });
  k.font('b', T.size.tiny, T.muted).text('QTY / UNIT', L.tailX, hy, { width: tailW, align: 'right', characterSpacing: 0.4, lineBreak: false });
  doc.x = M; doc.y = hy + 13;
  doc.save().moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.8).strokeColor(T.line).stroke().restore();
  doc.y += 5;

  for (const it of group.items) renderLine(k, it, L);
  k.gap(1);
}

// Pure renderer. Takes an already-computed project (with .lineItems), the org
// settings row (for branding) and a display name. Returns a PDF Buffer. No I/O,
// so it is unit-testable without a database.
async function buildEntrySheetPdf({ project, settings, claimName }) {
  const brand = brandingOf(settings);
  const cfg = brand.cfg || {};
  const doc = newDoc();
  const bufferPromise = docToBuffer(doc);

  const lineItems = (project && project.lineItems) || [];
  const groups = groupByRoom(lineItems);
  const roomCount = groups.filter((gr) => gr.name !== CLAIM_LABEL).length;

  const k = coverPage(doc, brand, {
    title: 'Xactimate Entry Sheet',
    heading: claimName || 'Restoration Claim',
    sub: 'Line items for manual entry into Xactimate',
    factPairs: [
      ['Policyholder', claimName || '-'],
      ['Rooms', String(roomCount)],
      ['Line items', String(lineItems.length)],
      ['Prepared', new Date().toLocaleDateString()]
    ]
  });

  k.callout('Key each line into Xactimate exactly as listed: category (CAT), selector (SEL), quantity and unit. Prices are omitted on purpose, Xactimate applies its own price list. The F9 line under an item is the justification note for that item.', 'ok');
  k.gap(1);

  if (!lineItems.length) {
    k.para('No line items have been generated for this claim yet. Build the scope first, then regenerate this sheet.', { color: T.muted });
  }

  for (const group of groups) renderGroup(k, group);

  brandFooterBlock(k, cfg);
  k.furniture({
    company: cfg.company_name || '',
    address: '',
    coverPages: 1,
    footNote: 'Xactimate entry sheet. No pricing, Xactimate reprices from its own list.'
  });

  doc.end();
  return await bufferPromise;
}

// Public entry point used by the route. Fetches the claim graph, maps it to the
// project model (same one the esx uses), then renders. Builders are required
// lazily so this module stays loadable (and testable) without the whole backend.
async function buildEntrySheet(claimId) {
  const { fetchClaimGraph } = require('./resto-report');
  const { mapClaimToProject } = require('./resto-esx');

  const graph = await fetchClaimGraph(claimId);
  const project = mapClaimToProject(graph);
  const claimName = (graph && graph.claim && graph.claim.policyholder_name) || 'Claim';
  const settings = (graph && graph.settings) || null;

  const pdf = await buildEntrySheetPdf({ project, settings, claimName });
  return { pdf };
}

module.exports = { buildEntrySheet, buildEntrySheetPdf };