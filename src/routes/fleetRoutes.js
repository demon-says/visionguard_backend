// src/routes/fleetRoutes.js
// Named "fleetRoutes" to avoid clash with Express Router naming.
//
// GET  /api/routes               → all routes with assigned driver
// GET  /api/routes/:id           → single route detail
// GET  /api/routes/recommend/:driverId → recommended route for a driver
// PATCH /api/routes/:id/assign   → assign a driver to a route

const express      = require('express');
const { supabase } = require('../config/supabase');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

function assertNoError(error, label) {
  if (error) throw createError(500, `DB error (${label}): ${error.message}`, 'DB_ERROR');
}

const VALID_DIFFICULTIES = ['demanding', 'moderate', 'simple'];

// ─────────────────────────────────────────────────────────────
// GET /api/routes
// Query params: difficulty = demanding | moderate | simple
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { difficulty } = req.query;

    let query = supabase
      .from('v_route_assignments')
      .select('*');

    if (difficulty && VALID_DIFFICULTIES.includes(difficulty)) {
      query = query.eq('difficulty', difficulty);
    }

    query = query.order('difficulty', { ascending: true });

    const { data, error } = await query;
    assertNoError(error, 'routes list');

    // The view doesn't include bus_id, only source_id.
    // Resolve bus_id from the buses table so the frontend can reassign.
    const sourceIds = data.map((r) => r.source_id).filter(Boolean);
    let busMap = {};
    if (sourceIds.length > 0) {
      const { data: buses } = await supabase
        .from('buses')
        .select('id, source_id')
        .in('source_id', sourceIds);
      if (buses) {
        buses.forEach((b) => { busMap[b.source_id] = b.id; });
      }
    }

    // Enrich each route with bus_id
    data.forEach((route) => {
      if (!route.bus_id && route.source_id) {
        route.bus_id = busMap[route.source_id] || null;
      }
    });

    // Also fetch route-level totals from violations
    const busIds = data.map((r) => r.bus_id).filter(Boolean);
    if (busIds.length > 0) {
      const { data: totals, error: totalsErr } = await supabase
        .from('detected_violations')
        .select('bus_id, violation_type')
        .in('bus_id', busIds);
      // Non-fatal: totals are nice-to-have
      if (!totalsErr && totals) {
        const countByBus = {};
        totals.forEach(({ bus_id }) => {
          countByBus[bus_id] = (countByBus[bus_id] || 0) + 1;
        });
        data.forEach((route) => {
          route.totalViolationsOnRoute = countByBus[route.bus_id] || 0;
        });
      }
    }

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/routes/:id
// Single route with assigned driver details.
// ─────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('v_route_assignments')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error?.code === 'PGRST116') return next(createError(404, 'Route not found', 'NOT_FOUND'));
    assertNoError(error, 'route detail');

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/routes/recommend/:driverId
// Returns the recommended route difficulty for a given driver
// based on their current safety score and the configured thresholds.
// ─────────────────────────────────────────────────────────────
router.get('/recommend/:driverId', async (req, res, next) => {
  try {
    const { driverId } = req.params;

    // Get driver's current safety score + thresholds in parallel
    const [driverRes, thresholdsRes] = await Promise.all([
      supabase
        .from('drivers')
        .select('id, name, safety_score')
        .eq('id', driverId)
        .single(),
      supabase
        .from('route_thresholds')
        .select('route_type, min_safety_score')
        .order('min_safety_score', { ascending: false }),
    ]);

    if (driverRes.error?.code === 'PGRST116') {
      return next(createError(404, 'Driver not found', 'NOT_FOUND'));
    }
    assertNoError(driverRes.error,     'driver for recommendation');
    assertNoError(thresholdsRes.error, 'route thresholds');

    const { safety_score } = driverRes.data;
    const thresholds = thresholdsRes.data;

    // Determine recommendation (same logic as DB function)
    let recommended = 'simple';
    for (const threshold of thresholds) {
      if (safety_score >= threshold.min_safety_score) {
        recommended = threshold.route_type;
        break;
      }
    }

    res.json({
      success: true,
      data: {
        driverId,
        driverName    : driverRes.data.name,
        safetyScore   : safety_score,
        recommended,
        thresholds,
      },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/routes/:id/assign
// Assign a driver to a route (and optionally a bus).
// Body: { driverId: 'uuid', busId: 'uuid' }
// Deactivates old assignment for both the driver and the bus,
// then creates a new active one — all in parallel where possible.
// ─────────────────────────────────────────────────────────────
router.patch('/:id/assign', async (req, res, next) => {
  try {
    const { id: routeId } = req.params;
    const { driverId, busId } = req.body;

    if (!driverId || !busId) {
      return next(createError(400, 'driverId and busId are required', 'VALIDATION'));
    }

    // Deactivate any current active assignments for this driver AND this bus
    // — run both deactivations in parallel
    await Promise.all([
      supabase
        .from('assignments')
        .update({ status: 'inactive', ended_at: new Date().toISOString() })
        .eq('driver_id', driverId)
        .eq('status', 'active'),
      supabase
        .from('assignments')
        .update({ status: 'inactive', ended_at: new Date().toISOString() })
        .eq('bus_id', busId)
        .eq('status', 'active'),
    ]);

    // Create the new assignment
    const { data, error } = await supabase
      .from('assignments')
      .insert({
        driver_id : driverId,
        bus_id    : busId,
        route_id  : routeId,
        status    : 'active',
      })
      .select('id')
      .single();

    assertNoError(error, 'create assignment');

    res.json({ success: true, data: { assignmentId: data.id } });
  } catch (err) { next(err); }
});

module.exports = router;
