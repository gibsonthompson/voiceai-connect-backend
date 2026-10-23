// ============================================================================
// WORKFLOW SCHEDULER CRON - POST /api/cron/workflows
//
// Advances every run whose timer (next_run_at) is due: the second message in a
// drip, a send that was held for quiet hours, a wait that elapsed. Guarded by
// CRON_SECRET like the other cron routes. Point a 1-minute scheduler at it.
//
// The claim lock + stale reclaim live in processDueEnrollments(), so running
// this every minute (even with overlap) never double-advances a run.
// ============================================================================

const express = require('express');
const router = express.Router();
const { processDueEnrollments } = require('../lib/workflow-engine');

router.post('/workflows', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const batchSize = parseInt(req.query.batch, 10) || 100;
    const result = await processDueEnrollments(batchSize);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Workflow scheduler cron error:', error);
    res.status(500).json({ error: 'Cron job failed', message: error.message });
  }
});

module.exports = router;
