// ============================================================================
// ADMIN SMS LOG ENDPOINT
// GET /api/admin/sms-log
// Query params: agency_id, type, recipient_type, from, to, limit, offset
//
// Add to admin.js routes or mount separately.
// Usage: app.use('/api/admin', smsLogRoutes);
//
// CREATED: 2026-05-09
// UPDATED: 2026-08-03 - Fixed admin auth check. The token minted by
//          generateToken (auth.js) carries role: 'platform_admin', NOT
//          type: 'admin'. The old `decoded.type !== 'admin'` check was always
//          true for a valid admin token, so every request 403'd ("Failed to
//          fetch SMS logs"). Now matches requireAdmin: role === 'platform_admin'.
// ============================================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

router.get('/sms-log', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });

    // Verify admin. Tokens from generateToken carry { role: 'platform_admin' }
    // in camelCase; this mirrors requireAdmin (decoded.role === 'platform_admin').
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET);
    if (!decoded || decoded.role !== 'platform_admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const {
      agency_id,
      type,
      recipient_type,
      from: fromDate,
      to: toDate,
      limit = 50,
      offset = 0,
    } = req.query;

    // Build query
    let query = supabase
      .from('sms_log')
      .select(`
        id,
        agency_id,
        recipient_phone,
        recipient_type,
        message_type,
        message_body,
        delivery_status,
        metadata,
        created_at
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    // Apply filters
    if (agency_id) {
      query = query.eq('agency_id', agency_id);
    }
    if (type) {
      query = query.eq('message_type', type);
    }
    if (recipient_type) {
      query = query.eq('recipient_type', recipient_type);
    }
    if (fromDate) {
      query = query.gte('created_at', new Date(fromDate).toISOString());
    }
    if (toDate) {
      query = query.lte('created_at', new Date(toDate).toISOString());
    }

    const { data: logs, error, count } = await query;

    if (error) {
      console.error('❌ SMS log query error:', error);
      return res.status(500).json({ error: 'Failed to fetch SMS logs' });
    }

    // Fetch agency names for the logs that have agency_id
    const agencyIds = [...new Set((logs || []).filter(l => l.agency_id).map(l => l.agency_id))];
    let agencyMap = {};

    if (agencyIds.length > 0) {
      const { data: agencies } = await supabase
        .from('agencies')
        .select('id, name')
        .in('id', agencyIds);

      if (agencies) {
        agencyMap = Object.fromEntries(agencies.map(a => [a.id, a.name]));
      }
    }

    // Enrich logs with agency name
    const enrichedLogs = (logs || []).map(log => ({
      ...log,
      agency_name: log.agency_id ? (agencyMap[log.agency_id] || 'Unknown') : null,
    }));

    // Get distinct message types for filter dropdown
    const { data: types } = await supabase
      .from('sms_log')
      .select('message_type')
      .limit(100);

    const distinctTypes = [...new Set((types || []).map(t => t.message_type))].sort();

    res.json({
      success: true,
      logs: enrichedLogs,
      total: count || 0,
      limit: parseInt(limit),
      offset: parseInt(offset),
      types: distinctTypes,
    });

  } catch (error) {
    console.error('❌ SMS log error:', error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;