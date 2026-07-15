// ============================================================================
// SHARED PDF LAYOUT KIT
// ----------------------------------------------------------------------------
// Every restoration PDF draws through this file: the carrier report, the drying
// log, the measurement sheet, the signed forms and the client pack. One kit means
// the vertical rhythm, the tables and the page furniture are identical across all
// of them.
//
// This file used to deliberately avoid resto-report.js. That was the wrong call:
// the report was the document that most needed a real grid, and leaving it on its
// own ad hoc spacing is why it looked the way it did. Everything now draws through
// the same primitives, so the vertical rhythm, the tables, and the page furniture
// are identical across the report, the client pack, the forms and the measurements.
//
// THE ONE RULE THAT MATTERS: nothing draws without calling ensure() first, and
// ensure() always resets doc.x to the left margin. Text that bleeds sideways or
// runs into the next row is almost always a stale doc.x left behind by a photo
// grid, a legend or a table cell.
//
// The 13 legacy exports (drawBrandHeader, drawBrandFooter, NAVY, DARK, GRAY,
// fitImage, contrastText, brandingOf, dateOnly, db, orgSettings, downloadImage,
// docToBuffer) are kept intact so the client pack and the signed form PDF, which
// were not moved onto the kit, keep working unchanged.
// ============================================================================
const PDFDocument = require('pdfkit');
const { Writable } = require('stream');
let sharp = null; try { sharp = require('sharp'); } catch (_) { sharp = null; }

const NAVY = '#0E2A4D';
const DARK = '#16243B';
const GRAY = '#6b7280';

// Design tokens. One place, so the documents cannot drift apart.
const T = {
  navy: NAVY,
  ink: DARK,
  muted: GRAY,
  faint: '#9AA5B1',
  line: '#E5EAF0',
  soft: '#F4F7FB',
  ok: '#15803D',
  warn: '#B45309',
  bad: '#B91C1C',
  size: { title: 20, sec: 12, h2: 11, h3: 9.5, body: 9.5, small: 8.5, tiny: 7.5 },
  lead: 1.35
};

const M = 50;    // left / right margin
const TOP = 76;  // first line on a continuation page, clear of the running header
const BOT = 58;  // reserved strip at the foot of every page

function newDoc() {
  return new PDFDocument({
    size: 'LETTER',
    margins: { top: TOP, bottom: BOT, left: M, right: M },
    bufferPages: true
  });
}

// Collect a pdfkit doc into a Buffer. A direct 'data' listener can race pdfkit's
// stream finalization, so pipe into a Writable instead.
function docToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    doc.on('error', reject);
    doc.pipe(sink);
  });
}

