// ============================================================================
// ACTIVITY LOG ROUTES
// VoiceAI Connect - Track all actions on leads and other entities
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

// ============================================================================
// ACTION TYPE DEFINITIONS
// ============================================================================
const ACTION_TYPES = {
  CREATED: 'created',
  STATUS_CHANGE: 'status_change',
  NOTE_ADDED: 'note_added',
  NOTE_UPDATED: 'note_updated',
  EMAIL_SENT: 'email_sent',
  SMS_SENT: 'sms_sent',
  CALL_LOGGED: 'call_logged',
  FOLLOW_UP_SET: 'follow_up_set',
  UPDATED: 'updated',
  CONVERTED: 'converted',  // Lead converted to client
};

// ============================================================================
// GET /api/agency/:agencyId/activity/:entityType/:entityId
// Get activity log for a specific entity
// ============================================================================
router.get('/:agencyId/activity/:entityType/:entityId', async (req, res) => {
  try {
    const { agencyId, entityType, entityId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const { data: activities, error, count } = await supabase
      .from('activity_log')
      .select(`
        *,
        performer:users!activity_log_performed_by_fkey (
          id, first_name, last_name, email
        )
      `, { count: 'exact' })
      .eq('agency_id', agencyId)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) {
      console.error('Error fetching activity log:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ 
      activities: activities || [], 
      total: count,
      actionTypes: ACTION_TYPES 
    });
  } catch (error) {
    console.error('Error fetching activity log:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/activity
// Get all activity for an agency (for activity feed)
// ============================================================================
router.get('/:agencyId/activity', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { limit = 50, offset = 0, entityType, actionType } = req.query;

    let query = supabase
      .from('activity_log')
      .select(`
        *,
        performer:users!activity_log_performed_by_fkey (
          id, first_name, last_name, email
        )
      `, { count: 'exact' })
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });

    if (entityType) {
      query = query.eq('entity_type', entityType);
    }
    if (actionType) {
      query = query.eq('action_type', actionType);
    }

    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: activities, error, count } = await query;

    if (error) {
      console.error('Error fetching activity log:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ 
      activities: activities || [], 
      total: count,
      actionTypes: ACTION_TYPES 
    });
  } catch (error) {
    console.error('Error fetching activity log:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/activity
// Log a new activity (manual entry, e.g., "logged a call")
// ============================================================================
router.post('/:agencyId/activity', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { entityType, entityId, actionType, actionData, performedBy } = req.body;

    if (!entityType || !entityId || !actionType) {
      return res.status(400).json({ error: 'entityType, entityId, and actionType are required' });
    }

    const { data: activity, error } = await supabase
      .from('activity_log')
      .insert({
        agency_id: agencyId,
        entity_type: entityType,
        entity_id: entityId,
        action_type: actionType,
        action_data: actionData || {},
        performed_by: performedBy || null
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating activity:', error);
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ success: true, activity });
  } catch (error) {
    console.error('Error creating activity:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// HELPER: Log activity (for use in other routes)
// ============================================================================
async function logActivity(agencyId, entityType, entityId, actionType, actionData = {}, performedBy = null) {
  try {
    const { error } = await supabase
      .from('activity_log')
      .insert({
        agency_id: agencyId,
        entity_type: entityType,
        entity_id: entityId,
        action_type: actionType,
        action_data: actionData,
        performed_by: performedBy
      });

    if (error) {
      console.error('Error logging activity:', error);
    }
  } catch (err) {
    console.error('Error logging activity:', err);
  }
}

module.exports = router;
module.exports.logActivity = logActivity;
module.exports.ACTION_TYPES = ACTION_TYPES;