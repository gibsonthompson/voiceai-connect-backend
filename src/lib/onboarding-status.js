// ============================================================================
// Client onboarding / setup completeness
// VoiceAI Connect
// ----------------------------------------------------------------------------
// Derives, from a client's REAL data, how much of the AI receptionist setup the
// client has actually filled in. This is what the agency sees on the clients
// list and the client detail page, so they can spot who is under-configured and
// know exactly what is still missing.
//
// Why derive it instead of trusting a flag: the wizard's completed-steps live
// only in the browser session (they reset every visit), and `onboarding_completed`
// is all-or-nothing, flipped only when the client clicks through "Go Live". Neither
// tells the agency what is actually set. So we read the underlying data per section.
//
// Sections (6): website scanned, business hours, services, knowledge base,
// voice & greeting, and staff. Staff is OPTIONAL (plenty of clients are solo
// operators, so an empty staff list should not read as "incomplete") -- it is
// reported but does not count toward the required total.
// ============================================================================

function nonEmptyStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// True when a jsonb-ish value actually carries content (object with keys or a
// non-empty array). Accepts a stringified JSON value too, degrading to a plain
// non-empty-string check if it does not parse.
function hasJsonContent(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return false;
    try { v = JSON.parse(s); } catch { return true; }
  }
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * Compute a client's setup status.
 * @param {object} client - the full clients row
 * @param {{ serviceCount?: number, staffCount?: number }} counts - row counts
 *        from client_services / staff_members for this client
 * @returns {{
 *   sections: Record<string, { label: string, done: boolean, optional: boolean, count?: number }>,
 *   completed_count: number, total: number, percent: number, onboarding_completed: boolean
 * }}
 */
function computeClientOnboardingStatus(client = {}, counts = {}) {
  const serviceCount = Number(counts.serviceCount) || 0;
  const staffCount = Number(counts.staffCount) || 0;

  // A knowledge base exists when there is KB text/id/data on the client.
  const hasKb =
    nonEmptyStr(client.knowledge_base_content) ||
    nonEmptyStr(client.knowledge_base_id) ||
    hasJsonContent(client.knowledge_base_data);

  // Website scanned: a website is on file AND a KB was built from it, or we have
  // a recorded scan timestamp. (The onboarding "Scan my website" step and the
  // dashboard "Learn from website" action both write the KB + updated_at.)
  const hasWebsite = nonEmptyStr(client.business_website) || nonEmptyStr(client.website_url);
  const websiteScanned = Boolean(client.knowledge_base_updated_at) || (hasWebsite && hasKb);

  const sections = {
    website:   { label: 'Website scanned',  done: websiteScanned,                  optional: false },
    hours:     { label: 'Business hours',   done: hasJsonContent(client.business_hours), optional: false },
    services:  { label: 'Services',         done: serviceCount > 0,                optional: false, count: serviceCount },
    knowledge: { label: 'Knowledge base',   done: hasKb,                           optional: false },
    voice:     { label: 'Voice & greeting', done: nonEmptyStr(client.greeting_message) || nonEmptyStr(client.voice_id), optional: false },
    staff:     { label: 'Staff',            done: staffCount > 0,                  optional: true,  count: staffCount },
  };

  const required = Object.values(sections).filter((s) => !s.optional);
  const completed_count = required.filter((s) => s.done).length;
  const total = required.length; // 5 required; staff is extra credit

  return {
    sections,
    completed_count,
    total,
    percent: total ? Math.round((completed_count / total) * 100) : 0,
    onboarding_completed: client.onboarding_completed === true,
  };
}

module.exports = { computeClientOnboardingStatus };
