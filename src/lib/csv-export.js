// ============================================================================
// CSV EXPORT UTILITY — Shared across all export endpoints
// VoiceAI Connect — Phase 2: Data Export Layer
// ============================================================================

/**
 * Escape and format a single CSV cell value.
 * Handles nulls, commas, quotes, newlines, leading/trailing spaces.
 */
function formatCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r') ||
    str.startsWith(' ') ||
    str.endsWith(' ')
  ) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Format an ISO date string to a human-readable format for CSV.
 * Returns "YYYY-MM-DD HH:MM:SS" in UTC.
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Format duration in seconds to "Xm Ys".
 */
function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Generate a CSV string from an array of row objects and a column config.
 *
 * @param {Array<Object>} rows — array of data objects
 * @param {Array<Object>} columns — column definitions
 *   Each column: { key: 'field_name', label: 'Column Header', format?: (value, row) => string }
 * @returns {string} — complete CSV content with header row
 */
function generateCsv(rows, columns) {
  const header = columns.map(c => formatCsvValue(c.label)).join(',');
  const lines = rows.map(row => {
    return columns
      .map(col => {
        let val = row[col.key];
        if (col.format) val = col.format(val, row);
        return formatCsvValue(val);
      })
      .join(',');
  });
  return header + '\n' + lines.join('\n');
}

module.exports = { generateCsv, formatCsvValue, formatDate, formatDuration };