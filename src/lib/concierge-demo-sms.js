// ============================================================================
// CONCIERGE DEMO-DESTINATION SMS
// ----------------------------------------------------------------------------
// When a PROSPECT (someone evaluating VoiceAI Connect) is transferred by the
// concierge line into a live demo, the call lands on one of two real numbers:
//   - the HOME-SERVICES demo (a test client, e.g. Atlanta HVAC)   -> "home_services"
//   - the AGENCY demo line (e.g. Smart Call Solutions)            -> "agency"
// Those numbers' normal post-call behavior is wrong for a prospect: the home-
// services test client would text ITS "owner", and the agency demo line would
// text ITS agency-branded follow-up. Neither speaks to the person who's actually
// on the line, an agency BUYER.
//
// This module reframes the post-call text and sends it to the CALLER (the
// prospect) from the right angle:
//   home_services -> "this is the text you'd get as the business owner", then the
//                    real call summary, then how it ties to the agency opportunity.
//   agency        -> "this is the demo line you get to hand to local businesses so
//                    they can try their own AI free" (the demo as a sales tool).
//
// The webhook decides WHICH by matching the call's number against two env vars,
// so nothing is hardcoded:
//   DEMO_HOMESERVICES_NUMBER   (E.164)
//   DEMO_AGENCY_NUMBER         (E.164)
// If a number isn't one of these, isConciergeDemoNumber returns null and the
// caller's normal flow is untouched.
// ============================================================================
const { sendAndLogSMS } = require('./sms-logger');

const SIGNUP_URL = process.env.PLATFORM_SIGNUP_URL || 'https://www.myvoiceaiconnect.com/signup';

function last10(n) {
  return String(n || '').replace(/\D/g, '').slice(-10);
}

// Returns 'home_services' | 'agency' | null for a given phone number.
function isConciergeDemoNumber(number) {
  const d = last10(number);
  if (!d) return null;
  if (process.env.DEMO_HOMESERVICES_NUMBER && last10(process.env.DEMO_HOMESERVICES_NUMBER) === d) return 'home_services';
  if (process.env.DEMO_AGENCY_NUMBER && last10(process.env.DEMO_AGENCY_NUMBER) === d) return 'agency';
  return null;
}

// Dedupe so a prospect who calls a few times in a day isn't spammed.
const _sent = new Map();
function alreadySent(phone, kind) {
  if (!phone) return true;
  const key = `${last10(phone)}:${kind}:${new Date().toISOString().slice(0, 10)}`;
  if (_sent.get(key)) return true;
  _sent.set(key, Date.now());
  for (const [k, v] of _sent) { if (Date.now() - v > 26 * 60 * 60 * 1000) _sent.delete(k); }
  return false;
}

// Send the reframed SMS to the caller (the prospect).
//   kind: 'home_services' | 'agency'
//   summary: the AI call summary (used for home_services; agency ignores it)
async function sendConciergeDemoCallerSMS({ callerPhone, kind, summary }) {
  if (!callerPhone || callerPhone === 'Unknown') return false;
  if (alreadySent(callerPhone, kind)) return false;

  let body;
  if (kind === 'home_services') {
    const s = (summary && summary.trim()) ? summary.trim() : 'A caller reached out and the AI captured the details, who they were, what they needed, and their callback number.';
    body = [
      "This is the text you'd get as the business owner, seconds after every call:",
      '',
      s,
      '',
      "That's exactly what your clients receive, automatically, from their own AI receptionist. It's the product you'd be reselling as an agency. Start free: " + SIGNUP_URL,
    ].join('\n');
  } else if (kind === 'agency') {
    body = [
      "That's the branded demo line you get to hand to local businesses, so they can hear their own AI receptionist, customized to their business, free before they ever pay.",
      '',
      "It's one of the best sales tools you'll have as an agency. Start free: " + SIGNUP_URL,
    ].join('\n');
  } else {
    return false;
  }

  try {
    await sendAndLogSMS({
      phone: callerPhone,
      message: body,
      agencyId: null,
      recipientType: 'prospect',
      messageType: `concierge_demo_${kind}`,
      metadata: { kind },
    });
    console.log(`✅ Concierge demo SMS (${kind}) sent to ${callerPhone}`);
    return true;
  } catch (e) {
    console.warn(`⚠️ Concierge demo SMS (${kind}) failed:`, e.message);
    return false;
  }
}

module.exports = { isConciergeDemoNumber, sendConciergeDemoCallerSMS };