// ============================================================================
// BREVO SENDING-DOMAIN MANAGEMENT
// ----------------------------------------------------------------------------
// Thin wrapper over Brevo's domain API so an agency can authenticate its OWN
// sending domain and then send white-label client email from it. All calls use
// the account-level BREVO_API_KEY (the same key notifications.js already uses).
//
//   create:       POST   /v3/senders/domains            { name }
//   authenticate: PUT    /v3/senders/domains/{name}/authenticate
//   get/status:   GET    /v3/senders/domains/{name}
//   delete:       DELETE /v3/senders/domains/{name}
//
// Records returned to the caller are normalized to a flat, predictable list
// ([{ label, type, host, value, status }]) the dashboard renders as copy-paste
// rows, so the frontend never has to know Brevo's exact response shape.
// ============================================================================
const BREVO_BASE = 'https://api.brevo.com/v3/senders/domains';

function headers() {
  return {
    'Content-Type': 'application/json',
    accept: 'application/json',
    'api-key': process.env.BREVO_API_KEY,
  };
}

// Brevo returns dns_records as an object keyed by record kind, each entry like
// { type, host_name / host, value, status }. The exact keys have shifted across
// Brevo versions, so read every known alias defensively and skip anything with
// no value rather than emitting a broken record.
function normalizeRecords(dns) {
  if (!dns || typeof dns !== 'object') return [];
  const out = [];
  const push = (label, rec) => {
    if (!rec || typeof rec !== 'object') return;
    const host = rec.host_name || rec.host || rec.hostName || '';
    const value = rec.value || rec.record_value || rec.recordValue || '';
    const type = String(rec.type || 'TXT').toUpperCase();
    if (!value) return;
    const ok = rec.status === true || rec.status === 'OK' || rec.status === 'valid' || rec.status === 'Valid';
    out.push({ label, type, host, value, status: ok });
  };
  push('DKIM', dns.dkim_record || dns.dkimRecord || dns.dkim);
  push('Brevo code', dns.brevo_code || dns.brevoCode || dns.brevo);
  push('DMARC', dns.dmarc_record || dns.dmarcRecord || dns.dmarc);
  return out;
}

async function createDomain(name) {
  if (!process.env.BREVO_API_KEY) return { ok: false, status: 500, error: 'brevo_not_configured' };
  const r = await fetch(BREVO_BASE, { method: 'POST', headers: headers(), body: JSON.stringify({ name }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // A 400 is usually "domain already exists on this account". Recover by
    // fetching it, so re-connecting the same domain returns its existing records
    // instead of dead-ending.
    if (r.status === 400) {
      const existing = await getDomain(name);
      if (existing.ok) return existing;
    }
    return { ok: false, status: r.status, error: data.message || data.code || 'create_failed' };
  }
  return {
    ok: true,
    id: data.id != null ? String(data.id) : null,
    records: normalizeRecords(data.dns_records || data.dnsRecords),
    authenticated: data.authenticated === true,
    verified: data.verified === true,
  };
}

async function authenticateDomain(name) {
  if (!process.env.BREVO_API_KEY) return { ok: false, status: 500, error: 'brevo_not_configured' };
  const r = await fetch(`${BREVO_BASE}/${encodeURIComponent(name)}/authenticate`, { method: 'PUT', headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: data.message || data.code || 'authenticate_failed' };
  return { ok: true, message: data.message || 'authenticated' };
}

async function getDomain(name) {
  if (!process.env.BREVO_API_KEY) return { ok: false, status: 500, error: 'brevo_not_configured' };
  const r = await fetch(`${BREVO_BASE}/${encodeURIComponent(name)}`, { method: 'GET', headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: data.message || data.code || 'get_failed' };
  return {
    ok: true,
    id: data.id != null ? String(data.id) : null,
    authenticated: data.authenticated === true,
    verified: data.verified === true,
    records: normalizeRecords(data.dns_records || data.dnsRecords),
  };
}

async function deleteDomain(name) {
  if (!process.env.BREVO_API_KEY) return { ok: false, status: 500, error: 'brevo_not_configured' };
  const r = await fetch(`${BREVO_BASE}/${encodeURIComponent(name)}`, { method: 'DELETE', headers: headers() });
  if (!r.ok && r.status !== 404) {
    const data = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, error: data.message || 'delete_failed' };
  }
  return { ok: true };
}

module.exports = { createDomain, authenticateDomain, getDomain, deleteDomain, normalizeRecords };
