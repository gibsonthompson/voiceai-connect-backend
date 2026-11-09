// ============================================================================
// TEST CLIENT PROVISIONING
// Creates a demo AI receptionist for the agency to experience firsthand.
// is_test_client = true → excluded from per-client billing.
// Voice minutes are still tracked (agency eats the cost as acquisition cost).
//
// UPDATED: 2026-09-17 — SECURITY: added top-of-router ownership guards. Every
//          route is scoped by :agencyId but had no ownership check, so an
//          authenticated agency could provision (buying a real number on the
//          victim's account), read, or tear down another agency's test client.
//          requireAgencyAccess('clients') enforces valid token + caller owns
//          :agencyId. The paid-plan gate inside provisioning still runs after.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase, getAgencyById } = require('../lib/supabase');
const { 
  createIndustryAssistant, 
  provisionLocalPhone,
  fullyReleaseNumber,
} = require('../lib/vapi');
const { timezoneFromPhone } = require('../lib/area-code-timezone');
const { formatPhoneE164 } = require('../lib/notifications');
const { requireAgencyAccess } = require('./auth');

// ----------------------------------------------------------------------------
// OWNERSHIP GUARDS — two prefixes ("provision-test-client" and "test-client"
// are different path roots). Registered before the routes below.
// ----------------------------------------------------------------------------
router.use('/:agencyId/provision-test-client', requireAgencyAccess('clients'));
router.use('/:agencyId/test-client', requireAgencyAccess('clients'));

// Max minutes for test clients (prevents abuse)
const TEST_CLIENT_CALL_LIMIT = 30;