async function fitImage(buf, max = 1400, quality = 74) {
  if (!sharp || !buf) return buf;
  try { return await sharp(buf).rotate().resize(max, max, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer(); }
  catch (_) { return buf; }
}

// White on a dark brand color, navy on a light one.
function contrastText(hex) {
  try {
    const h = String(hex).replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.6 ? NAVY : '#ffffff';
  } catch (_e) { return '#ffffff'; }
}

// Branding lives in resto_org_settings.report_branding (jsonb).
function brandingOf(settings) {
  const raw = settings || {};
  const cfg = raw.report_branding || raw;
  const primary = /^#[0-9a-fA-F]{6}$/.test(cfg.primary_color || '') ? cfg.primary_color : NAVY;
  return { cfg, primary, onBrand: contrastText(primary) };
}

// The colored header band with the org logo. A legacy export, and also what
// coverPage() draws its band with, so the two never diverge.
function drawBrandHeader(doc, { primary, onBrand, cfg }, title, subtitle) {
  const W = doc.page.width - 100;
  doc.rect(0, 0, doc.page.width, 90).fill(primary);
  if (cfg.logo_data_url) {
    try {
      const b64 = String(cfg.logo_data_url).split(',').pop();
      if (b64) doc.image(Buffer.from(b64, 'base64'), doc.page.width - 50 - 150, 20, { fit: [150, 50], align: 'right', valign: 'center' });
    } catch (_e) {}
  }
  const titleW = doc.page.width - 250;
  doc.fillColor(onBrand).font('Helvetica-Bold').fontSize(19).text(title, 50, 24, { width: titleW, lineBreak: false });
  const sub = subtitle || [cfg.company_name, cfg.phone].filter(Boolean).join('  \u00b7  ');
  doc.font('Helvetica');
  if (sub) doc.fillColor(onBrand).fontSize(10).text(sub, 50, 52, { width: titleW, lineBreak: false });
  doc.fillColor(onBrand).fontSize(9).text('Prepared ' + new Date().toLocaleString(), 50, sub ? 68 : 58, { width: titleW, lineBreak: false });
  doc.fillColor(DARK).font('Helvetica');
  doc.x = 50; doc.y = 110;
  return W;
}

function drawBrandFooter(doc, cfg, W) {
  const bits = [cfg.company_name, cfg.phone, cfg.email, cfg.website, cfg.license_number ? ('Lic# ' + cfg.license_number) : null].filter(Boolean).join('  \u00b7  ');
  if (bits) { doc.x = 50; doc.moveDown(1).font('Helvetica-Bold').fontSize(8).fillColor(DARK).text(bits, 50, doc.y, { width: W, align: 'center' }).font('Helvetica'); }
  if (cfg.report_footer) doc.moveDown(0.2).fontSize(8).fillColor(GRAY).text(cfg.report_footer, 50, doc.y, { width: W, align: 'center' });
}

const dateOnly = (d) => (d ? new Date(d).toLocaleDateString() : '-');
const money = (n) => (n == null || n === '' ? '-' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));

function db() { return require('./supabase').supabase; }

async function orgSettings(orgId) {
  const { data } = await db().from('resto_org_settings').select('*').eq('org_id', orgId).limit(1);
  return (data && data[0]) || null;
}

