// ============================================================================
// PREVIEW TOKEN — Agency owner can preview client dashboard
// Generates a short-lived JWT so the agency owner sees exactly
// what their client sees when logged in.
// Destination: src/routes/preview-token.js
// Mount in server.js: app.use('/api/agency', require('./routes/preview-token'));
// ============================================================================
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabase } = require('../lib/supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ============================================================================
// POST /api/agency/:agencyId/clients/:clientId/preview-token
// ============================================================================
router.post('/:agencyId/clients/:clientId/preview-token', async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;

    // Verify caller is agency owner
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Authorization required' });

    let decoded;
    try {
      const token = authHeader.split(' ')[1];
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (decoded.role !== 'agency_owner' && decoded.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only agency owners can preview client dashboards' });
    }

    // Verify client belongs to this agency
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select(`
        *,
        agency:agencies!clients_agency_id_fkey (
          id, name, slug,
          primary_color, secondary_color, accent_color,
          logo_url, support_email, support_phone,
          website_theme, client_header_mode,
          price_starter, price_pro, price_growth,
          limit_starter, limit_pro, limit_growth,
          plan_features
        )
      `)
      .eq('id', clientId)
      .eq('agency_id', agencyId)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found or does not belong to this agency' });
    }

    // Find the client owner user (role = 'client')
    const { data: clientUser } = await supabase
      .from('users')
      .select('id, email, first_name, last_name, role')
      .eq('client_id', clientId)
      .eq('role', 'client')
      .single();

    // If no client user exists, create a minimal user object for preview
    const user = clientUser || {
      id: `preview-${clientId}`,
      email: client.email,
      first_name: client.owner_name?.split(' ')[0] || 'Preview',
      last_name: client.owner_name?.split(' ').slice(1).join(' ') || 'User',
      role: 'client',
    };

    // Generate short-lived preview token (1 hour)
    const previewToken = jwt.sign(
      {
        userId: user.id,
        clientId: client.id,
        role: 'client',
        preview: true,
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    console.log(`👁️ Preview token generated for client "${client.business_name}" by agency ${agencyId}`);

    res.json({
      success: true,
      token: previewToken,
      client: client,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: 'client',
        client_id: clientId,
      },
    });
  } catch (error) {
    console.error('❌ Preview token error:', error);
    res.status(500).json({ error: 'Failed to generate preview token' });
  }
});

module.exports = router;