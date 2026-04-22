// src/routes/dashboard.js
// GET /api/dashboard/summary        → fleet-level KPI cards
// GET /api/dashboard/recent         → latest N violations
// GET /api/dashboard/top-drivers    → top 3 ranked drivers
// GET /api/dashboard/bottom-drivers → bottom 3 ranked drivers
// GET /api/dashboard/weekly-trend   → last 7 days violation counts
// GET /api/dashboard/violation-mix  → all-time breakdown by type

const express    = require('express');
const { supabase } = require('../config/supabase');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

// ── Helper: throw on Supabase error ──────────────────────────
function assertNoError(error, label) {
  if (error) throw createError(500, `DB error (${label}): ${error.message}`, 'DB_ERROR');
}

// ─────────────────────────────────────────────────────────────
// GET /api/dashboard/summary
// Uses the v_dashboard_summary view (single-row aggregate).
// ─────────────────────────────────────────────────────────────
router.get('/summary', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('v_dashboard_summary')
      .select('*')
      .single();

    assertNoError(error, 'v_dashboard_summary');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/dashboard/recent?limit=5
// Latest violations with driver name and route context.
// ─────────────────────────────────────────────────────────────
router.get('/recent', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 5, 20);

    const { data, error } = await supabase
      .from('v_violations_detail')
      .select(
        'id, violation_type, violation_label, driver_name, initials, ' +
        'avatar_color, route_name, confidence, status, detection_date, ' +
        'start_time, image_url, bus_number'
      )
      .order('inserted_at', { ascending: false })
      .limit(limit);

    assertNoError(error, 'recent violations');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/dashboard/top-drivers?limit=3
// Highest-ranked (lowest rank number) active drivers.
// ─────────────────────────────────────────────────────────────
router.get('/top-drivers', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 3, 10);

    const { data, error } = await supabase
      .from('v_driver_stats')
      .select(
        'id, name, initials, avatar_color, rank, safety_score, ' +
        'total_violations, route_name, route_type, status'
      )
      .eq('status', 'active')
      .order('rank', { ascending: true })
      .limit(limit);

    assertNoError(error, 'top drivers');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/dashboard/bottom-drivers?limit=3
// Lowest-ranked drivers (any status).
// ─────────────────────────────────────────────────────────────
router.get('/bottom-drivers', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 3, 10);

    const { data, error } = await supabase
      .from('v_driver_stats')
      .select(
        'id, name, initials, avatar_color, rank, safety_score, ' +
        'total_violations, route_name, route_type, status'
      )
      .order('rank', { ascending: false })
      .limit(limit);

    assertNoError(error, 'bottom drivers');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/dashboard/weekly-trend
// Last 7 calendar days grouped by date and violation type.
// Parallel DB query for efficiency.
// ─────────────────────────────────────────────────────────────
router.get('/weekly-trend', async (req, res, next) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const from = sevenDaysAgo.toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('v_daily_violation_trend')
      .select('detection_date, total, phone, sunglasses, drowsy, smoking')
      .gte('detection_date', from)
      .order('detection_date', { ascending: true });

    assertNoError(error, 'weekly trend');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/dashboard/violation-mix
// All-time violation counts per type (for pie/donut chart).
// ─────────────────────────────────────────────────────────────
router.get('/violation-mix', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('v_dashboard_summary')
      .select('total_phone, total_sunglasses, total_drowsy, total_smoking')
      .single();

    assertNoError(error, 'violation mix');

    // Shape it for the Recharts PieChart the frontend already uses
    const shaped = [
      { name: 'Phone Usage',  value: data.total_phone,      color: '#f97316' },
      { name: 'Drowsiness',   value: data.total_drowsy,     color: '#ef4444' },
      { name: 'Sunglasses',   value: data.total_sunglasses, color: '#eab308' },
      { name: 'Smoking',      value: data.total_smoking,    color: '#a855f7' },
    ];

    res.json({ success: true, data: shaped });
  } catch (err) { next(err); }
});

module.exports = router;