// ============================================================================
// POST /api/agency/:agencyId/provision-test-client
// Idempotent - returns existing test client if already provisioned
// ============================================================================
router.post('/:agencyId/provision-test-client', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const agency = await getAgencyById(agencyId);
    if (!agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Idempotent: if test client already exists, return it
    if (agency.test_client_id) {
      const { data: existing } = await supabase
        .from('clients')
        .select('id, business_name, vapi_phone_number, status, is_test_client')
        .eq('id', agency.test_client_id)
        .single();

      if (existing) {
        console.log(`✅ Test client already exists for ${agency.name}: ${existing.business_name}`);
        return res.json({ 
          success: true, 
          already_exists: true,
          client: existing,
        });
      }
    }

    // ------------------------------------------------------------------------
    // PAID-PLAN GATE
    // Provisioning a test client buys a real phone number (a monthly Telnyx
    // rental), so Test AI is a paid-plan feature. Free-plan agencies are
    // blocked here at the source so we never buy a number we would only have to
    // sweep later. plan_type is read directly from the row so this does not
    // depend on getAgencyById's column selection. An agency that already has a
    // test client is returned above, so this only ever blocks NEW provisioning.
    // ------------------------------------------------------------------------
    const { data: planRow } = await supabase
      .from('agencies')
      .select('plan_type')
      .eq('id', agencyId)
      .single();
    const planType = String(planRow?.plan_type || '').toLowerCase();
    if (planType === 'free') {
      console.log(`⛔ Test client blocked for ${agency.name}: free plan`);
      return res.status(403).json({
        error: 'upgrade_required',
        upgrade_required: true,
        feature: 'test_ai',
        current_plan: 'free',
        title: 'Test AI is a paid feature',
        message: 'Spin up a live test receptionist so you can hear your AI before you sell it. Upgrade to Pro or Scale to unlock your own test line.',
        cta: 'Upgrade to unlock Test AI',
      });
    }

    console.log(`🧪 Provisioning test client for agency: ${agency.name}`);

    // Seed from the receptionist the owner built on the marketing demo, if one
    // was carried through signup (agencies.pending_test_client). Falls back to
    // the generic plumbing default when there is no seed.
    const { data: seedRow } = await supabase
      .from('agencies')
      .select('pending_test_client')
      .eq('id', agencyId)
      .single();
    const seed = (seedRow && seedRow.pending_test_client && typeof seedRow.pending_test_client === 'object')
      ? seedRow.pending_test_client : null;
    const seedFacts = Array.isArray(seed?.facts) ? seed.facts.filter(Boolean).map((f) => String(f)) : [];
    const seedKnowledge = seedFacts.length
      ? { websiteContent: `Key facts about ${seed.business_name || 'the business'}:\n` + seedFacts.map((f) => `- ${f}`).join('\n') }
      : null;

    const testBusinessName = seed?.business_name ? String(seed.business_name).slice(0, 120) : `${agency.name} - Test Business`;
    const testIndustry = seed?.industry ? String(seed.industry).slice(0, 60) : 'plumbing';
    const agencyCountry = (agency.country || 'US').toUpperCase();
    const agencyPhone = agency.phone ? formatPhoneE164(agency.phone, agencyCountry) : null;
    // Base the test client's number on the agency's OWN area code (from their phone),
    // not a hardcoded city. That hardcoded 'Atlanta' is why every test client used to
    // get a 404 number regardless of where the agency actually is. Empty city so
    // provisionLocalPhone keys off the phone's area code first; only fall back to a
    // region if the agency has no phone on file at all.
    const agencyCity = '';
    // Fallback region only used when the agency has no phone to key the area code
    // off of. Keep it in-country so a Canadian agency never falls back to a US code.
    const agencyState = agencyPhone ? '' : (agencyCountry === 'CA' ? 'ON' : 'GA');

    // Step 1: Create VAPI assistant. Defaults to plumbing: it's a concrete,
    // high-intent vertical that produces a far sharper test receptionist than the
    // generic 'home_services' catch-all, which is too broad to sound good.
    const assistant = await createIndustryAssistant(
      testBusinessName,
      testIndustry,    // seeded from the demo build, or 'plumbing' default
      seedKnowledge,   // demo facts become the knowledge base, or null
      agencyPhone,
      null,            // no client ID yet
      agencyId
    );
    console.log(`✅ Test assistant created: ${assistant.id}`);

    // Make the provisioned receptionist match what the owner heard on the demo:
    // the same greeting (first thing a caller hears) and the same voice. Done in
    // one PATCH right after creation. Best-effort: a failure leaves the industry
    // default greeting/voice in place.
    const assistantPatch = {};
    if (seed?.greeting) assistantPatch.firstMessage = String(seed.greeting).slice(0, 1000);
    if (seed?.voice && typeof seed.voice === 'object' && seed.voice.voiceId) assistantPatch.voice = seed.voice;
    if (Object.keys(assistantPatch).length) {
      try {
        await fetch(`https://api.vapi.ai/assistant/${assistant.id}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(assistantPatch),
        });
        console.log(`✅ Applied demo ${Object.keys(assistantPatch).join(' + ')} to test assistant`);
      } catch (e) { console.warn('⚠️ demo greeting/voice patch failed:', e.message); }
    }

    // Step 2: Provision phone number
    let phoneNumber = null;
    let vapiPhoneId = null;

    try {
      const phoneData = await provisionLocalPhone(
        agencyCity,
        agencyState,
        assistant.id,
        testBusinessName,
        agencyPhone || '',
        { country: agencyCountry }
      );
      phoneNumber = phoneData.number;
      vapiPhoneId = phoneData.id;

      // Configure webhook - serverUrl only (same as regular clients)
      await fetch(`https://api.vapi.ai/phone-number/${vapiPhoneId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          assistantId: null,
          serverUrl: process.env.BACKEND_URL + '/webhook/vapi',
          serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET
        })
      });

      console.log(`✅ Test phone provisioned: ${phoneNumber}`);
    } catch (phoneErr) {
      console.error('❌ Test phone provisioning failed:', phoneErr.message);
      // Continue without phone - client record still useful
    }

    // Step 3: Create client record
    const { data: testClient, error: clientError } = await supabase
      .from('clients')
      .insert({
        agency_id: agencyId,
        business_name: testBusinessName,
        business_city: agencyCity,
        business_state: agencyState,
        country: agencyCountry,
        phone_number: phoneNumber,
        owner_name: agency.name,
        owner_phone: agencyPhone || agency.phone || '+10000000000',
        timezone: timezoneFromPhone(agency.phone) || null,
        business_hours: {
          monday: { open: '9:00 AM', close: '5:00 PM', closed: false },
          tuesday: { open: '9:00 AM', close: '5:00 PM', closed: false },
          wednesday: { open: '9:00 AM', close: '5:00 PM', closed: false },
          thursday: { open: '9:00 AM', close: '5:00 PM', closed: false },
          friday: { open: '9:00 AM', close: '5:00 PM', closed: false },
          saturday: { open: '9:00 AM', close: '5:00 PM', closed: true },
          sunday: { open: '9:00 AM', close: '5:00 PM', closed: true },
        },
        email: agency.email,
        industry: testIndustry,
        vapi_assistant_id: assistant.id,
        vapi_phone_number: phoneNumber,
        vapi_phone_id: vapiPhoneId,
        status: 'active',
        subscription_status: 'active',
        plan_type: 'growth', // top plan so the test client shows the full feature set
        is_test_client: true,
        monthly_call_limit: TEST_CLIENT_CALL_LIMIT,
        calls_this_month: 0,
      })
      .select()
      .single();

    if (clientError) {
      console.error('❌ Test client record creation failed:', clientError);
      return res.status(500).json({ error: 'Failed to create test client record' });
    }

    // Step 4: Store test_client_id on agency, and clear the demo seed now that
    // it has been materialized into a real test client.
    await supabase
      .from('agencies')
      .update({ test_client_id: testClient.id, pending_test_client: null })
      .eq('id', agencyId);

    console.log(`🧪 Test client provisioned for ${agency.name}: ${testClient.business_name} → ${phoneNumber || 'no phone'}`);

    res.json({
      success: true,
      already_exists: false,
      client: {
        id: testClient.id,
        business_name: testClient.business_name,
        vapi_phone_number: phoneNumber,
        status: 'active',
        is_test_client: true,
      },
    });

  } catch (error) {
    console.error('❌ Test client provisioning error:', error);
    res.status(500).json({ error: 'Failed to provision test client' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/test-client
// Returns the test client data (or null if not provisioned)
// ============================================================================
router.get('/:agencyId/test-client', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: agency } = await supabase
      .from('agencies')
      .select('test_client_id, pending_test_client')
      .eq('id', agencyId)
      .single();

    // The receptionist the owner built on the marketing demo and carried through
    // signup, if any, so the dashboard can show a seeded "Activate" card.
    const pending = (agency && agency.pending_test_client && typeof agency.pending_test_client === 'object')
      ? agency.pending_test_client : null;

    if (!agency?.test_client_id) {
      return res.json({ client: null, pending });
    }

    const { data: client } = await supabase
      .from('clients')
      .select('id, business_name, vapi_phone_number, status, is_test_client, calls_this_month, monthly_call_limit')
      .eq('id', agency.test_client_id)
      .single();

    // Live monthly call count (calls table is the source of truth).
    if (client) {
      try {
        const { callsThisMonthForClient } = require('../lib/call-usage');
        client.calls_this_month = await callsThisMonthForClient(client.id);
      } catch (e) { console.warn('live calls_this_month enrich failed:', e.message); }
    }

    res.json({ client: client || null, pending });

  } catch (error) {
    console.error('Error fetching test client:', error);
    res.status(500).json({ error: 'Failed to fetch test client' });
  }
});

