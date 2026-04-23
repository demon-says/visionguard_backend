// src/routes/cron.js
// ─────────────────────────────────────────────────────────────
// Vercel Cron Job handler.
// Vercel hits GET /api/cron/fetch every minute (configured in vercel.json).
// This replaces the in-memory node-cron poller which cannot
// work in a serverless (ephemeral) environment.
// ─────────────────────────────────────────────────────────────

const express = require('express');
const { runFetchCycle, getStatus } = require('../services/aiPoller');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/cron/fetch
// Called by Vercel Cron every minute.
// Vercel Cron sends requests with a special header that we
// can optionally verify for security.
// ─────────────────────────────────────────────────────────────
router.get('/fetch', async (req, res) => {
  try {
    // Optional: verify Vercel cron secret (if CRON_SECRET env var is set)
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    console.info('[Cron] Vercel cron triggered — running fetch cycle...');
    await runFetchCycle();
    const status = getStatus();

    res.json({
      success: true,
      message: 'Cron fetch cycle completed',
      data: status,
    });
  } catch (err) {
    console.error('[Cron] Fetch cycle error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