async function downloadImage(path) {
  try {
    const { data, error } = await db().storage.from('resto-media').download(path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  } catch (_) { return null; }
}

// ============================================================================
// THE KIT. Bind it to a doc once, then draw only through it.
// ============================================================================
function kit(doc, brand) {
  const W = doc.page.width - M * 2;
  const floor = () => doc.page.height - BOT;

  // The single most important function in this file. Nothing draws without it.
  const ensure = (h) => {
    if (doc.y + h > floor()) { doc.addPage(); doc.y = TOP; }
    doc.x = M;               // ALWAYS. A stale x is what makes text bleed sideways.
    return doc.y;
  };
  const gap = (n = 1) => { doc.y += 6 * n; doc.x = M; };

  const font = (weight, size, color) => {
    doc.font(weight === 'b' ? 'Helvetica-Bold' : weight === 'i' ? 'Helvetica-Oblique' : 'Helvetica')
       .fontSize(size).fillColor(color);
    return doc;
  };

  // --- headings -------------------------------------------------------------
  const toc = [];
  const pageNo = () => doc.bufferedPageRange().count;

  // A full-width brand bar. Top level: one per structure, plus the claim-level sections.
  const section = (title) => {
    ensure(40);
    toc.push({ title, page: pageNo() });
    const y = doc.y;
    doc.save().rect(M, y, W, 26).fill(brand.primary).restore();
    font('b', T.size.sec, brand.onBrand).text(title, M + 8, y + 7.5, { width: W - 16, lineBreak: false });
    doc.x = M; doc.y = y + 26 + 12;
  };

  // A room, or any second-level block. Rule underneath, so rooms visibly separate.
  const h2 = (title, right) => {
    ensure(30);
    const y = doc.y;
    font('b', T.size.h2, T.navy).text(title, M, y, { width: right ? W - 130 : W, lineBreak: false });
    if (right) font('', T.size.small, T.muted).text(right, M, y + 1, { width: W, align: 'right', lineBreak: false });
    doc.y = y + 15;
    doc.save().moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.8).strokeColor(T.line).stroke().restore();
    doc.x = M; doc.y += 8;
  };

  // A labelled block inside a room. Small, uppercase, tracked out: skimmable.
  // KEEP-WITH-NEXT: pass a reserve height so the heading and the block it labels
  // land on the same page. A heading alone at the foot of a page explains nothing.
  const h3 = (title, keep) => {
    ensure(20 + (keep || 0));
    font('b', T.size.tiny, T.muted).text(String(title).toUpperCase(), M, doc.y, { width: W, characterSpacing: 0.6 });
    doc.x = M; doc.y += 3;
  };

  const para = (text, opts = {}) => {
    if (!text) return;
    const size = opts.size || T.size.body;
    const color = opts.color || T.ink;
    const h = doc.font('Helvetica').fontSize(size).heightOfString(String(text), { width: W, lineGap: 1.5 });
    ensure(Math.min(h, 120));
    font(opts.weight || '', size, color).text(String(text), M, doc.y, { width: W, lineGap: 1.5 });
    doc.x = M; doc.y += 3;
  };

  const bullets = (items, opts = {}) => {
    (items || []).filter(Boolean).forEach((t) => {
      const h = doc.font('Helvetica').fontSize(opts.size || T.size.body).heightOfString(String(t), { width: W - 12, lineGap: 1.5 });
      ensure(h + 3);
      const y = doc.y;
      font('', opts.size || T.size.body, T.faint).text('\u2022', M, y, { width: 8, lineBreak: false });
      font('', opts.size || T.size.body, opts.color || T.ink).text(String(t), M + 12, y, { width: W - 12, lineGap: 1.5 });
      doc.x = M; doc.y += 2;
    });
  };

  // A tinted callout. Used for warnings that an adjuster will act on.
  const callout = (text, tone = 'warn') => {
    const bg = tone === 'bad' ? '#FEF2F2' : tone === 'ok' ? '#F0FDF4' : '#FFFBEB';
    const fg = tone === 'bad' ? T.bad : tone === 'ok' ? T.ok : T.warn;
    const inner = W - 20;
    const h = doc.font('Helvetica').fontSize(T.size.small).heightOfString(String(text), { width: inner, lineGap: 1.5 }) + 14;
    ensure(h + 6);
    const y = doc.y;
    doc.save().roundedRect(M, y, W, h, 5).fill(bg).restore();
    font('', T.size.small, fg).text(String(text), M + 10, y + 7, { width: inner, lineGap: 1.5 });
    doc.x = M; doc.y = y + h + 6;
  };

  // --- facts grid -----------------------------------------------------------
  // Label above value, in columns. Far more scannable than a run of "Label: value"
  // lines, which is what the report used to be and why nothing could be found in it.
  const facts = (pairs, cols = 2) => {
    const list = (pairs || []).filter((p) => p && p[0]);
    if (!list.length) return;
    const colW = W / cols;
    const rows = Math.ceil(list.length / cols);
    const rowH = 30;
    ensure(rows * rowH + 4);
    const y0 = doc.y;
    list.forEach((p, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const x = M + c * colW, y = y0 + r * rowH;
      font('b', T.size.tiny, T.faint).text(String(p[0]).toUpperCase(), x, y, { width: colW - 10, characterSpacing: 0.5, lineBreak: false });
      font('', T.size.body, T.ink).text(p[1] == null || p[1] === '' ? '-' : String(p[1]), x, y + 11, { width: colW - 10, height: 13, ellipsis: true, lineBreak: false });
    });
    doc.x = M; doc.y = y0 + rows * rowH + 4;
  };

  // --- table ----------------------------------------------------------------
  // cols: [{ t, w (fraction of W), align }]. The header REDRAWS after a page break,
  // because a table whose header is on the previous page is unreadable to the person
  // who has to check it.
  const table = (cols, rows, opts = {}) => {
    const pad = 5;
    const drawHead = () => {
      const y = doc.y;
      doc.save().rect(M, y, W, 17).fill(T.soft).restore();
      let cx = M;
      cols.forEach((c) => {
        font('b', T.size.tiny, T.muted).text(String(c.t).toUpperCase(), cx + pad, y + 5.5,
          { width: W * c.w - pad * 2, align: c.align || 'left', lineBreak: false, characterSpacing: 0.4 });
        cx += W * c.w;
      });
      doc.x = M; doc.y = y + 17;
    };

    ensure(17 + 18);
    drawHead();

    (rows || []).forEach((r, i) => {
      const heights = cols.map((c, j) =>
        doc.font('Helvetica').fontSize(T.size.small).heightOfString(String(r[j] == null ? '' : r[j]), { width: W * c.w - pad * 2 }));
      const h = Math.max(16, Math.max.apply(null, heights) + 8);
      if (doc.y + h > floor()) { doc.addPage(); doc.y = TOP; doc.x = M; drawHead(); }
      const y = doc.y;
      if (i % 2 === 1) doc.save().rect(M, y, W, h).fill('#FBFCFD').restore();
      let cx = M;
      cols.forEach((c, j) => {
        font('', T.size.small, T.ink).text(String(r[j] == null ? '' : r[j]), cx + pad, y + 4,
          { width: W * c.w - pad * 2, align: c.align || 'left' });
        cx += W * c.w;
      });
      doc.save().moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.5).strokeColor(T.line).stroke().restore();
      doc.x = M; doc.y = y + h;
    });

    if (opts.total) {
      const y = ensure(20);
      doc.save().rect(M, y, W, 20).fill(T.soft).restore();
      let cx = M;
      cols.forEach((c, j) => {
        font('b', T.size.small, T.navy).text(String(opts.total[j] == null ? '' : opts.total[j]), cx + pad, y + 5,
          { width: W * c.w - pad * 2, align: c.align || 'left', lineBreak: false });
        cx += W * c.w;
      });
      doc.x = M; doc.y = y + 20;
    }
  };

  // --- photo grid -----------------------------------------------------------
  // perRow square thumbnails with MEASURED captions. Captions used to be allotted a
  // flat 30pt, which is why a two-line stamp collided with the row below. Each cell
  // can hand its coordinates back through onCell (used to hyperlink the thumbnail to
  // the full-resolution original).
  const photoGrid = async (photos, getImage, opts = {}) => {
    const perRow = opts.perRow || 3;
    const gp = 10;
    const cell = (W - gp * (perRow - 1)) / perRow;
    const capOf = (p) => {
      const s = opts.stamp ? (opts.stamp(p) || '') : '';
      if (!s) return { s: '', h: 0 };
      const h = doc.font('Helvetica').fontSize(T.size.tiny).heightOfString(s, { width: cell });
      return { s, h: h + 3 };
    };
    let col = 0, rowY = 0, rowCap = 0;
    for (const p of (photos || [])) {
      const cap = capOf(p);
      if (col === 0) { rowCap = 0; rowY = ensure(cell + 24); }
      rowCap = Math.max(rowCap, cap.h);
      const x = M + col * (cell + gp);
      let buf = null;
      try { buf = await fitImage(await getImage(p.storage_path)); } catch (_e) { buf = null; }
      if (buf) {
        try { doc.image(buf, x, rowY, { width: cell, height: cell, fit: [cell, cell], align: 'center', valign: 'center' }); } catch (_e) {}
      } else {
        doc.save().rect(x, rowY, cell, cell).fill('#EEF2F6').restore();
        font('', T.size.tiny, T.faint).text('Photo unavailable', x, rowY + cell / 2 - 4, { width: cell, align: 'center' });
      }
      if (cap.s) font('', T.size.tiny, T.faint).text(cap.s, x, rowY + cell + 3, { width: cell });
      if (opts.onCell) { try { await opts.onCell(p, x, rowY, cell); } catch (_e) {} }
      col++;
      if (col === perRow) { doc.x = M; doc.y = rowY + cell + rowCap + 8; col = 0; }
    }
    if (col !== 0) { doc.x = M; doc.y = rowY + cell + rowCap + 8; }
  };

  const furniture = ({ company, address, coverPages = 1, footNote }) => {
    try {
      const r = doc.bufferedPageRange();
      for (let i = r.start; i < r.start + r.count; i++) {
        if (i - r.start < coverPages) continue;
        doc.switchToPage(i);
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;   // pdfkit appends a blank page if a draw crosses the bottom margin
        doc.save();
        font('', T.size.tiny, T.faint);
        if (company) doc.text(company, M, 30, { width: W, lineBreak: false });
        if (address) doc.text(address, M, 30, { width: W, align: 'right', lineBreak: false });
        doc.moveTo(M, 44).lineTo(doc.page.width - M, 44).lineWidth(0.5).strokeColor(T.line).stroke();

        const fy = doc.page.height - 34;
        doc.moveTo(M, fy - 8).lineTo(doc.page.width - M, fy - 8).lineWidth(0.5).strokeColor(T.line).stroke();
        font('', T.size.tiny, T.faint);
        if (footNote) doc.text(footNote, M, fy, { width: W * 0.7, lineBreak: false });
        doc.text('Page ' + (i - r.start + 1) + ' of ' + r.count, M, fy, { width: W, align: 'right', lineBreak: false });
        doc.restore();
        doc.page.margins.bottom = savedBottom;
      }
    } catch (_e) { /* furniture is best-effort, never fail a document over it */ }
  };

  // Render the contents list onto a page reserved earlier.
  const contentsPage = (index) => {
    if (!toc.length) return;
    try {
      const r = doc.bufferedPageRange();
      doc.switchToPage(r.start + index);
      doc.x = M; doc.y = TOP;
      font('b', 16, T.navy).text('Contents', M, doc.y, { width: W });
      doc.y += 4;
      doc.save().moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(1).strokeColor(brand.primary).stroke().restore();
      doc.y += 12;
      toc.forEach((e) => {
        const y = doc.y;
        font('', T.size.body, T.ink).text(e.title, M, y, { width: W - 40, lineBreak: false });
        font('', T.size.body, T.muted).text(String(e.page), M, y, { width: W, align: 'right', lineBreak: false });
        doc.save().moveTo(M, y + 14).lineTo(M + W, y + 14).lineWidth(0.4).strokeColor(T.line).stroke().restore();
        doc.y = y + 22;
      });
    } catch (_e) { /* best effort */ }
  };

  return { W, M, T, doc, ensure, gap, font, section, h2, h3, para, bullets, callout, facts, table, photoGrid, furniture, contentsPage, toc, floor };
}

