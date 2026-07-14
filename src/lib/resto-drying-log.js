// ============================================================================
// DAILY DRYING LOG / MOISTURE LOG
// ----------------------------------------------------------------------------
// The field drying-log package: a cover with the job and its equipment, then one
// page per chamber carrying the day-by-day grid a tech fills on site, and a
// supervisor sign-off.
//
// This is the document an adjuster reaches for when they want to cut equipment days,
// which is the most-scrubbed line on a mitigation invoice. It has to show, day by day,
// that the equipment was there and that the moisture was coming down.
//
// Rebuilt on the shared layout kit (resto-pdf-common) so it matches the carrier report
// and the client pack. Nothing draws without ensure(), and ensure() always resets the
// left margin.
// ============================================================================
const {
  T, M, newDoc, docToBuffer, brandingOf, kit, coverPage, brandFooterBlock
} = require('./resto-pdf-common');
const { fetchClaimGraph } = require('./resto-report');

// ---------------------------------------------------------------------------
// WHICH DAY IS A READING ON?
// ---------------------------------------------------------------------------
// This used to be `new Date(d).toISOString().slice(0, 10)`, which is UTC. captured_at
// is a timestamptz, so a reading taken at 9pm on the 7th in Georgia is 01:00Z on the
// 8th, and it was being filed under the WRONG DRYING DAY. On a document whose entire
// point is which day was what, that is not cosmetic. Equipment activeOn() used the same
// function, so equipment-days moved too.
//
// The honest fix needs the property's timezone, which we do not store. Until we do,
// this buckets by the SERVER's local day and it lives in ONE place so there is exactly
// one line to change.
//
// TODO: add an IANA timezone to the org (or the claim) and pass it here. Until then a
// late-evening reading in a timezone west of the server can still land on the next day.
const dayKey = (d) => {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
};

const dOnly = (ymd) => {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return String(ymd);
  return `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}`;
};

// Is a piece of equipment on site on a given YYYY-MM-DD?
function activeOn(e, ymd) {
  if (!e.placed_at) return false;
  const start = dayKey(e.placed_at);
  const end = e.removed_at ? dayKey(e.removed_at) : '9999-12-31';
  return ymd >= start && ymd <= end;
}

const EQUIP_FULL = { air_mover: 'Air movers', dehumidifier: 'Dehumidifiers', air_scrubber: 'Air scrubbers / negative air', heater: 'Heaters' };

