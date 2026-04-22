// src/routes/reports.js
// All analytics queries for the Reports page.
// Heavy use of Promise.all() — every multi-query endpoint
// fires all DB calls in parallel.
//
// GET /api/reports/kpis                 → top KPI cards
// GET /api/reports/daily-trend          → daily totals (line chart)
// GET /api/reports/monthly-comparison   → this month vs last month weekly
// GET /api/reports/hourly-pattern       → violations by hour (bar chart)
// GET /api/reports/violation-mix        → type breakdown (pie chart)
// GET /api/reports/driver-scores        → driver score ranking (bar chart)

const express      = require('express');
const { supabase } = require('../config/supabase');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

function assertNoError(error, label) {
  if (error) throw createError(500, `DB error (${label}): ${error.message}`, 'DB_ERROR');
}

// ─────────────────────────────────────────────────────────────
// GET /api/reports/kpis
// Total violations, fleet safety score, improved drivers,
// detection accuracy — all in one parallel call.
// ─────────────────────────────────────────────────────────────
router.get('/kpis', async (req, res, next) => {
  try {
    const [summaryRes, improvedRes] = await Promise.all([
      supabase
        .from('v_dashboard_summary')
        .select('total_violations, avg_safety_score')
        .single(),
      // "Improved" = drivers whose safety score > 70 and status = active
      supabase
        .from('drivers')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active')
        .gt('safety_score', 70),
    ]);

    assertNoError(summaryRes.error,  'kpi summary');
    assertNoError(improvedRes.error, 'improved drivers');

    res.json({
      success: true,
      data: {
        totalViolations  : summaryRes.data.total_violations,
        fleetSafetyScore : summaryRes.data.avg_safety_score,
        driversImproved  : improvedRes.count ?? 0,
        // Detection accuracy is informational; you can wire this
        // to a real metric when the AI exposes it
        detectionAccuracy: 94,
      },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reports/daily-trend?days=30
// Daily violation counts over the last N days.
// ─────────────────────────────────────────────────────────────
router.get('/daily-trend', async (req, res, next) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    const fromStr = from.toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('v_daily_violation_trend')
      .select('detection_date, total, phone, sunglasses, drowsy, smoking')
      .gte('detection_date', fromStr)
      .order('detection_date', { ascending: true });

    assertNoError(error, 'daily trend');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reports/monthly-comparison
// Current month vs previous month, grouped into weeks.
// Both month queries fire in parallel.
// ─────────────────────────────────────────────────────────────
router.get('/monthly-comparison', async (req, res, next) => {
  try {
    const now       = new Date();
    const thisYear  = now.getFullYear();
    const thisMonth = now.getMonth() + 1; // 1-based

    // First day of this month and last month
    const thisMonthStart = `${thisYear}-${String(thisMonth).padStart(2,'0')}-01`;
    const lastMonth      = thisMonth === 1 ? 12 : thisMonth - 1;
    const lastMonthYear  = thisMonth === 1 ? thisYear - 1 : thisYear;
    const lastMonthStart = `${lastMonthYear}-${String(lastMonth).padStart(2,'0')}-01`;
    const lastMonthEnd   = new Date(thisYear, thisMonth - 1, 0)
      .toISOString().split('T')[0]; // last day of previous month

    const [thisMonthRes, lastMonthRes] = await Promise.all([
      supabase
        .from('v_daily_violation_trend')
        .select('detection_date, total')
        .gte('detection_date', thisMonthStart)
        .order('detection_date', { ascending: true }),
      supabase
        .from('v_daily_violation_trend')
        .select('detection_date, total')
        .gte('detection_date', lastMonthStart)
        .lte('detection_date', lastMonthEnd)
        .order('detection_date', { ascending: true }),
    ]);

    assertNoError(thisMonthRes.error, 'this month trend');
    assertNoError(lastMonthRes.error, 'last month trend');

    res.json({
      success: true,
      data: {
        thisMonth: thisMonthRes.data,
        lastMonth: lastMonthRes.data,
      },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reports/hourly-pattern
// At which hours do most violations occur?
// ─────────────────────────────────────────────────────────────
router.get('/hourly-pattern', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('v_hourly_violation_pattern')
      .select('hour, total_violations, phone, sunglasses, drowsy, smoking');

    assertNoError(error, 'hourly pattern');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reports/violation-mix
// All-time percentage breakdown by type.
// ─────────────────────────────────────────────────────────────
router.get('/violation-mix', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('v_dashboard_summary')
      .select('total_violations, total_phone, total_sunglasses, total_drowsy, total_smoking')
      .single();

    assertNoError(error, 'violation mix');

    const total = data.total_violations || 1; // avoid divide-by-zero
    const shaped = [
      { name: 'Phone Usage',  value: data.total_phone,      pct: +((data.total_phone      / total) * 100).toFixed(1), color: '#f97316' },
      { name: 'Drowsiness',   value: data.total_drowsy,     pct: +((data.total_drowsy     / total) * 100).toFixed(1), color: '#ef4444' },
      { name: 'Sunglasses',   value: data.total_sunglasses, pct: +((data.total_sunglasses / total) * 100).toFixed(1), color: '#eab308' },
      { name: 'Smoking',      value: data.total_smoking,    pct: +((data.total_smoking    / total) * 100).toFixed(1), color: '#a855f7' },
    ];

    res.json({ success: true, data: shaped });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/reports/driver-scores
// All drivers ranked by safety score for the bar chart.
// ─────────────────────────────────────────────────────────────
router.get('/driver-scores', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('v_driver_stats')
      .select('id, name, initials, avatar_color, safety_score, rank, total_violations, route_type')
      .order('safety_score', { ascending: false });

    assertNoError(error, 'driver scores');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

module.exports = router;
