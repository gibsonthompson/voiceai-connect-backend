// ============================================================================
// TOOL CONFIG ROUTES - Per-client feature toggles for dynamic assistant
// Mounted at: app.use('/api/client', toolConfigRoutes)
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

// Default tool config — used when client has no tool_config or is missing keys
const DEFAULT_TOOL_CONFIG = {
  callerRecognition: true,
  spamDetection: true,
  transferCall: true,
  businessHoursRouting: false,
  afterHoursMessage: "We're currently closed, but I'd be happy to take a message and have someone call you back during business hours.",
  speechTimeout: true,
  speechTimeoutSeconds: 12,
  transferFallbackToMessage: true,
};

// ============================================================================
// GET /api/client/:id/tool-config
// ============================================================================
router.get('/:id/tool-config', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('tool_config, business_hours')
      .eq('id', id)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // Merge stored config with defaults (fill any missing keys)
    const config = { ...DEFAULT_TOOL_CONFIG, ...(client.tool_config || {}) };

    res.json({
      success: true,
      tool_config: config,
      business_hours: client.business_hours || null,
    });
  } catch (error) {
    console.error('Error fetching tool config:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/client/:id/tool-config
// Accepts partial updates — merges with existing config
// ============================================================================
router.put('/:id/tool-config', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid request body' });
    }

    // Whitelist allowed keys
    const allowed = [
      'callerRecognition', 'spamDetection', 'transferCall',
      'businessHoursRouting', 'afterHoursMessage',
      'speechTimeout', 'speechTimeoutSeconds',
      'transferFallbackToMessage',
    ];

    // Get current config
    const { data: client, error: fetchError } = await supabase
      .from('clients')
      .select('tool_config')
      .eq('id', id)
      .single();

    if (fetchError || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const currentConfig = { ...DEFAULT_TOOL_CONFIG, ...(client.tool_config || {}) };

    // Apply only whitelisted updates
    const newConfig = { ...currentConfig };
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        newConfig[key] = updates[key];
      }
    }

    // Validate speechTimeoutSeconds range
    if (typeof newConfig.speechTimeoutSeconds === 'number') {
      newConfig.speechTimeoutSeconds = Math.max(5, Math.min(30, newConfig.speechTimeoutSeconds));
    }

    const { error: updateError } = await supabase
      .from('clients')
      .update({ tool_config: newConfig })
      .eq('id', id);

    if (updateError) {
      return res.status(400).json({ success: false, error: updateError.message });
    }

    console.log(`✅ Tool config updated for client ${id}:`, Object.keys(updates).filter(k => allowed.includes(k)).join(', '));
    res.json({ success: true, tool_config: newConfig });
  } catch (error) {
    console.error('Error updating tool config:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
module.exports.DEFAULT_TOOL_CONFIG = DEFAULT_TOOL_CONFIG;