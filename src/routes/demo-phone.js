// ============================================================================
// DEMO PHONE ROUTES
// POST   /api/agency/:agencyId/demo-phone         - Create demo phone (async)
// GET    /api/agency/:agencyId/demo-phone/status  - Poll provisioning status
// DELETE /api/agency/:agencyId/demo-phone         - Remove demo phone
// GET    /api/agency/:agencyId/demo-calls         - List demo calls
// GET    /api/agency/:agencyId/demo-calls/:callId - Get demo call detail
// UPDATED: 2026-05-20 - Added demo call history endpoints
// UPDATED: 2026-06-03 - DELETE now releases the underlying Telnyx number
//          (not just the VAPI object) so the monthly rental actually stops.
// UPDATED: 2026-07-27 - International demo support. US agencies still get a
//          platform Telnyx number (provisionAgencyDemo, unchanged). Non-US
//          agencies get a demo line on their OWN Twilio (BYOT), mirroring the
//          client receptionist path: buy on the agency's Twilio in
//          agency.country (via the same provisionBYOTNumber), import into VAPI,
//          then flip the VAPI phone to dynamic assistant-request mode
//          (assistantId null + serverUrl) so the same dynamic demo config
//          answers. DELETE now also releases the number from the agency's
//          Twilio (fullyReleaseNumber only covers VAPI + platform Telnyx).
// UPDATED: 2026-08-04 - Demo creation is now ASYNC. Provisioning a non-US
//          number does a real Twilio purchase + VAPI import serially, which
//          could take long enough that the DigitalOcean gateway cut the
//          connection before the route could answer. The browser then showed
//          "Failed to connect to server" (its network-error path), the friendly
//          error never reached it, and because the request was killed mid-flight
//          the rollback never ran, orphaning the demo assistant. The POST now
//          validates, kicks provisioning off in the background, and returns 202
//          immediately. A new GET .../demo-phone/status lets the UI poll until
//          the number appears (success is read from the agency row, so it
//          survives a process restart) or an error is recorded. The error
//          status is held in memory per agency; if the process restarts before
//          the UI polls, status falls back to 'idle' and the UI stops on its
//          own timeout and tells the user to refresh.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { provisionAgencyDemo, updateDemoAssistantName, fullyReleaseNumber, createDemoAssistant } = require('../lib/vapi');
const { provisionBYOTNumber, releaseBYOTNumber } = require('./byot');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.voiceaiconnect.com';

// ============================================================================
// IN-MEMORY DEMO PROVISIONING JOBS
// ----------------------------------------------------------------------------
// agencyId -> { status: 'provisioning' | 'error' | 'done', error, startedAt }
// Success is authoritative from the agency row (demo_phone_number), so this map
// only needs to carry the "provisioning" and "error" states between the async
// POST and the status poll. Entries are short-lived; a stale one is ignored
// once older than _DEMO_JOB_TTL. Single-instance safe; on multi-instance the
// success path still works via the DB, and the error path degrades to the UI's
// own poll timeout.
// ============================================================================
const _demoJobs = new Map();
const _DEMO_JOB_TTL = 10 * 60 * 1000;

// ============================================================================
// HELPER: Check if agency has access (paid or trial)
// ============================================================================
function hasAccess(agency) {
  const allowedStatuses = ['active', 'trial', 'trialing'];
  return allowedStatuses.includes(agency.subscription_status);
}

// ============================================================================
// HELPER: agency has usable Twilio (BYOT) credentials
// ============================================================================
function hasByotCredentials(agency) {
  return !!(agency.byot_enabled && agency.twilio_account_sid && agency.twilio_api_key_encrypted);
}

// ============================================================================
// HELPER: best-effort delete of a VAPI assistant (rollback on failed provision)
// ============================================================================
async function deleteVapiAssistant(assistantId) {
  if (!assistantId) return;
  try {
    const res = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`⚠️ [BYOT demo] assistant cleanup returned ${res.status} for ${assistantId}`);
    }
  } catch (err) {
    console.warn(`⚠️ [BYOT demo] assistant cleanup error for ${assistantId}:`, err.message);
  }
}

