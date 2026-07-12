// ============================================================================
// SIGNED FORM PDF (one signature -> one downloadable, sendable document)
// ----------------------------------------------------------------------------
// LEGAL INTEGRITY, and this is the whole reason the module exists:
// we render resto_claim_signatures.doc_snapshot, which is the terms EXACTLY as
// they stood when the person signed. We never re-render from the live form
// template. If a template is edited later and we regenerated from it, we would be
// producing a document that claims someone agreed to terms they never saw. That
// is the difference between a record and a forgery, so the snapshot is the only
// source of truth here.
// ============================================================================
const PDFDocument = require('pdfkit');
const {
  NAVY, DARK, GRAY, docToBuffer, brandingOf, drawBrandHeader, drawBrandFooter,
  dateOnly, db, orgSettings
} = require('./resto-pdf-common');

const TITLES = {
  work_authorization: 'Work Authorization & Direction to Pay',
  completion_certificate: 'Certificate of Completion & Satisfaction',
  chamber_signoff: 'Drying Chamber Sign-Off',
  certificate_of_satisfaction: 'Certificate of Satisfaction'
};
const titleFor = (t) => TITLES[t] || String(t || 'Signed Form').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function generateFormPdf({ claim, signature, settings }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  const bufP = docToBuffer(doc);
  const brand = brandingOf(settings);
  const title = titleFor(signature.doc_type);
  const W = drawBrandHeader(doc, brand, title);

  const kv = (k, v) => {
    doc.x = 50;
    doc.fontSize(9).fillColor(GRAY).text(k + ': ', { continued: true }).fillColor(DARK).text(String(v ?? '-'));
  };
  const ensure = (h) => { if (doc.y + h > doc.page.height - 90) { doc.addPage(); doc.x = 50; } };

  // ---- who and what this document is about ----
  doc.x = 50;
  doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold').text('PROPERTY & CLAIM');
  doc.moveTo(50, doc.y + 2).lineTo(50 + W, doc.y + 2).lineWidth(1).strokeColor(brand.primary).stroke();
  doc.moveDown(0.5).font('Helvetica');
  kv('Policyholder', claim.policyholder_name);
  kv('Property address', claim.address);
  kv('Claim / job number', claim.carrier_identifier);
  kv('Insurance company', claim.insurance_company);
  kv('Date of loss', dateOnly(claim.date_of_loss));

  // ---- the terms, VERBATIM from the snapshot ----
  const snap = signature.doc_snapshot || {};
  doc.moveDown(0.9); doc.x = 50;
  doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold').text('TERMS AGREED');
  doc.moveTo(50, doc.y + 2).lineTo(50 + W, doc.y + 2).lineWidth(1).strokeColor(brand.primary).stroke();
  doc.moveDown(0.5).font('Helvetica');

  if (snap.intro) { ensure(40); doc.x = 50; doc.fontSize(9.5).fillColor(DARK).text(String(snap.intro), 50, doc.y, { width: W, align: 'left' }); doc.moveDown(0.4); }
  const items = Array.isArray(snap.items) ? snap.items : [];
  items.forEach((it, i) => {
    ensure(26); doc.x = 50;
    doc.fontSize(9).fillColor(DARK).text(`${i + 1}.  ${String(it)}`, 50, doc.y, { width: W, align: 'left' });
    doc.moveDown(0.25);
  });
  if (!snap.intro && !items.length) {
    doc.fontSize(9).fillColor(GRAY).text('No terms were captured with this signature.', 50, doc.y, { width: W });
  }

  // ---- the signature itself ----
  doc.moveDown(1); ensure(150); doc.x = 50;
  doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold').text('SIGNATURE');
  doc.moveTo(50, doc.y + 2).lineTo(50 + W, doc.y + 2).lineWidth(1).strokeColor(brand.primary).stroke();
  doc.moveDown(0.6).font('Helvetica');

  const sigY = doc.y;
  let drewSig = false;
  if (signature.signature_data && String(signature.signature_data).indexOf('base64,') >= 0) {
    try {
      const buf = Buffer.from(String(signature.signature_data).split('base64,')[1], 'base64');
      doc.image(buf, 50, sigY, { fit: [230, 70] });
      drewSig = true;
    } catch (_e) { /* an unreadable signature must not kill the document */ }
  }
  const lineY = sigY + 76;
  doc.moveTo(50, lineY).lineTo(50 + 240, lineY).lineWidth(0.8).strokeColor('#B9C3CF').stroke();
  doc.fontSize(8).fillColor(GRAY).text('Signature', 50, lineY + 4);
  if (!drewSig) doc.fontSize(8.5).fillColor('#B45309').text('Signature image unavailable.', 50, sigY + 30);

  // signer details, beside the signature
  const cx = 330;
  doc.fontSize(9).fillColor(GRAY).text('Signed by', cx, sigY);
  doc.fontSize(12).fillColor(DARK).font('Helvetica-Bold').text(signature.signer_name || '-', cx, sigY + 13).font('Helvetica');
  if (signature.signer_role) doc.fontSize(9).fillColor(GRAY).text(String(signature.signer_role), cx, sigY + 31);
  doc.fontSize(9).fillColor(GRAY).text('Date', cx, sigY + 52);
  doc.fontSize(10).fillColor(DARK).text(
    signature.signed_at ? new Date(signature.signed_at).toLocaleString() : '-', cx, sigY + 64
  );

  doc.y = lineY + 24; doc.x = 50;

  drawBrandFooter(doc, brand.cfg, W);

  doc.moveDown(0.6);
  doc.fontSize(7.5).fillColor(GRAY).text(
    'This document reproduces the terms exactly as presented and accepted at the time of signing.',
    50, doc.y, { width: W, align: 'center' }
  );

  doc.end();
  return bufP;
}

async function buildFormPdf(claimId, signatureId) {
  const supabase = db();
  const { data: signature } = await supabase.from('resto_claim_signatures').select('*').eq('id', signatureId).single();
  if (!signature) throw new Error('signature not found');
  if (signature.claim_id !== claimId) throw new Error('forbidden');   // never render one claim's form under another

  const { data: claim } = await supabase.from('resto_claims').select('*').eq('id', claimId).single();
  if (!claim) throw new Error('claim not found');

  const settings = await orgSettings(claim.org_id);
  const pdf = await generateFormPdf({ claim, signature, settings });
  return { pdf, claim, signature, title: titleFor(signature.doc_type) };
}

module.exports = { buildFormPdf, generateFormPdf, titleFor };