// ============================================================================
// DELETE /api/agency/:agencyId/test-client
// Full teardown of an agency's test client so a fresh one can be provisioned.
// Releases the phone number (VAPI object + Telnyx rental → STOPS the monthly
// bill), deletes the VAPI assistant, clears agency.test_client_id, and removes
// the client row. Deleting the row alone would orphan the Telnyx number (keeps
// billing), so this endpoint exists to do it correctly in one shot.
// Only ever touches is_test_client rows; never the agency demo number and never
// a real client.
// ============================================================================
router.delete('/:agencyId/test-client', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const agency = await getAgencyById(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    // Find the test client: prefer the pointer, fall back to a scan so a
    // mispointed or duplicate test client still gets cleaned up.
    const cols = 'id, business_name, vapi_phone_id, vapi_phone_number, vapi_assistant_id';
    let testClient = null;
    if (agency.test_client_id) {
      const { data } = await supabase
        .from('clients').select(cols)
        .eq('id', agency.test_client_id)
        .eq('is_test_client', true)
        .maybeSingle();
      testClient = data || null;
    }
    if (!testClient) {
      const { data } = await supabase
        .from('clients').select(cols)
        .eq('agency_id', agencyId)
        .eq('is_test_client', true)
        .limit(1)
        .maybeSingle();
      testClient = data || null;
    }

    if (!testClient) {
      // Nothing to remove; just make sure the pointer is clear so re-provision works.
      if (agency.test_client_id) {
        await supabase.from('agencies').update({ test_client_id: null }).eq('id', agencyId);
      }
      return res.json({ success: true, message: 'No test client to remove', released: null });
    }

    // 1) Release the phone number (VAPI phone object + Telnyx rental).
    let release = { vapiDeleted: false, telnyxReleased: false };
    if (testClient.vapi_phone_id || testClient.vapi_phone_number) {
      try {
        release = await fullyReleaseNumber(testClient.vapi_phone_id, testClient.vapi_phone_number);
        console.log(`📞 Test client release ${testClient.business_name}: VAPI=${release.vapiDeleted} Telnyx=${release.telnyxReleased}`);
        if (!release.telnyxReleased && testClient.vapi_phone_number) {
          console.error(`⚠️ Telnyx NOT released for test client ${testClient.business_name} (${testClient.vapi_phone_number}); reconcile-telnyx sweep is the backstop`);
        }
      } catch (relErr) {
        console.error('❌ Test client number release failed:', relErr.message);
      }
    }

    // 2) Delete the VAPI assistant.
    if (testClient.vapi_assistant_id && process.env.VAPI_API_KEY) {
      try {
        const asstRes = await fetch(`https://api.vapi.ai/assistant/${testClient.vapi_assistant_id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}` },
        });
        if (asstRes.ok || asstRes.status === 404) {
          console.log('✅ Test client VAPI assistant deleted:', testClient.vapi_assistant_id);
        } else {
          console.warn(`⚠️ VAPI assistant delete returned ${asstRes.status} for ${testClient.vapi_assistant_id}`);
        }
      } catch (asstErr) {
        console.error('❌ VAPI assistant delete error:', asstErr.message);
      }
    }

    // 3) Clear the agency pointer FIRST so the row delete never trips an FK.
    await supabase.from('agencies').update({ test_client_id: null }).eq('id', agencyId);

    // 4) Delete the test client row (guarded to is_test_client so a real client
    //    can never be removed through this path).
    const { error: delErr } = await supabase
      .from('clients').delete()
      .eq('id', testClient.id)
      .eq('is_test_client', true);
    if (delErr) {
      console.error('❌ Test client row delete failed:', delErr.message);
      return res.status(500).json({ error: 'Failed to delete test client row', released: release });
    }

    console.log(`🧹 Test client reset for ${agency.name}: ${testClient.business_name} removed`);
    return res.json({
      success: true,
      message: 'Test client removed. Provision a fresh one whenever you are ready.',
      released: {
        number: testClient.vapi_phone_number || null,
        vapiDeleted: release.vapiDeleted,
        telnyxReleased: release.telnyxReleased,
        billingStopped: release.telnyxReleased,
      },
    });
  } catch (error) {
    console.error('❌ Test client reset error:', error);
    return res.status(500).json({ error: error.message || 'Reset failed' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/test-client/convert
// Promote the agency's test client into a real, billable client IN PLACE.
//
// Why in place (not a copy): the prospect has been calling the test client's
// number, so keeping the same number, assistant, knowledge base, services and
// call history is the whole point. The business keeps the line it already
// knows, and nothing has to be rebuilt.
//
// What changes:
//   - is_test_client false         → now counts as a real client, billed, and
//                                     never swept by expire-test-clients.
//   - monthly_call_limit lifted     → off the 30-minute test cap, onto the
//                                     agency's real per-plan limit.
//   - subscription_status 'manual'  → lands in the standard manual-billing
//     billing_mode 'manual'           state (a first-class, supported state).
//                                     No card is charged and nothing auto-bills:
//                                     the agency collects payment through the
//                                     normal client billing controls afterward.
//   - usage_resets_at +1 month      → the monthly cap-reset cron picks it up.
//   - calls_this_month 0            → fresh billing month for a real client.
//
// The agency's test_client_id pointer is cleared so the slot frees up and a
// brand-new test client can be provisioned for the next prospect. The number is
// NOT released (that is the opposite of what we want here).
//
// Guarded to is_test_client=true, so a real client can never be touched through
// this path, and a second call is a no-op 404 (the row is no longer a test client).
// ============================================================================
router.post('/:agencyId/test-client/convert', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const agency = await getAgencyById(agencyId);
    if (!agency) return res.status(404).json({ error: 'Agency not found' });

    // Find the test client: prefer the pointer, fall back to a scan.
    const cols = 'id, business_name, vapi_phone_number, plan_type, is_test_client';
    let testClient = null;
    if (agency.test_client_id) {
      const { data } = await supabase
        .from('clients').select(cols)
        .eq('id', agency.test_client_id)
        .eq('is_test_client', true)
        .maybeSingle();
      testClient = data || null;
    }
    if (!testClient) {
      const { data } = await supabase
        .from('clients').select(cols)
        .eq('agency_id', agencyId)
        .eq('is_test_client', true)
        .limit(1)
        .maybeSingle();
      testClient = data || null;
    }

    if (!testClient) {
      return res.status(404).json({ error: 'No test client to convert' });
    }

    // Real per-plan call limit for this client's plan, read straight off the
    // agency row (getAgencyById may not select the limit_* columns).
    const planType = String(testClient.plan_type || 'starter').toLowerCase();
    const limitKey = `limit_${planType}`;
    const { data: limRow } = await supabase
      .from('agencies')
      .select(`${limitKey}, limit_starter`)
      .eq('id', agencyId)
      .single();
    const callLimit = (limRow && limRow[limitKey] != null)
      ? limRow[limitKey]
      : (limRow?.limit_starter ?? 50);

    // One month out so the monthly cap-reset cron refreshes usage.
    const resetAt = new Date();
    resetAt.setMonth(resetAt.getMonth() + 1);

    const { data: updated, error: updErr } = await supabase
      .from('clients')
      .update({
        is_test_client: false,
        subscription_status: 'manual',
        billing_mode: 'manual',
        status: 'active',
        trial_ends_at: null,
        usage_resets_at: resetAt.toISOString(),
        monthly_call_limit: callLimit,
        calls_this_month: 0,
      })
      .eq('id', testClient.id)
      .eq('is_test_client', true)
      .select('id, business_name, vapi_phone_number, industry')
      .single();

    if (updErr) {
      console.error('❌ Test client convert failed:', updErr.message);
      return res.status(500).json({ error: 'Failed to convert test client' });
    }

    // Free the test slot so a fresh test client can be provisioned next.
    await supabase.from('agencies').update({ test_client_id: null }).eq('id', agencyId);

    console.log(`⬆️ Test client converted to real client for ${agency.name}: ${updated.business_name} (${updated.vapi_phone_number || 'no number'})`);

    return res.json({
      success: true,
      message: 'Test client converted to a real client. Set up billing for it whenever you are ready.',
      client: {
        id: updated.id,
        business_name: updated.business_name,
        vapi_phone_number: updated.vapi_phone_number || null,
        industry: updated.industry || null,
        is_test_client: false,
      },
    });
  } catch (error) {
    console.error('❌ Test client convert error:', error);
    return res.status(500).json({ error: error.message || 'Convert failed' });
  }
});

module.exports = router;