// ============================================================================
// HELPER: map an internal provisioning error to a readable, actionable message
// ============================================================================
function friendlyDemoProvisioningError(err, country) {
  const msg = (err && err.message) || '';
  if (/regulatory bundle/i.test(msg)) {
    return `Twilio requires an approved regulatory bundle for ${country} before it will sell a number. Complete your ${country} bundle in the Twilio Console, then try again.`;
  }
  if (/no (phone )?numbers? available/i.test(msg) || /no numbers available/i.test(msg)) {
    return `No local numbers are currently available in ${country} on your Twilio account. Try again shortly, or check availability in your Twilio Console.`;
  }
  if (/does not have Twilio credentials/i.test(msg)) {
    return 'Connect your Twilio account in Settings, Twilio to create an international demo line.';
  }
  if (/VAPI import failed/i.test(msg)) {
    return `Your ${country} number was purchased on Twilio but could not be linked to the AI. Please try again, or contact support if it keeps happening.`;
  }
  return `Could not create your demo line in ${country}. ${msg.slice(0, 160)}`;
}

// ============================================================================
// INTERNATIONAL DEMO PROVISIONING (agency's own Twilio, BYOT)
// ----------------------------------------------------------------------------
// The platform path (provisionAgencyDemo in lib/vapi.js) buys a US number on
// the PLATFORM Telnyx account and only searches US inventory, so it cannot
// serve a non-US agency. Here we mirror the client receptionist path: buy the
// number on the AGENCY'S OWN Twilio (the same provisionBYOTNumber used at
// client signup), import it into VAPI, then flip the VAPI phone into dynamic
// assistant-request mode (assistantId null + serverUrl), exactly like the US
// demo does, so the dynamic demo config (with the post-call SMS tool) answers
// rather than the static fallback assistant.
//
// provisionBYOTNumber imports the number bound to the demo assistant AND with a
// serverUrl. We then PATCH assistantId to null so VAPI fetches the assistant
// dynamically per call (this is what carries the send_demo_sms tool). See the
// same PATCH in provisionAgencyDemo.
//
// Country comes from agency.country (the same field the client path keys on).
// The number is bought as a Local number in that country; the agency must have
// an approved Twilio regulatory bundle for that country or Twilio rejects the
// order (surfaced to the caller as a clear message by the route).
//
// Rollback: on any failure after the assistant is created, the orphaned VAPI
// assistant is deleted. provisionBYOTNumber now releases a purchased-but-not-
// imported number itself, so the only cleanup left here is the assistant. If
// the number is bought and imported but the DB write fails, the number is
// released from BOTH VAPI and the agency's Twilio so it does not leak.
// ============================================================================
async function provisionAgencyDemoBYOT(agency) {
  const country = (agency.country || '').toUpperCase();
  console.log(`📞 [BYOT demo] Provisioning demo for ${agency.name} in ${country} via agency Twilio`);

  // 1. Create the demo assistant (the id we store and later delete).
  const assistant = await createDemoAssistant(agency.name);

  // 2. Buy on the agency's Twilio + import into VAPI (reuses the tested client
  //    BYOT path). Bound to the demo assistant on import; we switch it to
  //    dynamic mode next. No area code: take any Local number in the country.
  let byot;
  try {
    byot = await provisionBYOTNumber(agency, {
      countryCode: country,
      areaCode: null,
      assistantId: assistant.id,
      businessName: `${agency.name} Demo`,
    });
  } catch (err) {
    // Buy/import failed. Delete the orphaned assistant so nothing leaks.
    await deleteVapiAssistant(assistant.id);
    throw err; // surfaced by the route and mapped to a friendly message
  }

  // 3. Flip the VAPI phone to dynamic assistant-request mode, identical to the
  //    US demo PATCH: assistantId null so VAPI fetches the dynamic demo config
  //    from our serverUrl on every call. If this PATCH fails the number still
  //    answers with the static demo assistant it was imported with, so we log
  //    and continue rather than tear a working number down.
  try {
    const patchRes = await fetch(`https://api.vapi.ai/phone-number/${byot.vapiPhoneId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistantId: null, serverUrl: `${BACKEND_URL}/webhook/vapi` }),
    });
    if (patchRes.ok) {
      console.log('✅ [BYOT demo] Phone set to dynamic assistant-request (assistantId null, serverUrl set)');
    } else {
      const t = await patchRes.text().catch(() => '');
      console.error(`⚠️ [BYOT demo] dynamic-mode PATCH failed (HTTP ${patchRes.status}): ${t.slice(0, 200)}. Number still answers with the static demo assistant.`);
    }
  } catch (whErr) {
    console.warn('⚠️ [BYOT demo] dynamic-mode PATCH error (non-blocking):', whErr.message);
  }

  // 4. Persist on the agency row (same three columns the US path uses).
  const { error: updateError } = await supabase
    .from('agencies')
    .update({
      demo_phone_number: byot.number,
      demo_assistant_id: assistant.id,
      demo_vapi_phone_id: byot.vapiPhoneId,
    })
    .eq('id', agency.id);

  if (updateError) {
    // Could not record the number. Release it from BOTH VAPI and the agency's
    // Twilio so we do not leak a billable line, delete the assistant, and fail.
    console.error('❌ [BYOT demo] Failed to save demo number, releasing it:', updateError.message);
    try { await fullyReleaseNumber(byot.vapiPhoneId, byot.number); } catch (e) { console.warn('⚠️ VAPI/Telnyx release failed:', e.message); }
    try { await releaseBYOTNumber(agency, byot.number); } catch (e) { console.warn('⚠️ Twilio release failed:', e.message); }
    await deleteVapiAssistant(assistant.id);
    throw updateError;
  }

  console.log(`🎉 [BYOT demo] Demo provisioning complete for ${agency.name}: ${byot.number}`);

  // Shape matches provisionAgencyDemo's return so the route handles both paths
  // identically.
  return { phoneNumber: byot.number, assistantId: assistant.id, phoneId: byot.vapiPhoneId };
}

// ============================================================================
// BACKGROUND RUNNER
// ----------------------------------------------------------------------------
// Runs the actual provisioning after the POST has already answered 202. Never
// throws out of here: it records the outcome (done / error) in _demoJobs so the
// status poll can report it. On success the agency row already carries the
// number (written inside the provision functions), which is the durable source
// of truth the status poll reads first.
// ============================================================================
async function runDemoProvisioning({ agency, country, finalAreaCode }) {
  const agencyId = agency.id;
  try {
    let result;
    if (country === 'US') {
      result = await provisionAgencyDemo(agencyId, agency.name, finalAreaCode);
      // provisionAgencyDemo swallows its real error and returns null on failure.
      if (!result || !result.phoneNumber) {
        throw new Error('Failed to create demo phone. Please try again or contact support.');
      }
    } else {
      result = await provisionAgencyDemoBYOT(agency);
    }
    _demoJobs.set(agencyId, { status: 'done', error: null, startedAt: Date.now() });
    console.log(`🎉 [demo async] Demo phone created for ${agency.name}: ${result.phoneNumber}`);
  } catch (err) {
    const message = country === 'US'
      ? (err.message || 'Failed to create demo phone. Please try again.')
      : friendlyDemoProvisioningError(err, country);
    _demoJobs.set(agencyId, { status: 'error', error: message, startedAt: Date.now() });
    console.error(`❌ [demo async] Provisioning failed for ${agency.name}:`, err.message);
  }
}

// ============================================================================
// CREATE DEMO PHONE (async)
// POST /:agencyId/demo-phone
// Body: { area_code: "305" } (US only; optional, defaults to agency phone or 404)
// Returns 202 immediately; the UI polls GET /:agencyId/demo-phone/status.
// ============================================================================
router.post('/:agencyId/demo-phone', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { area_code } = req.body;

    // 1. Fetch agency
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // 2. Check access - paid or trial
    if (!hasAccess(agency)) {
      return res.status(403).json({
        error: 'Subscription required',
        message: 'Demo phone numbers require an active subscription or trial. Please subscribe to create your demo line.'
      });
    }

    // 3. Check if demo already exists
    if (agency.demo_phone_number) {
      return res.status(409).json({
        error: 'Demo already exists',
        message: 'You already have a demo phone number. Delete it first to create a new one.',
        demo_phone_number: agency.demo_phone_number
      });
    }

    // 3b. Already provisioning? Re-acknowledge instead of starting a second run.
    const existingJob = _demoJobs.get(agencyId);
    if (existingJob && existingJob.status === 'provisioning' && (Date.now() - existingJob.startedAt) < _DEMO_JOB_TTL) {
      return res.status(202).json({ success: true, status: 'provisioning' });
    }

    // 4. Country decides the provisioning path. US uses the platform Telnyx
    //    account; every other country uses the agency's own Twilio (BYOT).
    const country = (agency.country || 'US').toUpperCase();

    // 4a. International: require BYOT credentials up front so we fail fast with
    //     a clear message instead of starting a doomed background job.
    if (country !== 'US' && !hasByotCredentials(agency)) {
      return res.status(400).json({
        error: 'twilio_required',
        message: `Your agency is set to ${country}. To create a demo line outside the US, connect your own Twilio account in Settings, Twilio (and complete the regulatory bundle for ${country}). Then try again.`,
        country
      });
    }

    // 4b. US: resolve the area code synchronously (validation, not slow work).
    let finalAreaCode = '404';
    if (country === 'US') {
      if (area_code && /^\d{3}$/.test(area_code)) {
        finalAreaCode = area_code;
      } else if (agency.phone) {
        const digits = agency.phone.replace(/\D/g, '');
        const tenDigits = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
        if (tenDigits.length === 10) {
          finalAreaCode = tenDigits.slice(0, 3);
        }
      }
    }

    // 5. Mark provisioning and answer immediately. The heavy work (Twilio
    //    purchase, VAPI import) then runs in the background so the request
    //    can never be cut by a gateway timeout mid-provision.
    _demoJobs.set(agencyId, { status: 'provisioning', error: null, startedAt: Date.now() });

    console.log(`📞 Starting ${country} demo provisioning for ${agency.name}${country === 'US' ? ` (area code ${finalAreaCode})` : ' via agency Twilio (BYOT)'}`);

    res.status(202).json({ success: true, status: 'provisioning', country });

    // Fire-and-forget. runDemoProvisioning never throws; it records the result
    // in _demoJobs for the status poll.
    runDemoProvisioning({ agency, country, finalAreaCode });

  } catch (error) {
    console.error('❌ Create demo phone error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create demo phone' });
    }
  }
});

// ============================================================================
// DEMO PHONE STATUS (poll target for the async create)
// GET /:agencyId/demo-phone/status
// -> { status: 'done', demo_phone_number } when the number is live
// -> { status: 'error', message }         when provisioning failed
// -> { status: 'provisioning' }           while it is still running
// -> { status: 'idle' }                   when nothing is in flight
// Success is read from the agency row first, so it is correct even if the
// process restarted after provisioning finished.
// ============================================================================
router.get('/:agencyId/demo-phone/status', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: agency } = await supabase
      .from('agencies')
      .select('demo_phone_number')
      .eq('id', agencyId)
      .single();

    if (agency && agency.demo_phone_number) {
      _demoJobs.delete(agencyId);
      return res.json({ status: 'done', demo_phone_number: agency.demo_phone_number });
    }

    const job = _demoJobs.get(agencyId);
    if (job && job.status === 'error') {
      return res.json({ status: 'error', message: job.error });
    }
    if (job && job.status === 'provisioning' && (Date.now() - job.startedAt) < _DEMO_JOB_TTL) {
      return res.json({ status: 'provisioning' });
    }

    return res.json({ status: 'idle' });
  } catch (error) {
    console.error('❌ Demo phone status error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to check demo status' });
  }
});

// ============================================================================
// DELETE DEMO PHONE
// DELETE /:agencyId/demo-phone
// Removes VAPI assistant + phone number + clears DB fields
// ============================================================================
router.delete('/:agencyId/demo-phone', async (req, res) => {
  try {
    const { agencyId } = req.params;

    // 1. Fetch agency. Include Twilio fields so a BYOT demo number can be
    //    released from the agency's own Twilio, not just VAPI + platform Telnyx.
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('id, name, demo_phone_number, demo_assistant_id, demo_vapi_phone_id, byot_enabled, twilio_account_sid, twilio_api_key_encrypted, twilio_api_secret_encrypted, country')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.demo_phone_number) {
      return res.status(404).json({ error: 'No demo phone to delete' });
    }

    console.log(`🗑️ Deleting demo phone for ${agency.name}: ${agency.demo_phone_number}`);

    // Clear any stale job state for this agency.
    _demoJobs.delete(agencyId);

    // 2. Release the demo number - VAPI object AND the underlying Telnyx rental.
    //    Deleting only the VAPI object leaves the Telnyx number billing monthly.
    if (agency.demo_vapi_phone_id || agency.demo_phone_number) {
      try {
        const release = await fullyReleaseNumber(agency.demo_vapi_phone_id, agency.demo_phone_number);
        console.log(`📞 Demo release ${agency.name}: VAPI=${release.vapiDeleted} Telnyx=${release.telnyxReleased}`);
      } catch (err) {
        console.warn('⚠️ Demo number release error (continuing):', err.message);
      }

      // If this was an international (BYOT) demo, the real carrier number lives
      // on the AGENCY'S Twilio, which fullyReleaseNumber does not touch. Release
      // it there too so it stops billing. No-op if it is not on their Twilio.
      if (hasByotCredentials(agency)) {
        try {
          await releaseBYOTNumber(agency, agency.demo_phone_number);
        } catch (err) {
          console.warn('⚠️ Demo Twilio release error (continuing):', err.message);
        }
      }
    }

    // 3. Delete VAPI assistant
    if (agency.demo_assistant_id) {
      try {
        const assistantResponse = await fetch(`https://api.vapi.ai/assistant/${agency.demo_assistant_id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (assistantResponse.ok) {
          console.log('✅ VAPI demo assistant deleted');
        } else {
          console.warn('⚠️ Failed to delete VAPI assistant (continuing):', assistantResponse.status);
        }
      } catch (err) {
        console.warn('⚠️ VAPI assistant delete error (continuing):', err.message);
      }
    }

    // 4. Clear DB fields
    const { error: updateError } = await supabase
      .from('agencies')
      .update({
        demo_phone_number: null,
        demo_assistant_id: null,
        demo_vapi_phone_id: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', agencyId);

    if (updateError) {
      console.error('❌ Failed to clear demo fields:', updateError);
      return res.status(500).json({ error: 'Failed to update agency record' });
    }

    console.log(`✅ Demo phone deleted for ${agency.name}`);

    res.json({
      success: true,
      message: 'Demo phone number deleted successfully'
    });

  } catch (error) {
    console.error('❌ Delete demo phone error:', error);
    res.status(500).json({ error: 'Failed to delete demo phone' });
  }
});

