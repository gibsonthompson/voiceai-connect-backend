// ============================================================================
// resto-map-svg.js — SINGLE SOURCE OF TRUTH for rendering a moisture map to SVG.
// The report embeds this exact SVG (via svg-to-pdfkit); the frontend mirrors it
// (buildMapSvg.ts) so the printed map is identical to the app. Encodes standard
// floor-plan conventions: line-weight hierarchy, overall dimension lines with
// tick marks, a graphic scale bar, and a legend. Wet areas are Chaikin-smoothed
// (never overshoot the walls) and clipped to the room.
// ============================================================================
const UPF = 40; // scene units per foot
const EQ = {
  air_mover: { fill: '#29ABE6' },
  dehumidifier: { fill: '#11B5C6' },
  air_scrubber: { fill: '#64748B' }
};
// Pictographic equipment icons (white on the colored badge), designed to sit in
// a ~radius-9 box so they read at report scale. Shared 1:1 with the app.
const ICON = {
  air_mover: `<g><circle cx="-0.5" cy="1" r="5.6" fill="#fff"/><path d="M3 -2.4 L8.6 -6 L10.2 -3.3 L4.6 0.3 Z" fill="#fff"/><circle cx="-0.5" cy="1" r="2.15" fill="#29ABE6"/></g>`,
  dehumidifier: '<g><rect x="-7" y="-7" width="14" height="14" rx="3" fill="#fff"/><path d="M0 -3.6 C 2.5 -0.4 3.3 1 3.3 2.4 A3.3 3.3 0 1 1 -3.3 2.4 C -3.3 1 -2.5 -0.4 0 -3.6 Z" fill="#11B5C6"/></g>',
  air_scrubber: '<g><rect x="-7" y="-7" width="14" height="14" rx="3" fill="#fff"/><g stroke="#64748B" stroke-width="1.7" stroke-linecap="round"><line x1="-4.3" y1="-3" x2="4.3" y2="-3"/><line x1="-4.3" y1="0" x2="4.3" y2="0"/><line x1="-4.3" y1="3" x2="4.3" y2="3"/></g></g>'
};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ftStr = (ft) => { const r = Math.round(ft * 10) / 10; return (Number.isInteger(r) ? r : r.toFixed(1)) + "'"; };

function centroid(pts) {
  let x = 0, y = 0, a = 0;
  for (let i = 0; i < pts.length; i++) { const p1 = pts[i], p2 = pts[(i + 1) % pts.length]; const cr = p1[0] * p2[1] - p2[0] * p1[1]; a += cr; x += (p1[0] + p2[0]) * cr; y += (p1[1] + p2[1]) * cr; }
  a *= 0.5; if (!a) { const n = pts.length || 1; return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n]; }
  return [x / (6 * a), y / (6 * a)];
}
// Chaikin corner-cutting for a CLOSED polygon: each edge contributes points at
// 1/4 and 3/4 -> curve stays inside the control polygon (no overshoot).
function chaikin(pts, iters) {
  let p = pts.slice();
  for (let k = 0; k < iters; k++) {
    const out = [], n = p.length;
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    p = out;
  }
  return p;
}
const latestVal = (mp) => {
  const r = Array.isArray(mp.readings) ? mp.readings : [];
  if (!r.length) return mp.label ? String(mp.label) : '';
  return String([...r].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))[r.length - 1].value || '');
};

