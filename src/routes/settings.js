// src/routes/settings.js
// GET  /api/settings/all            → all settings in one parallel call
// GET  /api/settings/detection      → detection module settings
// PUT  /api/settings/detection      → update detection settings (bulk)
// GET  /api/settings/route-thresholds
// PUT  /api/settings/route-thresholds
// GET  /api/settings/notifications
// PUT  /api/settings/notifications
// GET  /api/settings/camera
// PUT  /api/settings/camera
// GET  /api/settings/system

const express         = require('express');
const { supabase }    = require('../config/supabase');
const { restartPoller } = require('../services/aiPoller');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

function assertNoError(error, label) {
  if (error) throw createError(500, `DB error (${label}): ${error.message}`, 'DB_ERROR');
}

// ─────────────────────────────────────────────────────────────
// GET /api/settings/all
// Fetches ALL settings tables in parallel — single round-trip
// latency for the Settings page initial load.
// ─────────────────────────────────────────────────────────────
router.get('/all', async (req, res, next) => {
  try {
    const [detection, thresholds, notifications, camera, system, fineAmounts] = await Promise.all([
      supabase.from('detection_settings')   .select('*'),
      supabase.from('route_thresholds')     .select('*').order('min_safety_score', { ascending: false }),
      supabase.from('notification_settings').select('*').limit(1).single(),
      supabase.from('camera_settings')      .select('*').limit(1).single(),
      supabase.from('system_info')          .select('system_version, ai_model_version, api_status, ai_endpoint_url, ai_poll_interval_sec, last_health_check').limit(1).single(),
      supabase.from('fine_amounts')         .select('*').order('amount', { ascending: false }),
    ]);

    // Non-fatal: collect errors and report them alongside data
    const errors = [
      detection.error, thresholds.error, notifications.error,
      camera.error, system.error, fineAmounts.error,
    ].filter(Boolean).map((e) => e.message);

    res.json({
      success : errors.length === 0,
      data: {
        detection     : detection.data,
        thresholds    : thresholds.data,
        notifications : notifications.data,
        camera        : camera.data,
        system        : system.data,
        fineAmounts   : fineAmounts.data,
      },
      errors: errors.length ? errors : undefined,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/settings/detection
// ─────────────────────────────────────────────────────────────
router.get('/detection', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('detection_settings')
      .select('*');
    assertNoError(error, 'detection settings');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/settings/detection
// Bulk-update all detection module settings in one upsert.
// Body: [{ module_name, is_enabled, confidence_threshold }, ...]
// ─────────────────────────────────────────────────────────────
router.put('/detection', async (req, res, next) => {
  try {
    const settings = req.body;
    if (!Array.isArray(settings)) {
      return next(createError(400, 'Body must be an array of detection settings', 'VALIDATION'));
    }

    const { data, error } = await supabase
      .from('detection_settings')
      .upsert(settings, { onConflict: 'module_name' })
      .select('*');

    assertNoError(error, 'update detection settings');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/settings/route-thresholds
// ─────────────────────────────────────────────────────────────
router.get('/route-thresholds', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('route_thresholds')
      .select('*')
      .order('min_safety_score', { ascending: false });
    assertNoError(error, 'route thresholds');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/settings/route-thresholds
// Body: [{ route_type, min_safety_score }, ...]
// ─────────────────────────────────────────────────────────────
router.put('/route-thresholds', async (req, res, next) => {
  try {
    const thresholds = req.body;
    if (!Array.isArray(thresholds)) {
      return next(createError(400, 'Body must be an array of thresholds', 'VALIDATION'));
    }

    const { data, error } = await supabase
      .from('route_thresholds')
      .upsert(thresholds, { onConflict: 'route_type' })
      .select('*');

    assertNoError(error, 'update route thresholds');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/settings/notifications
// ─────────────────────────────────────────────────────────────
router.get('/notifications', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('notification_settings')
      .select('*')
      .limit(1)
      .single();
    assertNoError(error, 'notification settings');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/settings/notifications
// Body: { alert_sound, email_alerts, sms_alerts, auto_flag, auto_suspend_threshold }
// ─────────────────────────────────────────────────────────────
router.put('/notifications', async (req, res, next) => {
  try {
    const { alert_sound, email_alerts, sms_alerts, auto_flag, auto_suspend_threshold } = req.body;

    // Get the existing row's id first
    const { data: existing, error: fetchErr } = await supabase
      .from('notification_settings')
      .select('id')
      .limit(1)
      .single();
    assertNoError(fetchErr, 'fetch notification settings id');

    const { data, error } = await supabase
      .from('notification_settings')
      .update({ alert_sound, email_alerts, sms_alerts, auto_flag, auto_suspend_threshold })
      .eq('id', existing.id)
      .select('*')
      .single();

    assertNoError(error, 'update notification settings');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/settings/camera
// ─────────────────────────────────────────────────────────────
router.get('/camera', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('camera_settings')
      .select('*')
      .limit(1)
      .single();
    assertNoError(error, 'camera settings');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/settings/camera
// Body: { resolution, frame_rate, retention_days, capture_on_detection }
// ─────────────────────────────────────────────────────────────
router.put('/camera', async (req, res, next) => {
  try {
    const { resolution, frame_rate, retention_days, capture_on_detection } = req.body;

    const { data: existing } = await supabase
      .from('camera_settings').select('id').limit(1).single();

    const { data, error } = await supabase
      .from('camera_settings')
      .update({ resolution, frame_rate, retention_days, capture_on_detection })
      .eq('id', existing.id)
      .select('*')
      .single();

    assertNoError(error, 'update camera settings');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/settings/system
// ─────────────────────────────────────────────────────────────
router.get('/system', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('system_info')
      .select('system_version, ai_model_version, api_status, ai_endpoint_url, ai_poll_interval_sec, last_health_check')
      .limit(1)
      .single();
    assertNoError(error, 'system info');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/settings/poll-interval
// Update the AI poll interval and restart the poller.
// Body: { intervalSec: 30 }
// ─────────────────────────────────────────────────────────────
router.put('/poll-interval', async (req, res, next) => {
  try {
    const { intervalSec } = req.body;
    if (!intervalSec || intervalSec < 5) {
      return next(createError(400, 'intervalSec must be >= 5', 'VALIDATION'));
    }

    const { data: existing } = await supabase
      .from('system_info').select('id').limit(1).single();

    const { error } = await supabase
      .from('system_info')
      .update({ ai_poll_interval_sec: intervalSec })
      .eq('id', existing.id);

    assertNoError(error, 'update poll interval');

    // Restart poller with the new interval
    await restartPoller();

    res.json({ success: true, data: { intervalSec } });
  } catch (err) { next(err); }
});

module.exports = router;