// ============================================================================
// LIST DEMO CALLS
// GET /:agencyId/demo-calls
// Returns paginated demo call history for the agency
// Query params: limit (default 20), offset (default 0)
// ============================================================================
router.get('/:agencyId/demo-calls', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;

    // Get total count
    const { count, error: countError } = await supabase
      .from('demo_calls')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId);

    if (countError) {
      console.error('Demo calls count error:', countError);
      return res.status(400).json({ error: countError.message });
    }

    // Fetch calls
    const { data: calls, error } = await supabase
      .from('demo_calls')
      .select('id, caller_phone, caller_name, business_name, business_type, interest_level, service_discussed, asked_questions, summary, duration_seconds, industry_key, caller_location, recording_url, created_at')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Demo calls fetch error:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({
      success: true,
      calls: calls || [],
      total: count || 0,
      limit,
      offset,
    });
  } catch (error) {
    console.error('❌ List demo calls error:', error);
    res.status(500).json({ error: 'Failed to fetch demo calls' });
  }
});

// ============================================================================
// GET DEMO CALL DETAIL
// GET /:agencyId/demo-calls/:callId
// Returns full demo call data including transcript
// ============================================================================
router.get('/:agencyId/demo-calls/:callId', async (req, res) => {
  try {
    const { agencyId, callId } = req.params;

    const { data: call, error } = await supabase
      .from('demo_calls')
      .select('*')
      .eq('id', callId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !call) {
      return res.status(404).json({ error: 'Demo call not found' });
    }

    res.json({ success: true, call });
  } catch (error) {
    console.error('❌ Get demo call error:', error);
    res.status(500).json({ error: 'Failed to fetch demo call' });
  }
});

module.exports = router;