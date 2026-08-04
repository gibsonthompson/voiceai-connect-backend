// ============================================================================
// USAGE REPORT ROUTES (agency-facing)
// Location: src/routes/usage-report.js
// Created: 2026-08-04
// ----------------------------------------------------------------------------
// Serves the monthly usage statement to the agency dashboard and provides the
// "save" formats (CSV download, printable HTML). Mounted at /api/agency, so:
//   GET /api/agency/:agencyId/usage-report                  -> JSON (dashboard)
//   GET /api/agency/:agencyId/usage-report?month=YYYY-MM     -> JSON, past month
//   GET /api/agency/:agencyId/usage-report?format=csv        -> CSV download
//   GET /api/agency/:agencyId/usage-report?format=html       -> printable page
//   GET /api/agency/:agencyId/clients/:clientId/statement    -> one client's line
//
// requireAgencyAccess('billing') requires a valid token, confirms the caller
// owns :agencyId (super_admin passes), and enforces the 'billing' Page Access
// permission for agency_staff, matching every other money-touching route.
// ============================================================================
const express = require('express');
const router = express.Router();
const { requireAgencyAccess } = require('./auth');
const { getAgencyMonthlyReport, toCSV, renderReportHTML } = require('../lib/usage-report');

router.get('/:agencyId/usage-report', requireAgencyAccess('billing'), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    const format = String(req.query.format || 'json').toLowerCase();

    const report = await getAgencyMonthlyReport(agencyId, { month });
    if (!report) return res.status(404).json({ error: 'Agency not found' });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="usage-${report.month}.csv"`);
      return res.send(toCSV(report));
    }
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderReportHTML(report));
    }
    return res.json(report);
  } catch (err) {
    console.error('❌ usage-report error:', err.message);
    return res.status(500).json({ error: 'Failed to build usage report' });
  }
});

// Single client's statement line for the month (for a per-client invoice view).
router.get('/:agencyId/clients/:clientId/statement', requireAgencyAccess('billing'), async (req, res) => {
  try {
    const { agencyId, clientId } = req.params;
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;

    const report = await getAgencyMonthlyReport(agencyId, { month });
    if (!report) return res.status(404).json({ error: 'Agency not found' });

    const line = report.clients.find(c => c.clientId === clientId);
    if (!line) return res.status(404).json({ error: 'No activity for this client in the selected month' });

    return res.json({
      agencyId: report.agencyId,
      agencyName: report.agencyName,
      month: report.month,
      generatedAt: report.generatedAt,
      client: line,
    });
  } catch (err) {
    console.error('❌ client-statement error:', err.message);
    return res.status(500).json({ error: 'Failed to build client statement' });
  }
});

module.exports = router;