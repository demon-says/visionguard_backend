// src/routes/ai.js
// Manages the Cloudflare Tunnel URL and the AI poller lifecycle.
//
// GET  /api/ai/config    → current AI URL + poll interval
// PUT  /api/ai/config    → update AI URL (Cloudflare gives a new one on restart)
// GET  /api/ai/status    → poller running state + stats
// POST /api/ai/fetch     → manually trigger one fetch cycle
// POST /api/ai/start     → start the auto-poller
// POST /api/ai/stop      → stop  the auto-poller
// POST /api/ai/restart   → restart with latest DB config

const express        = require('express');
const { supabase }   = require('../config/supabase');
const aiPoller       = require('../services/aiPoller');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

function assertNoError(error, label) {
  if (error) throw createError(500, `DB error (${label}): ${error.message}`, 'DB_ERROR');
}

// ─────────────────────────────────────────────────────────────
// GET /api/ai/config
// Returns the currently stored AI endpoint URL and interval.
// ─────────────────────────────────────────────────────────────
router.get('/config', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('system_info')
      .select('ai_endpoint_url, ai_poll_interval_sec, api_status')
      .limit(1)
      .single();

    assertNoError(error, 'ai config');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/ai/config
// Called whenever Cloudflare Tunnel gives a new URL.
// The poller reads the URL from the DB on every cycle, so the
// change takes effect on the NEXT scheduled tick automatically.
//
// Body: { url: 'https://abc.trycloudflare.com', intervalSec: 30 }
// ─────────────────────────────────────────────────────────────
router.put('/config', async (req, res, next) => {
  try {
    const { url, intervalSec } = req.body;

    if (!url) return next(createError(400, 'url is required', 'VALIDATION'));
    if (!/^https?:\/\/.+/.test(url)) {
      return next(createError(400, 'url must be a valid http/https URL', 'VALIDATION'));
    }

    const updates = { ai_endpoint_url: url };
    if (intervalSec && intervalSec >= 5) updates.ai_poll_interval_sec = intervalSec;

    const { data: existing } = await supabase
      .from('system_info').select('id').limit(1).single();

    const { data, error } = await supabase
      .from('system_info')
      .update(updates)
      .eq('id', existing.id)
      .select('ai_endpoint_url, ai_poll_interval_sec')
      .single();

    assertNoError(error, 'update ai config');

    // If interval changed, restart the poller with the new schedule
    if (intervalSec && intervalSec >= 5) {
      await aiPoller.restartPoller();
    }

    console.info(`[AI Config] Updated endpoint URL to: ${url}`);
    res.json({ success: true, data, message: 'AI endpoint URL updated. Takes effect on next poll cycle.' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/ai/status
// On a persistent server, returns the in-memory poller state.
// On Vercel (serverless), checks if violations were inserted
// recently to determine if the cron-based pipeline is active.
// ─────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  // Local / persistent server — use in-memory state
  if (!process.env.VERCEL) {
    return res.json({ success: true, data: aiPoller.getStatus() });
  }

  // Vercel serverless — check DB for recent activity
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('detected_violations')
      .select('id', { count: 'exact', head: true })
      .gte('inserted_at', fiveMinAgo);

    const { count: totalCount } = await supabase
      .from('detected_violations')
      .select('id', { count: 'exact', head: true });

    const hasUrl = !!(process.env.AI_ENDPOINT_URL);

    res.json({
      success: true,
      data: {
        isRunning     : hasUrl && (count ?? 0) > 0,
        lastFetchAt   : null,
        lastError     : hasUrl ? null : 'No AI_ENDPOINT_URL configured',
        fetchCount    : count ?? 0,
        totalInserted : totalCount ?? 0,
      },
    });
  } catch (err) {
    res.json({
      success: true,
      data: { isRunning: false, lastError: err.message, fetchCount: 0, totalInserted: 0 },
    });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/fetch
// Manually trigger one fetch cycle right now.
// Useful for testing or when you want an immediate update.
// ─────────────────────────────────────────────────────────────
router.post('/fetch', async (req, res, next) => {
  try {
    await aiPoller.runFetchCycle();
    res.json({ success: true, data: aiPoller.getStatus(), message: 'Manual fetch cycle completed.' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/start
// Start the automatic poller (if not already running).
// ─────────────────────────────────────────────────────────────
router.post('/start', async (req, res, next) => {
  try {
    await aiPoller.startPoller();
    res.json({ success: true, data: aiPoller.getStatus(), message: 'Poller started.' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/stop
// Stop the automatic poller.
// ─────────────────────────────────────────────────────────────
router.post('/stop', (req, res) => {
  aiPoller.stopPoller();
  res.json({ success: true, data: aiPoller.getStatus(), message: 'Poller stopped.' });
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/restart
// Restart the poller (re-reads DB config — useful after
// updating the URL or interval).
// ─────────────────────────────────────────────────────────────
router.post('/restart', async (req, res, next) => {
  try {
    await aiPoller.restartPoller();
    res.json({ success: true, data: aiPoller.getStatus(), message: 'Poller restarted.' });
  } catch (err) { next(err); }
});

module.exports = router;
