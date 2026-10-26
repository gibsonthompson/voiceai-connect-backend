// ============================================================================
// AGENCY EMAIL-DOMAIN ROUTES (white-label transactional sending)
// ----------------------------------------------------------------------------
// Lets an agency authenticate its OWN sending domain in Brevo so the platform
// can send that agency's client-facing transactional email FROM the agency's
// domain (e.g. notifications@theiragency.com), never VoiceAI Connect.
//
// Flow mirrors routes/domains.js (the marketing-domain flow) but wraps Brevo's
// domain API instead of Vercel:
//   POST   /:agencyId/email-domain          -> register domain in Brevo, store
//                                              pending + return DNS records
//   POST   /:agencyId/email-domain/verify   -> authenticate + refresh status
//   GET    /:agencyId/email-domain          -> current status + records
//   DELETE /:agencyId/email-domain          -> disconnect
//
// GATE: every write requires the agency's paid flag `white_label_email_enabled`.
// Without it the endpoints refuse, and sendClientEmail (notifications.js) never
// sends, so an agency with no authenticated domain sends no client email at all.
// ============================================================================
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const brevo = require('../lib/brevo-domains');

let supabase;
try {
  supabase = require('../lib/supabase').supabase;
  console.log('✅ Email-domain routes: Supabase loaded');
} catch (err) {
  console.error('❌ Email-domain routes: Failed to load supabase:', err.message);
}

const JWT_SECRET = process.env.JWT_SECRET;

// Platform domains can never be an agency's own sending domain.
const BLOCKED_EXACT_DOMAINS = ['myvoiceaiconnect.com', 'callbirdai.com'];
const BLOCKED_DOMAIN_SUFFIXES = [
  '.myvoiceaiconnect.com', '.callbirdai.com', '.vercel.app', '.netlify.app',
  '.herokuapp.com', '.pages.dev', '.onrender.com', '.railway.app',
];
const DOMAIN_RE = /^[a-z0-9]+([\-.]{1}[a-z0-9]+)*\.[a-z]{2,}$/;

// --- auth: caller must be the agency that owns :agencyId, or a super_admin ---
function decodeToken(req) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}
function authorize(req, agencyId) {
  const decoded = decodeToken(req);
  if (!decoded) return { ok: false, code: 401, error: 'Authentication required' };
  if (decoded.role === 'super_admin') return { ok: true, decoded };
  if (decoded.agencyId && decoded.agencyId === agencyId) return { ok: true, decoded };
  return { ok: false, code: 403, error: 'Forbidden' };
}

function normalizeDomain(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\/$/, '')
    .trim();
}
function sanitizeLocalPart(raw) {
  const v = String(raw || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return v || null;
}

// CORS preflight (the agency dashboard calls these cross-origin, same as domains.js)
router.options('/:agencyId/email-domain', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});
router.options('/:agencyId/email-domain/verify', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});

async function loadAgency(agencyId) {
  const { data, error } = await supabase
    .from('agencies')
    .select('id, name, support_email, white_label_email_enabled, email_sending_domain, email_domain_status, email_domain_brevo_id, email_from_local, email_dns_records')
    .eq('id', agencyId)
    .single();
  if (error) return null;
  return data;
}

function publicShape(agency) {
  return {
    enabled: agency.white_label_email_enabled === true,
    status: agency.email_domain_status || 'none',
    domain: agency.email_sending_domain || null,
    fromLocal: agency.email_from_local || 'notifications',
    fromAddress: agency.email_sending_domain
      ? `${agency.email_from_local || 'notifications'}@${agency.email_sending_domain}`
      : null,
    records: Array.isArray(agency.email_dns_records) ? agency.email_dns_records : [],
  };
}

// GET current status + records
router.get('/:agencyId/email-domain', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const auth = authorize(req, agencyId);
    if (!auth.ok) return res.status(auth.code).json({ error: auth.error });
    const agency = await loadAgency(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    return res.json({ success: true, ...publicShape(agency) });
  } catch (e) {
    console.error('❌ email-domain GET error:', e.message);
    return res.status(500).json({ error: 'Failed to load email domain' });
  }
});

