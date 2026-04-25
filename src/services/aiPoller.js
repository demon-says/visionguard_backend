// src/services/aiPoller.js
// ─────────────────────────────────────────────────────────────
// Periodically fetches the AI JSON from the Cloudflare Tunnel
// URL and passes the response to the violation processor.
//
// Key design decisions:
//  • The AI URL is read from the DB (system_info) before EVERY
//    fetch cycle, so changing it via PUT /api/ai/config takes
//    effect immediately — no server restart needed.
//  • The poll interval is also stored in the DB and re-read
//    each cycle, so the admin can tune it at runtime.
//  • All state (lastFetch, lastError, stats) is held in memory
//    and exposed via getStatus() for the /api/ai/status route.
// ─────────────────────────────────────────────────────────────

const axios                 = require('axios');
const { supabase }          = require('../config/supabase');
const { processAIResponse } = require('./violationProcessor');

// node-cron is loaded lazily inside startPoller() to avoid
// crashing Vercel serverless (which never calls startPoller).
let cron = null;

// ── In-memory poller state ────────────────────────────────────
let cronJob      = null;
let isRunning    = false;
let lastFetchAt  = null;
let lastError    = null;
let fetchCount   = 0;
let totalInserted = 0;

// ─────────────────────────────────────────────────────────────
// Fetch the AI endpoint URL and poll interval from the DB.
// Falls back to .env values if the DB row has no URL set yet.
// ─────────────────────────────────────────────────────────────
async function loadAIConfig() {
  return {
    url      : process.env.AI_ENDPOINT_URL,
    interval : Number(process.env.AI_POLL_INTERVAL_SEC) || 30,
  };
}

// ─────────────────────────────────────────────────────────────
// Core fetch-and-process cycle.
// Called by the cron job on every tick.
// ─────────────────────────────────────────────────────────────
async function runFetchCycle() {
  let config;
  try {
    config = await loadAIConfig();
  } catch (err) {
    lastError = `Config load failed: ${err.message}`;
    return;
  }

  if (!config.url) {
    lastError = 'No AI endpoint URL configured. Use PUT /api/ai/config to set it.';
    console.warn('[Poller]', lastError);
    return;
  }

  try {
    console.info(`[Poller] Fetching AI output from: ${config.url}`);

    const response = await axios.get(config.url, {
      timeout: 10_000, // 10 s – AI should respond quickly
      headers: { Accept: 'application/json' },
    });

    const aiJson = response.data;

    if (!aiJson || typeof aiJson !== 'object') {
      throw new Error('AI response is not a valid JSON object');
    }

    const summary = await processAIResponse(aiJson);

    // Update poller state
    fetchCount++;
    lastFetchAt    = new Date().toISOString();
    lastError      = null;
    totalInserted += summary.inserted;

    console.info(
      `[Poller] Cycle #${fetchCount} done — ` +
      `processed: ${summary.processed}, inserted: ${summary.inserted}, ` +
      `skipped: ${summary.skipped}, duplicates: ${summary.duplicates}`
    );

  } catch (err) {
    lastError = err.message;
    console.error('[Poller] Fetch cycle failed:', err.message);
  }

  // ── Heartbeat: write timestamp to DB so the status endpoint
  //    knows the poller is alive, even if no violations were inserted.
  try {
    await supabase
      .from('system_info')
      .update({ last_poll_at: new Date().toISOString() })
      .not('id', 'is', null);  // updates all rows (there's only one)
  } catch (_) { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────
// Build a cron expression from an interval in seconds.
// node-cron minimum resolution is 1 second.
// ─────────────────────────────────────────────────────────────
function buildCronExpression(intervalSec) {
  // For intervals >= 60 s use minute-based cron, else second-based
  if (intervalSec >= 60) {
    const mins = Math.floor(intervalSec / 60);
    return `*/${mins} * * * *`; // every N minutes
  }
  return `*/${intervalSec} * * * * *`; // every N seconds
}

// ─────────────────────────────────────────────────────────────
// Start the poller.
// Reads the interval from the DB, creates the cron job,
// and runs an immediate first fetch.
// ─────────────────────────────────────────────────────────────
async function startPoller() {
  if (isRunning) {
    console.info('[Poller] Already running.');
    return;
  }

  // Lazy-load node-cron only when actually starting the poller
  if (!cron) {
    cron = require('node-cron');
  }

  const config = await loadAIConfig();
  const expr   = buildCronExpression(config.interval);

  console.info(`[Poller] Starting — interval: ${config.interval}s (cron: "${expr}")`);

  cronJob = cron.schedule(expr, runFetchCycle, {
    scheduled : true,
    timezone  : 'UTC',
  });

  isRunning = true;

  // Run immediately so we don't wait for the first cron tick
  runFetchCycle();
}

// ─────────────────────────────────────────────────────────────
// Stop the poller.
// ─────────────────────────────────────────────────────────────
function stopPoller() {
  if (!isRunning || !cronJob) {
    console.info('[Poller] Not running.');
    return;
  }
  cronJob.stop();
  cronJob   = null;
  isRunning = false;
  console.info('[Poller] Stopped.');
}

// ─────────────────────────────────────────────────────────────
// Restart with a new interval (called after settings update).
// ─────────────────────────────────────────────────────────────
async function restartPoller() {
  stopPoller();
  await startPoller();
}

// ─────────────────────────────────────────────────────────────
// Status snapshot — returned by GET /api/ai/status
// ─────────────────────────────────────────────────────────────
function getStatus() {
  return {
    isRunning,
    lastFetchAt,
    lastError,
    fetchCount,
    totalInserted,
  };
}

module.exports = {
  startPoller,
  stopPoller,
  restartPoller,
  runFetchCycle, // exposed for manual trigger via POST /api/ai/fetch
  getStatus,
};
