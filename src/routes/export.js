// ============================================================================
// EXPORT ROUTES — CSV Data Export for Clients & Agencies
// VoiceAI Connect — Phase 2: Data Export Layer
//
// Endpoints:
//   GET /api/export/client/:clientId/calls?from=&to=
//   GET /api/export/client/:clientId/contacts
//   GET /api/export/agency/:agencyId/calls?from=&to=&clientId=
//   GET /api/export/agency/:agencyId/clients
// ============================================================================
const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { generateCsv, formatDate, formatDuration } = require('../lib/csv-export');

// ============================================================================
// CLIENT-LEVEL EXPORTS
// ============================================================================

// GET /api/export/client/:clientId/calls?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/client/:clientId/calls', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { from, to } = req.query;

    let query = supabase
      .from('calls')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (from) query = query.gte('created_at', new Date(from).toISOString());
    if (to) query = query.lte('created_at', new Date(to + 'T23:59:59.999Z').toISOString());

    const { data: calls, error } = await query;
    if (error) {
      console.error('Export calls query error:', error);
      return res.status(400).json({ error: error.message });
    }

    const columns = [
      { key: 'created_at', label: 'Date', format: (v) => formatDate(v) },
      { key: 'customer_name', label: 'Caller Name' },
      { key: 'customer_phone', label: 'Phone' },
      { key: 'customer_email', label: 'Email' },
      { key: 'service_requested', label: 'Service Requested' },
      { key: 'duration_seconds', label: 'Duration', format: (v) => formatDuration(v) },
      { key: 'urgency_level', label: 'Urgency' },
      { key: 'call_status', label: 'Status' },
      { key: 'is_spam', label: 'Spam', format: (v) => v ? 'Yes' : 'No' },
      { key: 'transfer_status', label: 'Transfer Status' },
      { key: 'call_language', label: 'Language' },
      { key: 'appointment_booked', label: 'Appointment Booked', format: (v) => v ? 'Yes' : 'No' },
      { key: 'appointment_time', label: 'Appointment Time' },
      { key: 'ai_summary', label: 'AI Summary' },
      { key: 'transcript', label: 'Transcript' },
      { key: 'recording_url', label: 'Recording URL' },
    ];

    const csv = generateCsv(calls || [], columns);
    const dateSlug = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="calls-export-${dateSlug}.csv"`);
    console.log(`✅ CSV export: ${(calls || []).length} calls for client ${clientId}`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting client calls:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/export/client/:clientId/contacts
router.get('/client/:clientId/contacts', async (req, res) => {
  try {
    const { clientId } = req.params;

    const { data: contacts, error } = await supabase
      .from('client_contacts')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Export contacts query error:', error);
      return res.status(400).json({ error: error.message });
    }

    const columns = [
      { key: 'name', label: 'Name' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'address', label: 'Address' },
      { key: 'status', label: 'Status' },
      { key: 'source', label: 'Source' },
      { key: 'total_calls', label: 'Total Calls' },
      { key: 'last_call_at', label: 'Last Call', format: (v) => formatDate(v) },
      { key: 'tags', label: 'Tags', format: (v) => Array.isArray(v) ? v.join(', ') : '' },
      { key: 'ai_summary', label: 'AI Summary' },
      { key: 'created_at', label: 'First Seen', format: (v) => formatDate(v) },
    ];

    const csv = generateCsv(contacts || [], columns);
    const dateSlug = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-export-${dateSlug}.csv"`);
    console.log(`✅ CSV export: ${(contacts || []).length} contacts for client ${clientId}`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting client contacts:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ============================================================================
// AGENCY-LEVEL EXPORTS
// ============================================================================

// GET /api/export/agency/:agencyId/calls?from=&to=&clientId= (optional client filter)
router.get('/agency/:agencyId/calls', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const { from, to, clientId } = req.query;

    // Get all clients for this agency to build the name lookup
    const { data: clients } = await supabase
      .from('clients')
      .select('id, business_name')
      .eq('agency_id', agencyId);

    if (!clients || clients.length === 0) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="calls-export.csv"');
      return res.send('No clients found for this agency');
    }

    const clientMap = {};
    clients.forEach(c => { clientMap[c.id] = c.business_name; });

    // If a specific clientId is passed, filter to just that client; otherwise all
    const clientIds = clientId ? [clientId] : clients.map(c => c.id);

    let query = supabase
      .from('calls')
      .select('*')
      .in('client_id', clientIds)
      .order('created_at', { ascending: false });

    if (from) query = query.gte('created_at', new Date(from).toISOString());
    if (to) query = query.lte('created_at', new Date(to + 'T23:59:59.999Z').toISOString());

    const { data: calls, error } = await query;
    if (error) {
      console.error('Export agency calls query error:', error);
      return res.status(400).json({ error: error.message });
    }

    const columns = [
      { key: 'client_id', label: 'Client', format: (v) => clientMap[v] || v },
      { key: 'created_at', label: 'Date', format: (v) => formatDate(v) },
      { key: 'customer_name', label: 'Caller Name' },
      { key: 'customer_phone', label: 'Phone' },
      { key: 'customer_email', label: 'Email' },
      { key: 'service_requested', label: 'Service Requested' },
      { key: 'duration_seconds', label: 'Duration', format: (v) => formatDuration(v) },
      { key: 'urgency_level', label: 'Urgency' },
      { key: 'call_status', label: 'Status' },
      { key: 'is_spam', label: 'Spam', format: (v) => v ? 'Yes' : 'No' },
      { key: 'transfer_status', label: 'Transfer Status' },
      { key: 'call_language', label: 'Language' },
      { key: 'ai_summary', label: 'AI Summary' },
      { key: 'recording_url', label: 'Recording URL' },
    ];

    const csv = generateCsv(calls || [], columns);
    const dateSlug = new Date().toISOString().split('T')[0];
    const filename = clientId
      ? `calls-export-${clientMap[clientId] || 'client'}-${dateSlug}.csv`
      : `agency-calls-export-${dateSlug}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    console.log(`✅ CSV export: ${(calls || []).length} calls for agency ${agencyId}${clientId ? ` (client ${clientId})` : ' (all clients)'}`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting agency calls:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/export/agency/:agencyId/clients
router.get('/agency/:agencyId/clients', async (req, res) => {
  try {
    const { agencyId } = req.params;

    const { data: clients, error } = await supabase
      .from('clients')
      .select('*')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Export clients query error:', error);
      return res.status(400).json({ error: error.message });
    }

    const columns = [
      { key: 'business_name', label: 'Business Name' },
      { key: 'owner_name', label: 'Owner Name' },
      { key: 'email', label: 'Email' },
      { key: 'owner_phone', label: 'Phone' },
      { key: 'industry', label: 'Industry' },
      { key: 'plan_type', label: 'Plan' },
      { key: 'status', label: 'Status' },
      { key: 'subscription_status', label: 'Subscription' },
      { key: 'calls_this_month', label: 'Calls This Month' },
      { key: 'monthly_call_limit', label: 'Call Limit' },
      { key: 'vapi_phone_number', label: 'AI Phone Number' },
      { key: 'business_city', label: 'City' },
      { key: 'business_state', label: 'State' },
      { key: 'is_test_client', label: 'Test Client', format: (v) => v ? 'Yes' : 'No' },
      { key: 'created_at', label: 'Created', format: (v) => formatDate(v) },
      { key: 'trial_ends_at', label: 'Trial Ends', format: (v) => formatDate(v) },
    ];

    const csv = generateCsv(clients || [], columns);
    const dateSlug = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="clients-export-${dateSlug}.csv"`);
    console.log(`✅ CSV export: ${(clients || []).length} clients for agency ${agencyId}`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting agency clients:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;