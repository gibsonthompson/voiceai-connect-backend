// ============================================================================
// LEADS ROUTES - Agency Lead Management (Mini CRM)
// VoiceAI Connect Multi-Tenant
// WITH ACTIVITY LOGGING, OUTREACH TRACKING, CSV IMPORT, AND FOLLOW-UP QUEUE
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
  { value: 'csv_import', label: 'CSV Import' },
  { value: 'website', label: 'Website' },
  { value: 'social_media', label: 'Social Media' },
  { value: 'event', label: 'Event/Trade Show' },
  { value: 'other', label: 'Other' },
];

// ============================================================================
// HELPER: Get outreach stats for a lead
// ============================================================================
async function getLeadOutreachStats(agencyId, leadId) {
  try {
    const { data: history, error } = await supabase
      .from('outreach_history')
      .select('id, type, sent_at, subject, template_id')
      .eq('agency_id', agencyId)
      .eq('lead_id', leadId)
      .order('sent_at', { ascending: true });

    if (error) {
      console.error('Error fetching outreach stats:', error);
      return null;
    }

    const emails = history?.filter(h => h.type === 'email') || [];
    const sms = history?.filter(h => h.type === 'sms') || [];

    return {
      email_count: emails.length,
      sms_count: sms.length,
      total_count: (history || []).length,
      last_email: emails.length > 0 ? emails[emails.length - 1] : null,
      last_sms: sms.length > 0 ? sms[sms.length - 1] : null,
      last_outreach: history && history.length > 0 ? history[history.length - 1] : null,
      next_email_number: emails.length + 1,
      next_sms_number: sms.length + 1,
      history: history || []
    };
  } catch (err) {
    console.error('Error in getLeadOutreachStats:', err);
    return null;
  }
}

