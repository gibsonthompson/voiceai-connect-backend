// ============================================================================
// SHARED PDF HELPERS
// ----------------------------------------------------------------------------
// Used by resto-form-pdf.js and resto-client-pack.js. Deliberately does NOT touch
// resto-report.js, which is long, working, and carrier-facing: a shared refactor
// there buys little and risks the one document that has to survive a scrub.
// ============================================================================
const { Writable } = require('stream');
let sharp = null; try { sharp = require('sharp'); } catch (_) { sharp = null; }

const NAVY = '#0E2A4D';
const DARK = '#16243B';
const GRAY = '#6b7280';

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
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.6 ? '#0E2A4D' : '#ffffff';
  } catch (_e) { return '#ffffff'; }
}

// Branding lives in resto_org_settings.report_branding (jsonb).
function brandingOf(settings) {
  const raw = settings || {};
  const cfg = raw.report_branding || raw;
  const primary = /^#[0-9a-fA-F]{6}$/.test(cfg.primary_color || '') ? cfg.primary_color : NAVY;
  return { cfg, primary, onBrand: contrastText(primary) };
}

// The colored header band with the org logo, shared by both documents.
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

module.exports = {
  NAVY, DARK, GRAY,
  docToBuffer, fitImage, contrastText, brandingOf,
  drawBrandHeader, drawBrandFooter, dateOnly, db, orgSettings, downloadImage
};