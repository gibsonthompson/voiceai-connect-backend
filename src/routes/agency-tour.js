// ============================================================================
// Agency onboarding tour state.
// Persists the tour's dismiss count and completion on the agency record so it
// survives logout (which clears localStorage) and works across devices/browsers.
// The dashboard stops auto-opening the tour once it has been dismissed enough
// times or completed. Mounted at /api/agency, so routes carry :agencyId and are
// gated by requireAgencyAccess.
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireAgencyAccess } = require('./auth');

// GET /api/agency/:agencyId/tour-state
router.get('/:agencyId/tour-state', requireAgencyAccess(), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agencies')
      .select('tour_dismiss_count, tour_completed')
      .eq('id', req.params.agencyId)
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({
      success: true,
      dismiss_count: data?.tour_dismiss_count || 0,
      completed: data?.tour_completed === true,
    });
  } catch (e) {
    console.error('tour-state GET error:', e);
    res.status(500).json({ error: 'Failed to read tour state' });
  }
});

// POST /api/agency/:agencyId/tour-state
// Body: { dismissed?: boolean, completed?: boolean }
//   dismissed: true increments the dismiss count by one.
//   completed: true marks the tour finished (never auto-opens again).
router.post('/:agencyId/tour-state', requireAgencyAccess(), async (req, res) => {
  try {
    const b = req.body || {};
    const { data: current, error: readErr } = await supabase
      .from('agencies')
      .select('tour_dismiss_count, tour_completed')
      .eq('id', req.params.agencyId)
      .single();
    if (readErr) return res.status(400).json({ error: readErr.message });

    const updates = {};
    if (b.dismissed === true) updates.tour_dismiss_count = (current?.tour_dismiss_count || 0) + 1;
    if (b.completed === true) updates.tour_completed = true;
    if (Object.keys(updates).length === 0) {
      return res.json({ success: true, dismiss_count: current?.tour_dismiss_count || 0, completed: current?.tour_completed === true });
    }

    const { data, error } = await supabase
      .from('agencies')
      .update(updates)
      .eq('id', req.params.agencyId)
      .select('tour_dismiss_count, tour_completed')
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({
      success: true,
      dismiss_count: data?.tour_dismiss_count || 0,
      completed: data?.tour_completed === true,
    });
  } catch (e) {
    console.error('tour-state POST error:', e);
    res.status(500).json({ error: 'Failed to save tour state' });
  }
});

module.exports = router;
