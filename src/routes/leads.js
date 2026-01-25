// ============================================================================
// LEADS ROUTES - Agency Lead Management (Mini CRM)
// VoiceAI Connect Multi-Tenant
// WITH ACTIVITY LOGGING
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { logActivity, ACTION_TYPES } = require('./activity');

// ============================================================================
// LEAD STATUS OPTIONS
// ============================================================================
const LEAD_STATUSES = [
  { value: 'new', label: 'New', color: 'blue' },
  { value: 'contacted', label: 'Contacted', color: 'amber' },
  { value: 'qualified', label: 'Qualified', color: 'purple' },
  { value: 'proposal', label: 'Proposal Sent', color: 'cyan' },
  { value: 'won', label: 'Won', color: 'emerald' },
  { value: 'lost', label: 'Lost', color: 'red' },
];

const LEAD_SOURCES = [
  { value: 'referral', label: 'Referral' },
  { value: 'cold_outreach', label: 'Cold Outreach' },
  { value: 'website', label: 'Website' },
  { value: 'social_media', label: 'Social Media' },
  { value: 'event', label: 'Event/Trade Show' },
  { value: 'other', label: 'Other' },
];

// ============================================================================
// GET /api/agency/:agencyId/leads - List all leads with stats
// ============================================================================
router.get('/:agencyId/leads', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { status, source, search, sort = 'created_at', order = 'desc' } = req.query;

    let query = supabase
      .from('leads')
      .select('*')
      .eq('agency_id', agencyId);

    // Apply filters
    if (status) {
      query = query.eq('status', status);
    }
    if (source) {
      query = query.eq('source', source);
    }
    if (search) {
      query = query.or(`business_name.ilike.%${search}%,contact_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    // Apply sorting
    query = query.order(sort, { ascending: order === 'asc' });

    const { data: leads, error } = await query;

    if (error) {
      console.error('Error fetching leads:', error);
      return res.status(400).json({ error: error.message });
    }

    // Calculate stats
    const allLeads = leads || [];
    const stats = {
      total: allLeads.length,
      new: allLeads.filter(l => l.status === 'new').length,
      contacted: allLeads.filter(l => l.status === 'contacted').length,
      qualified: allLeads.filter(l => l.status === 'qualified').length,
      proposal: allLeads.filter(l => l.status === 'proposal').length,
      won: allLeads.filter(l => l.status === 'won').length,
      lost: allLeads.filter(l => l.status === 'lost').length,
      totalEstimatedValue: allLeads
        .filter(l => l.status !== 'lost')
        .reduce((sum, l) => sum + (l.estimated_value || 0), 0),
      followUpsToday: allLeads.filter(l => {
        if (!l.next_follow_up) return false;
        const followUp = new Date(l.next_follow_up);
        const today = new Date();
        return followUp.toDateString() === today.toDateString();
      }).length,
    };

    res.json({ 
      leads: allLeads, 
      stats,
      statuses: LEAD_STATUSES,
      sources: LEAD_SOURCES
    });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/leads - Create new lead
// ============================================================================
router.post('/:agencyId/leads', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const {
      business_name,
      contact_name,
      email,
      phone,
      website,
      industry,
      source,
      status = 'new',
      notes,
      estimated_value,
      next_follow_up,
      userId  // For activity logging
    } = req.body;

    if (!business_name) {
      return res.status(400).json({ error: 'Business name is required' });
    }

    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        agency_id: agencyId,
        business_name,
        contact_name,
        email,
        phone,
        website,
        industry,
        source,
        status,
        notes,
        estimated_value: estimated_value ? parseInt(estimated_value) : null,
        next_follow_up: next_follow_up || null
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating lead:', error);
      return res.status(400).json({ error: error.message });
    }

    // Log activity
    await logActivity(
      agencyId,
      'lead',
      lead.id,
      ACTION_TYPES.CREATED,
      { 
        business_name,
        source,
        estimated_value: estimated_value ? parseInt(estimated_value) : null
      },
      userId
    );

    // Log initial note if provided
    if (notes) {
      await logActivity(
        agencyId,
        'lead',
        lead.id,
        ACTION_TYPES.NOTE_ADDED,
        { note: notes },
        userId
      );
    }

    console.log(`✅ Lead created: ${business_name} for agency ${agencyId}`);
    res.status(201).json({ success: true, lead });
  } catch (error) {
    console.error('Error creating lead:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/leads/:leadId - Get single lead
// ============================================================================
router.get('/:agencyId/leads/:leadId', async (req, res) => {
  try {
    const { agencyId, leadId } = req.params;

    const { data: lead, error } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .eq('agency_id', agencyId)
      .single();

    if (error || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({ lead, statuses: LEAD_STATUSES, sources: LEAD_SOURCES });
  } catch (error) {
    console.error('Error fetching lead:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PUT /api/agency/:agencyId/leads/:leadId - Update lead
// ============================================================================
router.put('/:agencyId/leads/:leadId', async (req, res) => {
  try {
    const { agencyId, leadId } = req.params;
    const {
      business_name,
      contact_name,
      email,
      phone,
      website,
      industry,
      source,
      status,
      notes,
      estimated_value,
      next_follow_up,
      userId  // For activity logging
    } = req.body;

    // Get current lead for comparison
    const { data: currentLead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .eq('agency_id', agencyId)
      .single();

    if (!currentLead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Build update object with only provided fields
    const updates = {};
    if (business_name !== undefined) updates.business_name = business_name;
    if (contact_name !== undefined) updates.contact_name = contact_name;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (website !== undefined) updates.website = website;
    if (industry !== undefined) updates.industry = industry;
    if (source !== undefined) updates.source = source;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (estimated_value !== undefined) {
      updates.estimated_value = estimated_value ? parseInt(estimated_value) : null;
    }
    if (next_follow_up !== undefined) {
      updates.next_follow_up = next_follow_up || null;
    }

    const { data: lead, error } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', leadId)
      .eq('agency_id', agencyId)
      .select()
      .single();

    if (error) {
      console.error('Error updating lead:', error);
      return res.status(400).json({ error: error.message });
    }

    // Log status change if changed
    if (status !== undefined && status !== currentLead.status) {
      await logActivity(
        agencyId,
        'lead',
        leadId,
        ACTION_TYPES.STATUS_CHANGE,
        { 
          from: currentLead.status,
          to: status
        },
        userId
      );
    }

    // Log note change if changed
    if (notes !== undefined && notes !== currentLead.notes) {
      await logActivity(
        agencyId,
        'lead',
        leadId,
        currentLead.notes ? ACTION_TYPES.NOTE_UPDATED : ACTION_TYPES.NOTE_ADDED,
        { note: notes },
        userId
      );
    }

    // Log follow-up change if changed
    if (next_follow_up !== undefined && next_follow_up !== currentLead.next_follow_up) {
      await logActivity(
        agencyId,
        'lead',
        leadId,
        ACTION_TYPES.FOLLOW_UP_SET,
        { date: next_follow_up },
        userId
      );
    }

    console.log(`✅ Lead updated: ${lead.business_name}`);
    res.json({ success: true, lead });
  } catch (error) {
    console.error('Error updating lead:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// DELETE /api/agency/:agencyId/leads/:leadId - Delete lead
// ============================================================================
router.delete('/:agencyId/leads/:leadId', async (req, res) => {
  try {
    const { agencyId, leadId } = req.params;

    const { error } = await supabase
      .from('leads')
      .delete()
      .eq('id', leadId)
      .eq('agency_id', agencyId);

    if (error) {
      console.error('Error deleting lead:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Lead deleted: ${leadId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting lead:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PATCH /api/agency/:agencyId/leads/:leadId/status - Quick status update
// ============================================================================
router.patch('/:agencyId/leads/:leadId/status', async (req, res) => {
  try {
    const { agencyId, leadId } = req.params;
    const { status, userId } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = LEAD_STATUSES.map(s => s.value);
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Get current status
    const { data: currentLead } = await supabase
      .from('leads')
      .select('status')
      .eq('id', leadId)
      .eq('agency_id', agencyId)
      .single();

    const { data: lead, error } = await supabase
      .from('leads')
      .update({ status })
      .eq('id', leadId)
      .eq('agency_id', agencyId)
      .select()
      .single();

    if (error || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Log activity
    if (currentLead && currentLead.status !== status) {
      await logActivity(
        agencyId,
        'lead',
        leadId,
        ACTION_TYPES.STATUS_CHANGE,
        { 
          from: currentLead.status,
          to: status
        },
        userId
      );
    }

    res.json({ success: true, lead });
  } catch (error) {
    console.error('Error updating lead status:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// POST /api/agency/:agencyId/leads/:leadId/log-call
// Log a phone call activity
// ============================================================================
router.post('/:agencyId/leads/:leadId/log-call', async (req, res) => {
  try {
    const { agencyId, leadId } = req.params;
    const { duration, outcome, notes, userId } = req.body;

    await logActivity(
      agencyId,
      'lead',
      leadId,
      ACTION_TYPES.CALL_LOGGED,
      { duration, outcome, notes },
      userId
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error logging call:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/leads-stats - Get lead pipeline stats
// ============================================================================
router.get('/:agencyId/leads-stats', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: leads, error } = await supabase
      .from('leads')
      .select('status, estimated_value, next_follow_up')
      .eq('agency_id', agencyId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const allLeads = leads || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const stats = {
      total: allLeads.length,
      byStatus: {
        new: allLeads.filter(l => l.status === 'new').length,
        contacted: allLeads.filter(l => l.status === 'contacted').length,
        qualified: allLeads.filter(l => l.status === 'qualified').length,
        proposal: allLeads.filter(l => l.status === 'proposal').length,
        won: allLeads.filter(l => l.status === 'won').length,
        lost: allLeads.filter(l => l.status === 'lost').length,
      },
      pipelineValue: allLeads
        .filter(l => !['won', 'lost'].includes(l.status))
        .reduce((sum, l) => sum + (l.estimated_value || 0), 0),
      wonValue: allLeads
        .filter(l => l.status === 'won')
        .reduce((sum, l) => sum + (l.estimated_value || 0), 0),
      followUpsToday: allLeads.filter(l => {
        if (!l.next_follow_up) return false;
        const followUp = new Date(l.next_follow_up);
        followUp.setHours(0, 0, 0, 0);
        return followUp.getTime() === today.getTime();
      }).length,
      overdueFollowUps: allLeads.filter(l => {
        if (!l.next_follow_up) return false;
        const followUp = new Date(l.next_follow_up);
        followUp.setHours(0, 0, 0, 0);
        return followUp.getTime() < today.getTime() && !['won', 'lost'].includes(l.status);
      }).length,
    };

    res.json({ stats });
  } catch (error) {
    console.error('Error fetching lead stats:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.LEAD_STATUSES = LEAD_STATUSES;
module.exports.LEAD_SOURCES = LEAD_SOURCES;