function generateDryingLogPdf(graph) {
  const { claim, chambers = [], readings = [], equipment = [], signatures = [] } = graph;
  const brand = brandingOf(graph.settings);
  const cfg = brand.cfg || {};

  const doc = newDoc();
  const bufP = docToBuffer(doc);

  // ---- job-level figures ----
  const qtyOf = (type) => equipment.filter((e) => e.type === type).reduce((s, e) => s + (e.actual_placed || 1), 0);
  const totalDehus = qtyOf('dehumidifier');
  const allDays = readings.map((r) => dayKey(r.captured_at)).filter(Boolean).sort();
  const dateStarted = allDays.length
    ? allDays[0]
    : (equipment.map((e) => dayKey(e.placed_at)).filter(Boolean).sort()[0] || '');
  const maxDays = chambers.reduce((mx, ch) => {
    const ds = [...new Set(readings.filter((r) => r.chamber_id === ch.id).map((r) => dayKey(r.captured_at)).filter(Boolean))];
    return Math.max(mx, ds.length);
  }, 0);

  const k = coverPage(doc, brand, {
    title: 'Daily Drying Log',
    heading: claim.policyholder_name || 'Claim',
    sub: claim.address || '',
    factPairs: [
      ['Carrier', claim.insurance_company],
      ['Claim / job number', claim.carrier_identifier],
      ['Type of loss', [claim.category_of_water ? 'Category ' + claim.category_of_water : null, claim.type_of_loss || 'water'].filter(Boolean).join(' ')],
      ['Class of loss', claim.class_of_water ? 'Class ' + claim.class_of_water : '-'],
      ['Drying chambers', String(chambers.length)],
      ['Days logged per chamber', maxDays ? String(maxDays) : '-'],
      ['Date started', dateStarted ? dOnly(dateStarted) : '-'],
      ['Project manager', claim.project_manager || claim.adjuster]
    ]
  });
  const { W } = k;

  k.h3('Equipment on this job');
  const eqRows = ['dehumidifier', 'air_mover', 'air_scrubber', 'heater']
    .filter((t) => qtyOf(t) > 0)
    .map((t) => [EQUIP_FULL[t] || t, String(qtyOf(t)) + ' unit' + (qtyOf(t) === 1 ? '' : 's'), 'Daily placement is on the chamber pages']);
  if (eqRows.length) {
    k.table([{ t: 'Equipment', w: 0.34 }, { t: 'Total', w: 0.18, align: 'right' }, { t: 'Detail', w: 0.48 }], eqRows);
  } else {
    k.para('No equipment has been recorded on this job yet.', { color: T.muted });
  }

  k.h3('Instructions for technicians');
  k.bullets([
    'Each drying chamber has its own page.',
    'Record a reading every day the equipment is on site, including the day it comes out.',
    'Take moisture readings at the SAME points every day. A point that moves proves nothing.',
    'Record temperature, relative humidity and grains per pound for the affected air and the dehumidifier outlet.',
    'Note any equipment change, access problem or observation in the notes column.',
    'A reading is timestamped when it is captured in the field. Do not backfill from memory.',
    'The supervisor signs off each chamber when it reaches the dry standard.'
  ], { size: T.size.small });

  // ============================== CHAMBER PAGES ==============================
  chambers.forEach((ch, idx) => {
    doc.addPage();
    doc.x = M; doc.y = 76;

    k.section('Chamber ' + (idx + 1) + ': ' + (ch.name || 'Chamber'));

    k.facts([
      ['Dimensions', ch.length_ft && ch.width_ft ? `${ch.length_ft} x ${ch.width_ft} x ${ch.height_ft ?? 8} ft` : '-'],
      ['Class of loss', ch.class_of_loss ? 'Class ' + ch.class_of_loss : '-'],
      ['Job', [claim.policyholder_name, claim.carrier_identifier].filter(Boolean).join('   ')]
    ], 3);

    const cReadings = readings.filter((r) => r.chamber_id === ch.id)
      .sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
    const cEquip = equipment.filter((e) => e.chamber_id === ch.id);

    // ELEVEN COLUMNS DO NOT FIT ON A LETTER PAGE. The first cut of this crammed date,
    // tech, dehus, air movers, temp, RH, GPP, three monitoring points and a notes column
    // into 512 points and shredded the headers into "TE / CH" and "SUBFL / OOR.". So it is
    // two tables, each with the full width:
    //
    //   1. what was ON SITE and what the AIR was doing, day by day
    //   2. what the MATERIALS read, point by point, across every day
    //
    // The second one also drops the arbitrary three-point cap. A chamber with five
    // monitoring points now prints five.
    const days = [...new Set(cReadings.map((r) => dayKey(r.captured_at)).filter(Boolean))].sort();

    const dayRow = (day) => {
      const dayReads = cReadings.filter((r) => dayKey(r.captured_at) === day);
      const psy = dayReads.find((r) => r.reading_type === 'psychrometric') || dayReads.find((r) => r.temp_f != null);
      const dehuOn = cEquip.filter((e) => e.type === 'dehumidifier' && activeOn(e, day)).reduce((s, e) => s + (e.actual_placed || 1), 0);
      const amCount = cEquip.filter((e) => e.type === 'air_mover' && activeOn(e, day)).reduce((s, e) => s + (e.actual_placed || 1), 0);
      const note = (dayReads.find((r) => r.note) || {}).note || '';
      const tech = (dayReads.find((r) => r.tech_initials) || {}).tech_initials || '';
      return [
        dOnly(day), tech,
        dehuOn ? String(dehuOn) : '-', amCount ? String(amCount) : '-',
        psy && psy.temp_f != null ? psy.temp_f + 'F' : '-',
        psy && psy.rh_pct != null ? psy.rh_pct + '%' : '-',
        psy && psy.gpp != null ? String(psy.gpp) : '-',
        note
      ];
    };

    k.h3('Daily readings');
    if (!days.length) {
      k.para('No readings have been recorded in this chamber yet.', { color: T.muted, size: T.size.small });
    } else {
      k.table(
        [{ t: 'Date', w: 0.10 }, { t: 'Tech', w: 0.07 },
         { t: 'Dehus', w: 0.08, align: 'right' }, { t: 'Movers', w: 0.10, align: 'right' },
         { t: 'Temp', w: 0.08, align: 'right' }, { t: 'RH', w: 0.07, align: 'right' },
         { t: 'GPP', w: 0.08, align: 'right' },
         { t: 'Notes and observations', w: 0.42 }],
        days.map(dayRow)
      );
      k.para('Dehus and movers are the AIR MOVERS and DEHUMIDIFIERS on site that day, which is what the equipment-days line bills against. GPP is grains per pound of the affected air.',
        { size: T.size.tiny, color: T.faint });
      k.gap(1);

      // ---- material moisture, every point, every day ----
      const pts = [];
      for (const r of cReadings) {
        if (r.reading_type !== 'material_mc' || !r.location_label) continue;
        const key = r.location_label + '|' + (r.material || '');
        if (!pts.some((p) => p.key === key)) pts.push({ key, label: r.location_label, material: r.material || '' });
      }
      if (pts.length) {
        const goalFor = (m) => {
          const g = (graph.dryStandards || []).find((z) => z.chamber_id === ch.id && (z.material || '').toLowerCase() === (m || '').toLowerCase());
          return g ? g.goal_value : null;
        };
        const dw = Math.min(0.11, 0.55 / Math.max(1, days.length));
        const cols = [
          { t: 'Monitoring point', w: 1 - dw * days.length - 0.12 },
          { t: 'Goal', w: 0.12, align: 'right' }
        ].concat(days.map((d) => ({ t: dOnly(d).replace(/\/\d{2}$/, ''), w: dw, align: 'right' })));

        k.h3('Material moisture by point');
        k.table(cols, pts.map((p) => {
          const goal = goalFor(p.material);
          const head = p.material ? `${p.label}, ${p.material}` : p.label;
          return [head, goal != null ? String(goal) : '-'].concat(days.map((d) => {
            const r = cReadings.find((x) => x.reading_type === 'material_mc' && x.location_label === p.label
              && (x.material || '') === p.material && dayKey(x.captured_at) === d);
            return r && r.material_mc != null ? String(r.material_mc) : '-';
          }));
        }));
        k.para('The same points, read every day. A point that moves between visits proves nothing, which is why the location is recorded with the reading.',
          { size: T.size.tiny, color: T.faint });
      }
    }

    // ---- sign-off ----
    k.gap(2);
    const sig = signatures.find((s) => s.doc_type === 'chamber_signoff' && s.doc_snapshot && s.doc_snapshot.chamber_id === ch.id);
    const acceptable = sig && sig.doc_snapshot ? sig.doc_snapshot.acceptable : null;

    const boxH = 76;
    const y = k.ensure(boxH + 8);
    doc.save().roundedRect(M, y, W, boxH, 5).fill(T.soft).restore();

    k.font('b', T.size.tiny, T.muted).text('SUPERVISOR SIGN-OFF', M + 12, y + 10, { width: W - 24, characterSpacing: 0.5, lineBreak: false });

    if (sig && sig.signature_data && sig.signature_data.indexOf('base64,') >= 0) {
      try { doc.image(Buffer.from(sig.signature_data.split('base64,')[1], 'base64'), M + 12, y + 24, { fit: [140, 30] }); }
      catch (_e) { /* a corrupt signature image must never kill the document */ }
    } else {
      doc.save().moveTo(M + 12, y + 48).lineTo(M + 190, y + 48).lineWidth(0.8).strokeColor('#B8C4D0').stroke().restore();
    }

    const rx = M + W / 2;
    k.font('b', T.size.tiny, T.muted).text('DATE', rx, y + 24, { width: 120, characterSpacing: 0.5, lineBreak: false });
    k.font('', T.size.body, T.ink).text(sig ? new Date(sig.signed_at).toLocaleDateString() : '', rx, y + 35, { width: 120, lineBreak: false });

    k.font('b', T.size.tiny, T.muted).text('TECHNICIAN', rx + 130, y + 24, { width: 140, characterSpacing: 0.5, lineBreak: false });
    k.font('', T.size.body, T.ink).text(sig && sig.signer_name ? sig.signer_name : '', rx + 130, y + 35, { width: 140, lineBreak: false });

    k.font('b', T.size.tiny, T.muted).text('FINAL READINGS AT DRY STANDARD', rx, y + 54, { width: 260, characterSpacing: 0.5, lineBreak: false });
    k.font('b', T.size.body, acceptable === true ? T.ok : acceptable === false ? T.bad : T.faint)
      .text(acceptable === true ? 'Yes' : acceptable === false ? 'No' : 'Not signed off', rx + 175, y + 53, { width: 90, lineBreak: false });

    doc.x = M; doc.y = y + boxH + 8;
  });

  brandFooterBlock(k, cfg);

  // NO contents page. There is no page reserved for one, and contentsPage(0) would have
  // drawn the list straight over the cover.
  k.furniture({
    company: cfg.company_name || '',
    address: claim.address || '',
    coverPages: 1,
    footNote: [claim.policyholder_name, claim.carrier_identifier].filter(Boolean).join('   \u00b7   ')
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

module.exports = { generateDryingLogPdf, buildDryingLog, dayKey };