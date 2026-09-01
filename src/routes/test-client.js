// ============================================================================
// TEST CLIENT PROVISIONING
// Creates a demo AI receptionist for the agency to experience firsthand.
// is_test_client = true → excluded from per-client billing.
// Voice minutes are still tracked (agency eats the cost as acquisition cost).
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase, getAgencyById } = require('../lib/supabase');
const { 
  createIndustryAssistant, 
  provisionLocalPhone,
} = require('../lib/vapi');
const { timezoneFromPhone } = require('../lib/area-code-timezone');
const { formatPhoneE164 } = require('../lib/notifications');

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

    const testBusinessName = `${agency.name} - Test Business`;
    const agencyCountry = (agency.country || 'US').toUpperCase();
    const agencyPhone = agency.phone ? formatPhoneE164(agency.phone, agencyCountry) : null;
    // Base the test client's number on the agency's OWN area code (from their phone),
    // not a hardcoded city. That hardcoded 'Atlanta' is why every test client used to
    // get a 404 number regardless of where the agency actually is. Empty city so
    // provisionLocalPhone keys off the phone's area code first; only fall back to a
    // region if the agency has no phone on file at all.
    const agencyCity = '';
    const agencyState = agencyPhone ? '' : 'GA';

    // Step 1: Create VAPI assistant (general industry)
    const assistant = await createIndustryAssistant(
      testBusinessName,
      'home_services', // default test client industry
      null,            // no knowledge base
      agencyPhone,
      null,            // no client ID yet
      agencyId
    );
    console.log(`✅ Test assistant created: ${assistant.id}`);

    // Step 2: Provision phone number
    let phoneNumber = null;
    let vapiPhoneId = null;

    try {
      const phoneData = await provisionLocalPhone(
        agencyCity,
        agencyState,
        assistant.id,
        testBusinessName,
        agencyPhone || ''
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
          serverUrl: process.env.BACKEND_URL + '/webhook/vapi'
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
        owner_phone: agency.phone || null,
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
        industry: 'home_services',
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

    // Step 4: Store test_client_id on agency
    await supabase
      .from('agencies')
      .update({ test_client_id: testClient.id })
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
      .select('test_client_id')
      .eq('id', agencyId)
      .single();

    if (!agency?.test_client_id) {
      return res.json({ client: null });
    }

    const { data: client } = await supabase
      .from('clients')
      .select('id, business_name, vapi_phone_number, status, is_test_client, calls_this_month, monthly_call_limit')
      .eq('id', agency.test_client_id)
      .single();

    res.json({ client: client || null });

  } catch (error) {
    console.error('Error fetching test client:', error);
    res.status(500).json({ error: 'Failed to fetch test client' });
  }
});

module.exports = router;