// ============================================================================
// DAILY DRYING LOG / MOISTURE LOG generator (pdfkit)
// Reproduces the field drying-log package from Hydro data:
//   cover page (job + equipment summary + instructions) then one page per
//   chamber (10-day grid: date, tech, dehu, air movers, temp, RH, grains,
//   3 moisture readings, notes) with a supervisor sign-off footer.
// ============================================================================
const PDFDocument = require('pdfkit');
const { Writable } = require('stream');
const { fetchClaimGraph } = require('./resto-report');

const NAVY = '#0E2A4D', DARK = '#16243B', GRAY = '#6b7280', LINE = '#D9E0E8';
const dOnly = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : '');
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function docToBuffer(doc) {
  const chunks = [];
  const w = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
  doc.pipe(w);
  return new Promise((res) => { w.on('finish', () => res(Buffer.concat(chunks))); });
}
function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#ffffff';
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? NAVY : '#ffffff';
}
// is a piece of equipment on site on a given YYYY-MM-DD?
function activeOn(e, ymd) {
  if (!e.placed_at) return false;
  const day = ymd, start = dayKey(e.placed_at), end = e.removed_at ? dayKey(e.removed_at) : '9999-12-31';
  return day >= start && day <= end;
}

function generateDryingLogPdf(graph) {
  const { claim, chambers = [], readings = [], equipment = [], signatures = [] } = graph;
  const rawSettings = graph.settings || {};
  const brandCfg = rawSettings.report_branding || rawSettings;
  const brand = /^#[0-9a-fA-F]{6}$/.test(brandCfg.primary_color || '') ? brandCfg.primary_color : NAVY;
  const onBrand = contrastText(brand);
  const company = brandCfg.company_name || 'Property Restoration';

  const doc = new PDFDocument({ size: 'LETTER', margin: 46 });
  const bufP = docToBuffer(doc);
  const W = doc.page.width - 92;
  const ensure = (h) => { if (doc.y + h > doc.page.height - 46) doc.addPage(); };

  // ---- derive job-level figures ----
  const dehus = equipment.filter((e) => e.type === 'dehumidifier');
  const totalDehus = dehus.reduce((s, e) => s + (e.actual_placed || 1), 0);
  const allDays = readings.map((r) => dayKey(r.captured_at)).filter(Boolean).sort();
  const dateStarted = allDays.length ? allDays[0] : (equipment.map((e) => dayKey(e.placed_at)).filter(Boolean).sort()[0] || '');
  const maxDays = chambers.reduce((mx, ch) => {
    const ds = [...new Set(readings.filter((r) => r.chamber_id === ch.id).map((r) => dayKey(r.captured_at)).filter(Boolean))];
    return Math.max(mx, ds.length);
  }, 0);

  // ============================== COVER PAGE ==============================
  doc.rect(0, 0, doc.page.width, 96).fill(brand);
  doc.fillColor(onBrand).font('Helvetica-Bold').fontSize(19).text(company.toUpperCase(), 46, 30, { width: W });
  const contact = [brandCfg.phone, brandCfg.email].filter(Boolean).join('   |   ');
  if (contact) doc.font('Helvetica').fontSize(9).fillColor(onBrand).text(contact, 46, 58, { width: W });
  doc.y = 118; doc.fillColor(DARK);
  doc.font('Helvetica-Bold').fontSize(15).text('DAILY DRYING LOG / MOISTURE LOG', { align: 'center' });
  doc.moveDown(1);

  const kv = (label, value) => {
    ensure(18); const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text(label, 46, y, { width: W * 0.34 });
    doc.font('Helvetica').fontSize(9.5).fillColor(DARK).text(value == null || value === '' ? '-' : String(value), 46 + W * 0.34, y, { width: W * 0.66 });
    doc.y = y + 16;
  };
  kv('Client:', claim.insurance_company || claim.policyholder_name);
  kv('Property:', claim.address);
  kv('Type of Loss:', [claim.category_of_water ? `Category ${claim.category_of_water}` : null, (claim.type_of_loss || 'water'), 'Damage'].filter(Boolean).join(' '));
  kv('Number of Drying Chambers:', chambers.length);
  kv('Drying Duration per Chamber:', maxDays ? `${maxDays} Days` : '-');
  kv('Total Dehumidifiers on Job:', totalDehus || dehus.length);

  // equipment summary table
  doc.moveDown(0.8); ensure(80);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text('Equipment Summary');
  doc.moveDown(0.3);
  const amTotal = equipment.filter((e) => e.type === 'air_mover').reduce((s, e) => s + (e.actual_placed || 1), 0);
  const asTotal = equipment.filter((e) => e.type === 'air_scrubber').reduce((s, e) => s + (e.actual_placed || 1), 0);
  const eqRows = [
    ['Equipment Type', 'Total Qty', 'Notes'],
    ['Dehumidifiers', totalDehus ? `${totalDehus} units` : '-', 'One per chamber'],
    ['Air Movers', amTotal ? `${amTotal} units` : 'Varies per room', 'See individual chamber logs'],
    ['Air Scrubbers / Negative Air', asTotal ? `${asTotal} units` : 'As needed', 'See individual chamber logs']
  ];
  const eqCols = [0.36, 0.24, 0.40];
  eqRows.forEach((row, ri) => {
    ensure(20); const y = doc.y; let x = 46;
    if (ri === 0) doc.rect(46, y, W, 20).fill(brand);
    row.forEach((cell, ci) => {
      doc.font(ri === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
        .fillColor(ri === 0 ? onBrand : DARK)
        .text(cell, x + 4, y + 6, { width: W * eqCols[ci] - 8, align: ci === 0 ? 'left' : 'center' });
      x += W * eqCols[ci];
    });
    doc.rect(46, y, W, 20).strokeColor(LINE).lineWidth(0.5).stroke();
    let vx = 46; eqCols.slice(0, -1).forEach((c) => { vx += W * c; doc.moveTo(vx, y).lineTo(vx, y + 20).strokeColor(LINE).stroke(); });
    doc.y = y + 20;
  });

  // instructions
  doc.moveDown(1); ensure(120);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text('Instructions for Technicians');
  doc.moveDown(0.3).font('Helvetica').fontSize(9).fillColor(DARK);
  [
    'Each chamber has its own dedicated page (Chambers 1 to N).',
    'Record daily readings for each consecutive drying day per chamber.',
    'Take moisture readings in at least 3 to 4 locations per chamber (walls, floor, etc.).',
    'Record temperature, relative humidity (RH%), and grains per pound daily.',
    'Note any equipment changes, issues, or observations in the Notes column.',
    'Each daily entry is timestamped automatically when captured in the field.',
    'At the end of drying, the supervisor signs off on each chamber page.'
  ].forEach((t, i) => { ensure(13); doc.text(`${i + 1}.  ${t}`, { width: W }); });

  doc.moveDown(1.2); ensure(20);
  const yy = doc.y;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK).text('Job Estimator: ', 46, yy, { continued: true }).font('Helvetica').text(claim.project_manager || claim.adjuster || '-');
  doc.font('Helvetica-Bold').text('Date Started: ', 46 + W * 0.55, yy, { continued: true }).font('Helvetica').text(dateStarted ? dOnly(dateStarted) : '-');

  // ============================== CHAMBER PAGES ==============================
  chambers.forEach((ch, idx) => {
    doc.addPage();
    const cReadings = readings.filter((r) => r.chamber_id === ch.id).sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
    const cEquip = equipment.filter((e) => e.chamber_id === ch.id);

    doc.font('Helvetica-Bold').fontSize(14).fillColor(DARK).text(`Chamber ${idx + 1} - Daily Drying Log`, { align: 'center' });
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY)
      .text(`Job: ${claim.insurance_company || claim.policyholder_name || ''} - ${claim.address || ''}    Chamber: ${ch.name || 'Chamber ' + (idx + 1)}`, { align: 'center' });
    doc.moveDown(0.6);

    // fixed monitoring points = distinct material-MC locations (first 3, in first-seen order)
    const pts = [];
    for (const r of cReadings) {
      if (r.reading_type === 'material_mc' && r.location_label && !pts.includes(r.location_label)) pts.push(r.location_label);
      if (pts.length >= 3) break;
    }
    while (pts.length < 3) pts.push(null);

    // one row per day
    const days = [...new Set(cReadings.map((r) => dayKey(r.captured_at)).filter(Boolean))].sort();
    const rowFor = (day) => {
      const dayReads = cReadings.filter((r) => dayKey(r.captured_at) === day);
      const psy = dayReads.find((r) => r.reading_type === 'psychrometric') || dayReads.find((r) => r.temp_f != null);
      const mr = pts.map((loc) => {
        if (!loc) return '';
        const m = dayReads.find((r) => r.reading_type === 'material_mc' && r.location_label === loc);
        return m && m.material_mc != null ? String(m.material_mc) : '';
      });
      const dehuOn = cEquip.some((e) => e.type === 'dehumidifier' && activeOn(e, day));
      const amCount = cEquip.filter((e) => e.type === 'air_mover' && activeOn(e, day)).reduce((s, e) => s + (e.actual_placed || 1), 0);
      const note = (dayReads.find((r) => r.note) || {}).note || '';
      const tech = (dayReads.find((r) => r.tech_initials) || {}).tech_initials || '';
      return [dOnly(day), tech, dehuOn ? 'Yes' : 'No', amCount ? String(amCount) : '', psy && psy.temp_f != null ? String(psy.temp_f) : '',
              psy && psy.rh_pct != null ? String(psy.rh_pct) : '', psy && psy.gpp != null ? String(psy.gpp) : '', mr[0], mr[1], mr[2], note];
    };

    const headers = ['Date', 'Tech', 'Dehu', 'AM', 'Temp F', 'RH %', 'Grains', 'Read 1', 'Read 2', 'Read 3', 'Notes / Observations'];
    const cols = [0.085, 0.05, 0.055, 0.045, 0.07, 0.06, 0.07, 0.075, 0.075, 0.075, 0.24];
    const drawRow = (cells, head) => {
      ensure(18); const y = doc.y; let x = 46;
      if (head) doc.rect(46, y, W, 18).fill(brand);
      cells.forEach((c, ci) => {
        doc.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(head ? 7.5 : 8.5)
          .fillColor(head ? onBrand : DARK)
          .text(String(c ?? ''), x + 3, y + (head ? 5.5 : 5), { width: W * cols[ci] - 6, align: ci >= 4 && ci <= 9 ? 'center' : (ci === 0 || ci === 10 ? 'left' : 'center'), ellipsis: true });
        x += W * cols[ci];
      });
      doc.rect(46, y, W, 18).strokeColor(LINE).lineWidth(0.5).stroke();
      let vx = 46; cols.slice(0, -1).forEach((c) => { vx += W * c; doc.moveTo(vx, y).lineTo(vx, y + 18).strokeColor(LINE).stroke(); });
      doc.y = y + 18;
    };
    drawRow(headers, true);
    if (!days.length) { doc.font('Helvetica-Oblique').fontSize(9).fillColor(GRAY).text('No readings recorded for this chamber yet.', 46, doc.y + 6); }
    days.forEach((day) => drawRow(rowFor(day)));

    // sign-off footer
    doc.moveDown(1.2);
    const sig = signatures.find((s) => s.doc_type === 'chamber_signoff' && s.doc_snapshot && s.doc_snapshot.chamber_id === ch.id);
    const fy = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text('Supervisor Sign-Off:', 46, fy);
    doc.moveTo(180, fy + 11).lineTo(400, fy + 11).strokeColor(DARK).lineWidth(0.7).stroke();
    if (sig && sig.signature_data && sig.signature_data.indexOf('base64,') >= 0) {
      try { doc.image(Buffer.from(sig.signature_data.split('base64,')[1], 'base64'), 200, fy - 10, { height: 26 }); } catch (_) {}
    }
    doc.font('Helvetica-Bold').text('Date:', 430, fy, { continued: true }).font('Helvetica').text('  ' + (sig ? dOnly(sig.signed_at) : ''));
    doc.moveDown(0.8);
    const gy = doc.y;
    // acceptable checkbox reflects whether all latest points hit their goal is left to the human; show the field
    const acc = sig && sig.doc_snapshot ? sig.doc_snapshot.acceptable : null;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text('Final Moisture Readings Acceptable?', 46, gy, { continued: true })
      .font('Helvetica').text(`   [${acc === true ? 'X' : ' '}] Yes    [${acc === false ? 'X' : ' '}] No`);
    doc.font('Helvetica-Bold').text('Technician Initials:', 430, gy, { continued: true }).font('Helvetica').text('  ' + (sig && sig.signer_name ? sig.signer_name : ''));
  });

  doc.end();
  return bufP;
}

async function buildDryingLog(claimId) {
  const graph = await fetchClaimGraph(claimId);
  if (!graph.claim) throw new Error('claim not found');
  const pdf = await generateDryingLogPdf(graph);
  return { pdf, claim: graph.claim };
}

module.exports = { generateDryingLogPdf, buildDryingLog };