// ============================================================================
// HELPER: Calculate next step in an outreach sequence for a lead
// Returns null if sequence is complete, not started, or not due yet
// ============================================================================
function calculateNextStep(history, sequenceTemplates, now) {
  if (!sequenceTemplates || sequenceTemplates.length === 0) return null;

  const sentCount = history.length;

  // No outreach sent yet — they haven't started the sequence
  if (sentCount === 0) return null;

  // Find the next template in sequence
  const nextOrder = sentCount + 1;
  const nextTemplate = sequenceTemplates.find(t => t.sequence_order === nextOrder);

  // Sequence is complete — all templates sent
  if (!nextTemplate) return null;

  // Calculate due date: last sent + delay_days
  const lastSent = history[history.length - 1];
  const lastSentDate = new Date(lastSent.sent_at);
  const delayDays = nextTemplate.delay_days || 0;

  const dueDate = new Date(lastSentDate);
  dueDate.setDate(dueDate.getDate() + delayDays);

  // Set times to midnight for day comparison
  const dueDateDay = new Date(dueDate);
  dueDateDay.setHours(0, 0, 0, 0);
  const todayDay = new Date(now);
  todayDay.setHours(0, 0, 0, 0);

  const diffMs = dueDateDay.getTime() - todayDay.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  let urgency;
  if (diffDays < 0) {
    urgency = 'overdue';
  } else if (diffDays === 0) {
    urgency = 'due_today';
  } else if (diffDays <= 2) {
    urgency = 'upcoming';
  } else {
    // More than 2 days out — don't surface yet
    return null;
  }

  return {
    type: nextTemplate.type,
    template_name: nextTemplate.name,
    template_id: nextTemplate.id,
    sequence_order: nextTemplate.sequence_order,
    due_date: dueDate.toISOString(),
    urgency,
    days_overdue: urgency === 'overdue' ? Math.abs(diffDays) : 0,
    last_sent_at: lastSent.sent_at,
    last_type: lastSent.type,
    delay_days: delayDays,
  };
}

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

    if (status) {
      query = query.eq('status', status);
    }
    if (source) {
      query = query.eq('source', source);
    }
    if (search) {
      query = query.or(`business_name.ilike.%${search}%,contact_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    query = query.order(sort, { ascending: order === 'asc' });

    const { data: leads, error } = await query;

    if (error) {
      console.error('Error fetching leads:', error);
      return res.status(400).json({ error: error.message });
    }

    const leadIds = (leads || []).map(l => l.id);
    let outreachCounts = {};
    
    if (leadIds.length > 0) {
      const { data: outreachData } = await supabase
        .from('outreach_history')
        .select('lead_id, type, sent_at')
        .eq('agency_id', agencyId)
        .in('lead_id', leadIds);

      (outreachData || []).forEach(o => {
        if (!outreachCounts[o.lead_id]) {
          outreachCounts[o.lead_id] = { 
            email_count: 0, 
            sms_count: 0, 
            last_contacted: null 
          };
        }
        if (o.type === 'email') outreachCounts[o.lead_id].email_count++;
        if (o.type === 'sms') outreachCounts[o.lead_id].sms_count++;
        
        if (!outreachCounts[o.lead_id].last_contacted || 
            new Date(o.sent_at) > new Date(outreachCounts[o.lead_id].last_contacted)) {
          outreachCounts[o.lead_id].last_contacted = o.sent_at;
        }
      });
    }

    const leadsWithOutreach = (leads || []).map(lead => ({
      ...lead,
      outreach: outreachCounts[lead.id] || { email_count: 0, sms_count: 0, last_contacted: null }
    }));

    const allLeads = leadsWithOutreach;
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
      leads: leadsWithOutreach, 
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
      userId
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
// POST /api/agency/:agencyId/leads/import - Bulk import leads from CSV
// ⚠️  MUST be before /:agencyId/leads/:leadId or Express treats "import" as :leadId
// ============================================================================
router.post('/:agencyId/leads/import', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { leads: importLeads, columnMapping, defaultSource, userId } = req.body;

    if (!importLeads || !Array.isArray(importLeads) || importLeads.length === 0) {
      return res.status(400).json({ error: 'No leads provided' });
    }

    if (importLeads.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 leads per import. Please split your file.' });
    }

    // Map CSV rows to lead objects using the column mapping
    const leadsToInsert = [];
    const errors = [];

    importLeads.forEach((row, index) => {
      const mapped = {};
      for (const [dbField, csvColumn] of Object.entries(columnMapping)) {
        if (csvColumn && row[csvColumn] !== undefined && row[csvColumn] !== null) {
          mapped[dbField] = String(row[csvColumn]).trim();
        }
      }

      // Require at least business_name or contact_name
      if (!mapped.business_name && !mapped.contact_name) {
        errors.push({ row: index + 1, error: 'Missing business name and contact name' });
        return;
      }

      // Clean estimated_value (handle $, commas)
      let estimatedValue = null;
      if (mapped.estimated_value) {
        const cleaned = mapped.estimated_value.replace(/[$,\s]/g, '');
        const parsed = parseFloat(cleaned);
        if (!isNaN(parsed)) {
          estimatedValue = parsed < 1000 ? Math.round(parsed * 100) : Math.round(parsed);
        }
      }

      // Clean phone
      let phone = mapped.phone || null;
      if (phone) {
        phone = phone.replace(/[^\d+]/g, '');
        if (phone.length > 0 && !phone.startsWith('+') && phone.length === 10) {
          phone = '+1' + phone;
        }
      }

      // Clean email
      let email = mapped.email || null;
      if (email && !email.includes('@')) {
        email = null;
      }

      // Clean website
      let website = mapped.website || null;
      if (website && !website.startsWith('http')) {
        website = 'https://' + website;
      }

      leadsToInsert.push({
        agency_id: agencyId,
        business_name: mapped.business_name || null,
        contact_name: mapped.contact_name || null,
        email: email ? email.toLowerCase() : null,
        phone,
        website,
        industry: mapped.industry || null,
        source: defaultSource || 'csv_import',
        status: 'new',
        notes: mapped.notes || null,
        estimated_value: estimatedValue,
        company_size: mapped.company_size || null,
      });
    });

    if (leadsToInsert.length === 0) {
      return res.status(400).json({ 
        error: 'No valid leads to import', 
        errors 
      });
    }

    // Deduplicate emails within this import
    const emailSet = new Set();
    const deduped = leadsToInsert.filter(lead => {
      if (!lead.email) return true;
      if (emailSet.has(lead.email)) {
        errors.push({ 
          row: leadsToInsert.indexOf(lead) + 1, 
          error: `Duplicate email in file: ${lead.email}` 
        });
        return false;
      }
      emailSet.add(lead.email);
      return true;
    });

    // Check for existing leads by email in this agency
    const emailsToCheck = deduped
      .map(l => l.email)
      .filter(Boolean);

    let existingEmails = new Set();
    if (emailsToCheck.length > 0) {
      const { data: existing } = await supabase
        .from('leads')
        .select('email')
        .eq('agency_id', agencyId)
        .in('email', emailsToCheck);

      existingEmails = new Set((existing || []).map(e => e.email));
    }

    const newLeads = deduped.filter(lead => {
      if (lead.email && existingEmails.has(lead.email)) {
        errors.push({ 
          row: deduped.indexOf(lead) + 1, 
          error: `Already exists: ${lead.email}` 
        });
        return false;
      }
      return true;
    });

    if (newLeads.length === 0) {
      return res.status(200).json({
        success: true,
        imported: 0,
        duplicates: errors.filter(e => e.error.includes('Already exists')).length,
        errors,
        message: 'All leads already exist in your CRM'
      });
    }

    // Bulk insert
    const { data: inserted, error } = await supabase
      .from('leads')
      .insert(newLeads)
      .select();

    if (error) {
      console.error('Error bulk inserting leads:', error);
      return res.status(400).json({ error: error.message });
    }

    // Log single activity for the import
    await logActivity(
      agencyId,
      'lead',
      inserted[0]?.id || 'bulk-import',
      ACTION_TYPES.CREATED,
      {
        type: 'csv_import',
        count: inserted.length,
        source: defaultSource || 'csv_import',
        duplicates_skipped: errors.filter(e => e.error.includes('Already exists')).length,
      },
      userId
    );

    console.log(`✅ CSV Import: ${inserted.length} leads imported for agency ${agencyId}`);

    res.status(201).json({
      success: true,
      imported: inserted.length,
      duplicates: errors.filter(e => e.error.includes('Already exists')).length,
      errors: errors.length > 0 ? errors : [],
      leads: inserted,
      message: `Successfully imported ${inserted.length} lead${inserted.length !== 1 ? 's' : ''}`
    });

  } catch (error) {
    console.error('Error importing leads:', error);
    res.status(500).json({ error: 'Server error during import' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/leads/follow-up-queue
// Returns leads due for their next outreach sequence step.
// Calculates: last_outreach.sent_at + next_template.delay_days = due_date
// ⚠️  MUST be before /:agencyId/leads/:leadId (parameterized route)
// ============================================================================
router.get('/:agencyId/leads/follow-up-queue', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const now = new Date();

    // 1. Get all active leads (not won/lost)
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('id, business_name, contact_name, email, phone, status, estimated_value, industry')
      .eq('agency_id', agencyId)
      .not('status', 'in', '("won","lost")');

    if (leadsError) {
      console.error('Error fetching leads for follow-up queue:', leadsError);
      return res.status(400).json({ error: leadsError.message });
    }

    if (!leads || leads.length === 0) {
      return res.json({ queue: [], summary: { overdue: 0, due_today: 0, upcoming: 0, total: 0 } });
    }

    // 2. Get all outreach history for these leads
    const leadIds = leads.map(l => l.id);
    const { data: allHistory, error: historyError } = await supabase
      .from('outreach_history')
      .select('lead_id, type, sent_at, template_id')
      .eq('agency_id', agencyId)
      .in('lead_id', leadIds)
      .order('sent_at', { ascending: true });

    if (historyError) {
      console.error('Error fetching outreach history:', historyError);
      return res.status(400).json({ error: historyError.message });
    }

    // 3. Get all sequence templates for this agency
    const { data: templates, error: templatesError } = await supabase
      .from('outreach_templates')
      .select('id, name, type, sequence_name, sequence_order, delay_days, is_follow_up')
      .eq('agency_id', agencyId)
      .not('sequence_order', 'is', null)
      .order('type', { ascending: true })
      .order('sequence_order', { ascending: true });

    if (templatesError) {
      console.error('Error fetching templates:', templatesError);
      return res.status(400).json({ error: templatesError.message });
    }

    if (!templates || templates.length === 0) {
      return res.json({ queue: [], summary: { overdue: 0, due_today: 0, upcoming: 0, total: 0 } });
    }

    // Group templates by type
    const emailTemplates = templates.filter(t => t.type === 'email').sort((a, b) => a.sequence_order - b.sequence_order);
    const smsTemplates = templates.filter(t => t.type === 'sms').sort((a, b) => a.sequence_order - b.sequence_order);

    // Group history by lead
    const historyByLead = {};
    (allHistory || []).forEach(h => {
      if (!historyByLead[h.lead_id]) historyByLead[h.lead_id] = [];
      historyByLead[h.lead_id].push(h);
    });

    // 4. For each lead, calculate follow-up status
    const queue = [];

    for (const lead of leads) {
      const history = historyByLead[lead.id] || [];
      const emailHistory = history.filter(h => h.type === 'email');
      const smsHistory = history.filter(h => h.type === 'sms');

      // Check email and SMS sequences
      const emailResult = calculateNextStep(emailHistory, emailTemplates, now);
      const smsResult = calculateNextStep(smsHistory, smsTemplates, now);

      const results = [emailResult, smsResult].filter(Boolean);
      if (results.length === 0) continue;

      // Use the most urgent result
      const mostUrgent = results.sort((a, b) => {
        const urgencyOrder = { overdue: 0, due_today: 1, upcoming: 2 };
        const diff = (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3);
        if (diff !== 0) return diff;
        return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
      })[0];

      queue.push({
        lead_id: lead.id,
        business_name: lead.business_name,
        contact_name: lead.contact_name,
        email: lead.email,
        phone: lead.phone,
        status: lead.status,
        estimated_value: lead.estimated_value,
        industry: lead.industry,
        next_type: mostUrgent.type,
        next_template_name: mostUrgent.template_name,
        next_sequence_order: mostUrgent.sequence_order,
        due_date: mostUrgent.due_date,
        urgency: mostUrgent.urgency,
        days_overdue: mostUrgent.days_overdue,
        last_outreach_at: mostUrgent.last_sent_at,
        last_outreach_type: mostUrgent.last_type,
        pending_steps: results,
      });
    }

    // Sort: overdue first, then due_today, then upcoming
    queue.sort((a, b) => {
      const urgencyOrder = { overdue: 0, due_today: 1, upcoming: 2 };
      const diff = (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3);
      if (diff !== 0) return diff;
      return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
    });

    const summary = {
      overdue: queue.filter(q => q.urgency === 'overdue').length,
      due_today: queue.filter(q => q.urgency === 'due_today').length,
      upcoming: queue.filter(q => q.urgency === 'upcoming').length,
      total: queue.length,
    };

    res.json({ queue, summary });
  } catch (error) {
    console.error('Error fetching follow-up queue:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/leads/:leadId - Get single lead WITH outreach stats
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

    const outreachStats = await getLeadOutreachStats(agencyId, leadId);

    res.json({ 
      lead, 
      outreach: outreachStats,
      statuses: LEAD_STATUSES, 
      sources: LEAD_SOURCES 
    });
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
      userId
    } = req.body;

    const { data: currentLead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .eq('agency_id', agencyId)
      .single();

    if (!currentLead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

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

    if (status !== undefined && status !== currentLead.status) {
      await logActivity(
        agencyId,
        'lead',
        leadId,
        ACTION_TYPES.STATUS_CHANGE,
        { from: currentLead.status, to: status },
        userId
      );
    }

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

    const outreachStats = await getLeadOutreachStats(agencyId, leadId);

    console.log(`✅ Lead updated: ${lead.business_name}`);
    res.json({ success: true, lead, outreach: outreachStats });
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

    if (currentLead && currentLead.status !== status) {
      await logActivity(
        agencyId,
        'lead',
        leadId,
        ACTION_TYPES.STATUS_CHANGE,
        { from: currentLead.status, to: status },
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
// GET /api/agency/:agencyId/leads/:leadId/outreach
// ============================================================================
router.get('/:agencyId/leads/:leadId/outreach', async (req, res) => {
  try {
    const { agencyId, leadId } = req.params;

    const outreachStats = await getLeadOutreachStats(agencyId, leadId);

    if (!outreachStats) {
      return res.status(400).json({ error: 'Failed to fetch outreach stats' });
    }

    res.json({ outreach: outreachStats });
  } catch (error) {
    console.error('Error fetching lead outreach:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GET /api/agency/:agencyId/leads-stats
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
module.exports.getLeadOutreachStats = getLeadOutreachStats;