// POST register a sending domain in Brevo (gated by the paid flag)
router.post('/:agencyId/email-domain', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const auth = authorize(req, agencyId);
    if (!auth.ok) return res.status(auth.code).json({ error: auth.error });

    const agency = await loadAgency(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    if (agency.white_label_email_enabled !== true) {
      return res.status(403).json({ error: 'feature_disabled', message: 'Sending client email from your own domain is a paid add-on. Contact us to enable it.' });
    }

    const domain = normalizeDomain(req.body && req.body.domain);
    if (!domain || !DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Invalid domain format' });
    if (BLOCKED_EXACT_DOMAINS.includes(domain) || BLOCKED_DOMAIN_SUFFIXES.some(s => domain.endsWith(s))) {
      return res.status(400).json({ error: 'That is a platform domain. Use a domain you own, for example youragency.com.' });
    }
    const fromLocal = sanitizeLocalPart(req.body && req.body.fromLocal) || agency.email_from_local || 'notifications';

    const created = await brevo.createDomain(domain);
    if (!created.ok) {
      return res.status(created.status === 400 ? 400 : 502).json({ error: created.error || 'Could not register the domain with the mail provider.' });
    }

    const { error: upErr } = await supabase.from('agencies').update({
      email_sending_domain: domain,
      email_domain_brevo_id: created.id || null,
      email_domain_status: created.authenticated ? 'authenticated' : 'pending',
      email_from_local: fromLocal,
      email_dns_records: created.records || [],
    }).eq('id', agencyId);
    if (upErr) { console.error('❌ email-domain save error:', upErr.message); return res.status(500).json({ error: 'Saved with provider but failed to store locally. Try again.' }); }

    return res.json({
      success: true,
      status: created.authenticated ? 'authenticated' : 'pending',
      domain,
      fromLocal,
      fromAddress: `${fromLocal}@${domain}`,
      records: created.records || [],
    });
  } catch (e) {
    console.error('❌ email-domain POST error:', e.message);
    return res.status(500).json({ error: 'Failed to connect email domain' });
  }
});

// POST verify/authenticate after the agency has added the DNS records
router.post('/:agencyId/email-domain/verify', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const auth = authorize(req, agencyId);
    if (!auth.ok) return res.status(auth.code).json({ error: auth.error });

    const agency = await loadAgency(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    if (agency.white_label_email_enabled !== true) return res.status(403).json({ error: 'feature_disabled' });
    if (!agency.email_sending_domain) return res.status(400).json({ error: 'No domain connected yet' });

    const domain = agency.email_sending_domain;
    // Ask Brevo to re-check the records, then read the authoritative status.
    await brevo.authenticateDomain(domain); // best-effort; status comes from GET
    const got = await brevo.getDomain(domain);
    if (!got.ok) return res.status(502).json({ error: got.error || 'Could not check domain status.' });

    const status = got.authenticated ? 'authenticated' : 'pending';
    await supabase.from('agencies').update({
      email_domain_status: status,
      email_dns_records: got.records && got.records.length ? got.records : (agency.email_dns_records || []),
      email_domain_brevo_id: got.id || agency.email_domain_brevo_id || null,
    }).eq('id', agencyId);

    return res.json({
      success: true,
      status,
      authenticated: got.authenticated,
      verified: got.verified,
      domain,
      fromAddress: `${agency.email_from_local || 'notifications'}@${domain}`,
      records: got.records && got.records.length ? got.records : (agency.email_dns_records || []),
    });
  } catch (e) {
    console.error('❌ email-domain verify error:', e.message);
    return res.status(500).json({ error: 'Failed to verify email domain' });
  }
});

// DELETE disconnect
router.delete('/:agencyId/email-domain', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const auth = authorize(req, agencyId);
    if (!auth.ok) return res.status(auth.code).json({ error: auth.error });

    const agency = await loadAgency(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });
    if (agency.email_sending_domain) {
      await brevo.deleteDomain(agency.email_sending_domain); // ignore 404s
    }
    await supabase.from('agencies').update({
      email_sending_domain: null,
      email_domain_brevo_id: null,
      email_domain_status: 'none',
      email_dns_records: [],
    }).eq('id', agencyId);

    return res.json({ success: true, status: 'none' });
  } catch (e) {
    console.error('❌ email-domain DELETE error:', e.message);
    return res.status(500).json({ error: 'Failed to disconnect email domain' });
  }
});

module.exports = router;
