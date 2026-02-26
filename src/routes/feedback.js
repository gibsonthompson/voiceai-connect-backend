// ============================================================================
// AGENCY FEEDBACK ROUTES
// Add to server.js with: app.use('/api/agency', feedbackRoutes);
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

let sendPlatformNotificationSMS;
try {
  ({ sendPlatformNotificationSMS } = require('../notifications'));
} catch (err) {
  console.warn('⚠️ notifications module not found — feedback SMS disabled');
  sendPlatformNotificationSMS = async () => {};
}

// POST /api/agency/:agencyId/feedback
router.post('/:agencyId/feedback', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { message } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (message.length > 2000) {
      return res.status(400).json({ error: 'Message must be under 2000 characters' });
    }

    // Get agency name for the SMS
    const { data: agency, error: agencyError } = await supabase
      .from('agencies')
      .select('name')
      .eq('id', agencyId)
      .single();

    if (agencyError || !agency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    // Save to database
    const { data: feedback, error: insertError } = await supabase
      .from('agency_feedback')
      .insert({
        agency_id: agencyId,
        message: message.trim(),
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to save feedback:', insertError);
      return res.status(500).json({ error: 'Failed to save feedback' });
    }

    // SMS notification to platform owner
    try {
      const truncated = message.trim().substring(0, 300);
      await sendPlatformNotificationSMS(`Feedback from ${agency.name}:\n\n${truncated}`);
    } catch (smsErr) {
      console.error('Failed to send feedback SMS:', smsErr);
    }

    res.json({ success: true, feedback });
  } catch (err) {
    console.error('Feedback route error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/agency/:agencyId/feedback
router.get('/:agencyId/feedback', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data, error } = await supabase
      .from('agency_feedback')
      .select('id, message, created_at')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch feedback' });
    }

    res.json({ feedback: data || [] });
  } catch (err) {
    console.error('Feedback fetch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;