// ============================================================================
// FEET AND INCHES (backend mirror of frontend lib/feetInches.ts)
// ----------------------------------------------------------------------------
// A tech measures 12 feet 7 inches. Math needs 12.58333. A report needs 12' 7".
// STORE DECIMAL FEET, never the string. A parity test compares this module's output
// to the frontend's on every input form, because two parsers that disagree is a
// silently wrong dimension on an insurance estimate.
// ============================================================================
const IN_PER_FT = 12;

function parseInchPart(raw) {
  const s = String(raw).trim();
  if (!s) return 0;
  let m = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (m) { const den = Number(m[3]); if (!den) return null; return Number(m[1]) + Number(m[2]) / den; }
  m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) { const den = Number(m[2]); if (!den) return null; return Number(m[1]) / den; }
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]);
  return null;
}

function parseFeetInches(input) {
  if (input == null) return null;
  if (typeof input === 'number') return isFinite(input) && input >= 0 ? input : null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('-')) return null;
  s = s.replace(/[\u2032\u2018\u2019\u00b4`]/g, "'").replace(/[\u2033\u201c\u201d]/g, '"');
  s = s.replace(/(\d)\s*(?:feet|foot|ft)(?![a-z])/g, "$1'")
       .replace(/(\d)\s*(?:inches|inch|ins|in)(?![a-z])/g, '$1"');
  s = s.replace(/\s+/g, ' ').trim();
  if (!/\d/.test(s)) return null;

  let m = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(.*)$/);
  if (m) {
    const feet = Number(m[1]);
    const rest = m[2].trim().replace(/"$/, '').trim();
    if (!rest) return feet;
    const inches = parseInchPart(rest);
    if (inches == null || inches >= IN_PER_FT) return null;
    return feet + inches / IN_PER_FT;
  }
  m = s.match(/^(.+)"$/);
  if (m) { const inches = parseInchPart(m[1]); if (inches == null) return null; return inches / IN_PER_FT; }
  m = s.match(/^(\d+)\s*-\s*(.+)$/);
  if (m) { const inches = parseInchPart(m[2]); if (inches == null || inches >= IN_PER_FT) return null; return Number(m[1]) + inches / IN_PER_FT; }
  m = s.match(/^(\d+)\s+(.+)$/);
  if (m) { const inches = parseInchPart(m[2]); if (inches == null || inches >= IN_PER_FT) return null; return Number(m[1]) + inches / IN_PER_FT; }
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]);
  return null;
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function formatFeetInches(ft, denom) {
  const d = denom || 8;
  if (ft == null || !isFinite(ft) || ft < 0) return '';
  const totalIn = Math.round(ft * IN_PER_FT * d) / d;
  let feet = Math.floor(totalIn / IN_PER_FT + 1e-9);
  let inches = totalIn - feet * IN_PER_FT;
  if (inches >= IN_PER_FT - 1e-9) { feet += 1; inches = 0; }
  const whole = Math.floor(inches + 1e-9);
  const fracVal = inches - whole;
  let frac = '';
  if (fracVal > 1e-9) {
    let num = Math.round(fracVal * d), den = d;
    const gg = gcd(num, den) || 1; num /= gg; den /= gg;
    if (num > 0) frac = `${whole ? ' ' : ''}${num}/${den}`;
  }
  const inchStr = (whole > 0 || frac) ? `${whole > 0 || !frac ? whole : ''}${frac}"` : '';
  if (feet && inchStr) return `${feet}' ${inchStr}`;
  if (feet) return `${feet}'`;
  if (inchStr) return inchStr;
  return `0'`;
}

const roundToFraction = (ft, denom) => {
  const d = denom || 8;
  return isFinite(ft) ? Math.round(ft * IN_PER_FT * d) / (IN_PER_FT * d) : ft;
};

module.exports = { parseFeetInches, formatFeetInches, roundToFraction };