function buildMapSvg(scene, opts) {
  opts = opts || {};
  scene = scene || {};
  const walls = scene.walls || [], wets = scene.wetAreas || [], equip = scene.equipment || [], pins = scene.moisturePoints || [], arrows = scene.arrows || [];

  const all = [];
  walls.forEach((p) => (p.points || []).forEach((q) => all.push(q)));
  wets.forEach((p) => (p.points || []).forEach((q) => all.push(q)));
  equip.forEach((e) => all.push([e.x, e.y]));
  pins.forEach((m) => all.push([m.x, m.y]));
  arrows.forEach((a) => { if (a.from) all.push(a.from); if (a.to) all.push(a.to); });

  const outW = opts.width || 760;
  if (!all.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="200" viewBox="0 0 ${outW} 200" font-family="Helvetica,Arial,sans-serif"><rect width="${outW}" height="200" fill="#ffffff"/><text x="${outW / 2}" y="104" text-anchor="middle" font-size="13" fill="#9aa5b1">No sketch yet</text></svg>`;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  all.forEach(([x, y]) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; });
  const cwU = Math.max(1, maxX - minX), chU = Math.max(1, maxY - minY);
  const S = (opts.draw || 540) / Math.max(cwU, chU);   // scene units -> px
  const mL = 70, mT = 50, mR = 28, mB = 108;            // margins: dims / scale bar / legend
  const drawW = cwU * S, drawH = chU * S;
  const svgW = Math.round(mL + drawW + mR), svgH = Math.round(mT + drawH + mB);
  const fx = (x) => (mL + (x - minX) * S), fy = (y) => (mT + (y - minY) * S);
  const N = (v) => (Math.round(v * 10) / 10);
  const polyStr = (pts) => pts.map((pt) => `${N(fx(pt[0]))},${N(fy(pt[1]))}`).join(' ');

  const P = [];
  P.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" font-family="Helvetica,Arial,sans-serif">`);
  P.push(`<rect width="${svgW}" height="${svgH}" fill="#ffffff"/>`);

  // clip = union of rooms (wet areas cannot bleed outside)
  if (walls.length) {
    P.push('<clipPath id="rooms">');
    walls.forEach((p) => { if (p.points && p.points.length >= 3) P.push(`<polygon points="${polyStr(p.points)}"/>`); });
    P.push('</clipPath>');
  }
  const clipAttr = walls.length ? ' clip-path="url(#rooms)"' : '';

  // 1) floor fills
  walls.forEach((p) => { if (p.points && p.points.length >= 2) P.push(`<polygon points="${polyStr(p.points)}" fill="#f4f7fb"/>`); });

  // 2) wet areas (Chaikin smoothed, clipped)
  wets.forEach((p) => {
    const pts = p.points || []; if (pts.length < 2) return;
    const use = pts.length >= 3 ? chaikin(pts, 3) : pts;
    P.push(`<polygon${clipAttr} points="${polyStr(use)}" fill="#bfe6fb" stroke="#38bdf8" stroke-width="1.5" stroke-linejoin="round"/>`);
  });

  // 3) walls — double-line mitered band (classic floor-plan wall): a thick dark
  //    stroke with a slightly thinner white stroke knocking out the core.
  const WT = 9, LW = 1.6;
  walls.forEach((p) => {
    if (!p.points || p.points.length < 2) return;
    const pts = polyStr(p.points);
    P.push(`<polygon points="${pts}" fill="none" stroke="#0E2A4D" stroke-width="${WT}" stroke-linejoin="miter" stroke-miterlimit="8"/>`);
    P.push(`<polygon points="${pts}" fill="none" stroke="#ffffff" stroke-width="${WT - 2 * LW}" stroke-linejoin="miter" stroke-miterlimit="8"/>`);
    if (p.material) { const c = centroid(p.points); P.push(`<text x="${N(fx(c[0]))}" y="${N(fy(c[1]) + 4)}" text-anchor="middle" font-size="12" font-weight="700" fill="#64748b">${esc(p.material)}</text>`); }
  });

  // 3.5) openings (doors / windows / cased openings) — knock a gap in the wall band
  const wallMap = {}; walls.forEach((w) => { wallMap[w.id] = w; });
  (scene.openings || []).forEach((op) => {
    const w = wallMap[op.wallId]; if (!w || !w.points || w.points.length < 2) return;
    const n = w.points.length;
    const P0 = w.points[op.edge], P1 = w.points[(op.edge + 1) % n];
    const ex = P1[0] - P0[0], ey = P1[1] - P0[1], len = Math.hypot(ex, ey) || 1;
    const dir = [ex / len, ey / len]; let nrm = [-dir[1], dir[0]];
    const cx = P0[0] + op.t * ex, cy = P0[1] + op.t * ey;
    const c = centroid(w.points);
    if ((c[0] - cx) * nrm[0] + (c[1] - cy) * nrm[1] < 0) nrm = [-nrm[0], -nrm[1]];
    const half = Math.min((op.widthFt * UPF) / 2, (len / 2) * 0.9);
    const A = [cx - dir[0] * half, cy - dir[1] * half], B = [cx + dir[0] * half, cy + dir[1] * half];
    const Ax = fx(A[0]), Ay = fy(A[1]), Bx = fx(B[0]), By = fy(B[1]);
    const nx = nrm[0], ny = nrm[1], h = WT / 2 + 1.2, jh = WT / 2, gapLen = Math.hypot(Bx - Ax, By - Ay);
    P.push(`<polygon points="${N(Ax)},${N(Ay)} ${N(Bx)},${N(By)} ${N(Bx + nx * h)},${N(By + ny * h)} ${N(Ax + nx * h)},${N(Ay + ny * h)}" fill="#f4f7fb"/>`);
    P.push(`<polygon points="${N(Ax)},${N(Ay)} ${N(Bx)},${N(By)} ${N(Bx - nx * h)},${N(By - ny * h)} ${N(Ax - nx * h)},${N(Ay - ny * h)}" fill="#ffffff"/>`);
    P.push(`<line x1="${N(Ax - nx * jh)}" y1="${N(Ay - ny * jh)}" x2="${N(Ax + nx * jh)}" y2="${N(Ay + ny * jh)}" stroke="#0E2A4D" stroke-width="${LW}" stroke-linecap="round"/>`);
    P.push(`<line x1="${N(Bx - nx * jh)}" y1="${N(By - ny * jh)}" x2="${N(Bx + nx * jh)}" y2="${N(By + ny * jh)}" stroke="#0E2A4D" stroke-width="${LW}" stroke-linecap="round"/>`);
    if (op.kind === 'door') {
      const oeX = Ax + nx * gapLen, oeY = Ay + ny * gapLen, sweep = (dir[0] * ny - dir[1] * nx) > 0 ? 1 : 0;
      P.push(`<path d="M ${N(Bx)} ${N(By)} A ${N(gapLen)} ${N(gapLen)} 0 0 ${sweep} ${N(oeX)} ${N(oeY)}" fill="none" stroke="#94a3b8" stroke-width="1.6"/>`);
      P.push(`<line x1="${N(Ax)}" y1="${N(Ay)}" x2="${N(oeX)}" y2="${N(oeY)}" stroke="#0E2A4D" stroke-width="2"/>`);
    } else if (op.kind === 'window') {
      P.push(`<line x1="${N(Ax)}" y1="${N(Ay)}" x2="${N(Bx)}" y2="${N(By)}" stroke="#0E2A4D" stroke-width="1.6"/>`);
    }
  });

  // 4) overall dimension lines (walls bounding box)
  if (walls.length) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    walls.forEach((p) => (p.points || []).forEach(([x, y]) => { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }));
    const dc = '#94a3b8';
    const yT = N(fy(b) - 24), x1 = N(fx(a)), x2 = N(fx(c));
    P.push(`<line x1="${x1}" y1="${yT}" x2="${x2}" y2="${yT}" stroke="${dc}" stroke-width="1"/>`);
    P.push(`<line x1="${x1}" y1="${yT - 4}" x2="${x1}" y2="${yT + 4}" stroke="${dc}" stroke-width="1"/><line x1="${x2}" y1="${yT - 4}" x2="${x2}" y2="${yT + 4}" stroke="${dc}" stroke-width="1"/>`);
    P.push(`<rect x="${(x1 + x2) / 2 - 18}" y="${yT - 13}" width="36" height="13" fill="#ffffff"/><text x="${(x1 + x2) / 2}" y="${yT - 3}" text-anchor="middle" font-size="11" font-weight="700" fill="#475569">${ftStr((c - a) / UPF)}</text>`);
    const xL = N(fx(a) - 26), y1 = N(fy(b)), y2 = N(fy(d));
    P.push(`<line x1="${xL}" y1="${y1}" x2="${xL}" y2="${y2}" stroke="${dc}" stroke-width="1"/>`);
    P.push(`<line x1="${xL - 4}" y1="${y1}" x2="${xL + 4}" y2="${y1}" stroke="${dc}" stroke-width="1"/><line x1="${xL - 4}" y1="${y2}" x2="${xL + 4}" y2="${y2}" stroke="${dc}" stroke-width="1"/>`);
    P.push(`<text x="${xL - 5}" y="${(y1 + y2) / 2}" text-anchor="middle" font-size="11" font-weight="700" fill="#475569" transform="rotate(-90 ${xL - 5} ${(y1 + y2) / 2})">${ftStr((d - b) / UPF)}</text>`);
  }

  // 5) migration arrows
  arrows.forEach((ar) => {
    if (!ar.from || !ar.to) return;
    const x1 = fx(ar.from[0]), y1 = fy(ar.from[1]), x2 = fx(ar.to[0]), y2 = fy(ar.to[1]);
    const ang = Math.atan2(y2 - y1, x2 - x1), hl = 12, hw = 6.5, bx = x2 - hl * Math.cos(ang), by = y2 - hl * Math.sin(ang);
    P.push(`<line x1="${N(x1)}" y1="${N(y1)}" x2="${N(bx)}" y2="${N(by)}" stroke="#4F46E5" stroke-width="2.4" stroke-linecap="round"/>`);
    P.push(`<polygon points="${N(x2)},${N(y2)} ${N(bx - hw * Math.sin(ang))},${N(by + hw * Math.cos(ang))} ${N(bx + hw * Math.sin(ang))},${N(by - hw * Math.cos(ang))}" fill="#4F46E5"/>`);
  });

  // 6) equipment
  equip.forEach((e) => {
    const X = fx(e.x), Y = fy(e.y), R = 13, m = EQ[e.type] || EQ.air_scrubber;
    P.push(`<circle cx="${N(X)}" cy="${N(Y)}" r="${R}" fill="${m.fill}"/>`);
    P.push(`<g transform="translate(${N(X)},${N(Y)})">${ICON[e.type] || ICON.air_scrubber}</g>`);
  });

  // 7) reading pins (teardrop + value)
  pins.forEach((m) => {
    const X = fx(m.x), Y = fy(m.y), hy = Y - 16, R = 11;
    P.push(`<path d="M ${N(X)} ${N(Y)} L ${N(X - 5)} ${N(hy)} L ${N(X + 5)} ${N(hy)} Z" fill="#F26B3A"/>`);
    P.push(`<circle cx="${N(X)}" cy="${N(hy)}" r="${R}" fill="#F26B3A"/>`);
    P.push(`<text x="${N(X)}" y="${N(hy + 3)}" text-anchor="middle" font-size="8.5" font-weight="800" fill="#ffffff">${esc(latestVal(m).slice(0, 4))}</text>`);
  });

  // 8) scale bar (bottom-left)
  const barY = svgH - 56;
  let feet = 1; for (const f of [1, 2, 5, 10, 20, 50]) if (f * UPF * S <= 160) feet = f;
  const barLen = feet * UPF * S, bx0 = mL;
  P.push(`<line x1="${bx0}" y1="${barY}" x2="${N(bx0 + barLen)}" y2="${barY}" stroke="#0E2A4D" stroke-width="2"/>`);
  P.push(`<line x1="${bx0}" y1="${barY - 4}" x2="${bx0}" y2="${barY + 4}" stroke="#0E2A4D" stroke-width="2"/><line x1="${N(bx0 + barLen)}" y1="${barY - 4}" x2="${N(bx0 + barLen)}" y2="${barY + 4}" stroke="#0E2A4D" stroke-width="2"/>`);
  P.push(`<text x="${bx0}" y="${barY - 8}" font-size="10" font-weight="700" fill="#475569">Scale: ${feet} ft</text>`);

  // 9) legend
  const legend = [];
  const cnt = (t) => equip.filter((e) => e.type === t).length;
  if (cnt('air_mover')) legend.push(['#29ABE6', `Air mover (${cnt('air_mover')})`]);
  if (cnt('dehumidifier')) legend.push(['#11B5C6', `Dehu (${cnt('dehumidifier')})`]);
  if (cnt('air_scrubber')) legend.push(['#64748B', `Air scrubber (${cnt('air_scrubber')})`]);
  if (pins.length) legend.push(['#F26B3A', 'Reading']);
  if (wets.length) legend.push(['#38bdf8', 'Wet area']);
  if (arrows.length) legend.push(['#4F46E5', 'Migration']);
  let lx = mL; const ly = svgH - 26;
  legend.forEach(([col, label]) => {
    P.push(`<circle cx="${N(lx + 4)}" cy="${ly - 3}" r="4" fill="${col}"/>`);
    P.push(`<text x="${N(lx + 12)}" y="${ly}" font-size="10" fill="#475569">${esc(label)}</text>`);
    lx += 12 + label.length * 5.6 + 16;
  });

  P.push('</svg>');
  return P.join('');
}

module.exports = { buildMapSvg, UPF };