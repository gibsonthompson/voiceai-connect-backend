// ============================================================================
// DEMO PHONE ROUTES
// POST   /api/agency/:agencyId/demo-phone         — Create demo phone
// DELETE /api/agency/:agencyId/demo-phone         — Remove demo phone
// GET    /api/agency/:agencyId/demo-calls         — List demo calls
// GET    /api/agency/:agencyId/demo-calls/:callId — Get demo call detail
// UPDATED: 2026-05-20 — Added demo call history endpoints
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { provisionAgencyDemo, updateDemoAssistantName } = require('../lib/vapi');

const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================================================================
// HELPER: Check if agency has access (paid or trial)
// ============================================================================
function hasAccess(agency) {
  const allowedStatuses = ['active', 'trial', 'trialing'];
  return allowedStatuses.includes(agency.subscription_status);
}

// ============================================================================
// CREATE DEMO PHONE
// POST /:agencyId/demo-phone
// Body: { area_code: "305" } (optional, defaults to first 3 digits of agency phone or 404)
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

    // 2. Check access — paid or trial
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

    // 4. Determine area code
    let finalAreaCode = '404'; // Default

    if (area_code && /^\d{3}$/.test(area_code)) {
      finalAreaCode = area_code;
    } else if (agency.phone) {
      // Extract area code from agency phone
      const digits = agency.phone.replace(/\D/g, '');
      const tenDigits = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
      if (tenDigits.length === 10) {
        finalAreaCode = tenDigits.slice(0, 3);
      }
    }

    console.log(`📞 Creating demo phone for ${agency.name} with area code ${finalAreaCode}`);

    // 5. Provision (creates VAPI assistant + buys number + saves to DB)
    const result = await provisionAgencyDemo(agencyId, agency.name, finalAreaCode);

    if (!result) {
      return res.status(500).json({
        error: 'Provisioning failed',
        message: 'Failed to create demo phone. Please try again or contact support.'
      });
    }

    console.log(`🎉 Demo phone created for ${agency.name}: ${result.phoneNumber}`);

    res.json({
      success: true,
      demo_phone_number: result.phoneNumber,
      demo_assistant_id: result.assistantId,
      demo_vapi_phone_id: result.phoneId,
      area_code: finalAreaCode
    });

  } catch (error) {
    console.error('❌ Create demo phone error:', error);
    res.status(500).json({ error: 'Failed to create demo phone' });
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

    // 1. Fetch agency
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('id, name, demo_phone_number, demo_assistant_id, demo_vapi_phone_id')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    if (!agency.demo_phone_number) {
      return res.status(404).json({ error: 'No demo phone to delete' });
    }

    console.log(`🗑️ Deleting demo phone for ${agency.name}: ${agency.demo_phone_number}`);

    // 2. Delete VAPI phone number
    if (agency.demo_vapi_phone_id) {
      try {
        const phoneResponse = await fetch(`https://api.vapi.ai/phone-number/${agency.demo_vapi_phone_id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` }
        });
        if (phoneResponse.ok) {
          console.log('✅ VAPI phone number deleted');
        } else {
          console.warn('⚠️ Failed to delete VAPI phone (continuing):', phoneResponse.status);
        }
      } catch (err) {
        console.warn('⚠️ VAPI phone delete error (continuing):', err.message);
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