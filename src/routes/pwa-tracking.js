// src/routes/pwa-tracking.js
// Tracks PWA install prompt and actual installs for client stickiness metrics

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

// POST /api/client/:id/pwa-tracking
// Body: { event: 'prompted' | 'installed', platform: 'ios' | 'android' | 'desktop' }
router.post('/:id/pwa-tracking', async (req, res) => {
  try {
    const { id } = req.params;
    const { event, platform } = req.body;

    if (!event || !['prompted', 'installed'].includes(event)) {
      return res.status(400).json({ error: 'Invalid event type' });
    }

    const update = {};

    if (event === 'prompted') {
      update.pwa_install_prompted_at = new Date().toISOString();
      if (platform) update.pwa_platform = platform;
    }

    if (event === 'installed') {
      update.pwa_installed_at = new Date().toISOString();
      if (platform) update.pwa_platform = platform;
    }

    const { error } = await supabase
      .from('clients')
      .update(update)
      .eq('id', id);

    if (error) {
      console.error('Failed to update PWA tracking:', error);
      return res.status(500).json({ error: 'Failed to update tracking' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('PWA tracking error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;