// A real cover page: brand band, document title, who it is about, and the facts an
// adjuster opens the file to find. Returns the kit so the caller keeps drawing.
function coverPage(doc, brand, info = {}) {
  const k = kit(doc, brand);
  const W = drawBrandHeader(doc, brand, info.title || '', null);
  const y = doc.y;
  k.font('b', 16, T.navy).text(info.heading || '', M, y, { width: W });
  if (info.sub) k.font('', T.size.body, T.muted).text(info.sub, M, doc.y + 1, { width: W });
  doc.y += 6;
  doc.save().moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(1).strokeColor(brand.primary).stroke().restore();
  doc.x = M; doc.y += 12;
  if (info.factPairs) k.facts(info.factPairs, 2);
  k.gap(1);
  return k;
}

// The company footer line, drawn through the kit so it obeys the same margins and
// page breaks as everything else. Called near the end of a document, before the
// running furniture is stamped on.
function brandFooterBlock(k, cfg) {
  cfg = cfg || {};
  const bits = [cfg.company_name, cfg.phone, cfg.email, cfg.website, cfg.license_number ? ('Lic# ' + cfg.license_number) : null].filter(Boolean).join('  \u00b7  ');
  if (!bits && !cfg.report_footer) return;
  const doc = k.doc;
  k.gap(1);
  if (bits) {
    const y = k.ensure(16);
    k.font('b', T.size.tiny, T.ink).text(bits, M, y, { width: k.W, align: 'center', lineBreak: false });
    doc.x = M; doc.y += 12;
  }
  if (cfg.report_footer) {
    const y = k.ensure(14);
    k.font('', T.size.tiny, T.muted).text(cfg.report_footer, M, y, { width: k.W, align: 'center' });
    doc.x = M; doc.y += 12;
  }
}

module.exports = {
  NAVY, DARK, GRAY, T, M, TOP, BOT,
  newDoc, docToBuffer, fitImage, contrastText, brandingOf,
  kit, coverPage, brandFooterBlock,
  drawBrandHeader, drawBrandFooter,
  dateOnly, money, db, orgSettings, downloadImage
};