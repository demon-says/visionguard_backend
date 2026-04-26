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
        .select('id, source_id, bus_number')
        .in('source_id', sourceIds);
      if (buses) {
        buses.forEach((b) => { busMap[b.source_id] = b; });
      }
    }

    // Enrich each route with bus_id
    data.forEach((route) => {
      if (!route.bus_id && route.source_id && busMap[route.source_id]) {
        route.bus_id = busMap[route.source_id].id;
      }
    });

    // For routes still missing bus info (no active assignment),
    // look up the most recent assignment (even inactive) to recover the bus link.
    const routesMissingBus = data.filter((r) => !r.bus_id);
    if (routesMissingBus.length > 0) {
      const missingRouteIds = routesMissingBus.map((r) => r.id);
      const { data: pastAssignments } = await supabase
        .from('assignments')
        .select('route_id, bus_id, buses(id, bus_number, source_id)')
        .in('route_id', missingRouteIds)
        .order('created_at', { ascending: false });

      if (pastAssignments) {
        // Take the most recent assignment per route
        const routeBusMap = {};
        pastAssignments.forEach((a) => {
          if (!routeBusMap[a.route_id] && a.bus_id) {
            routeBusMap[a.route_id] = a;
          }
        });
        data.forEach((route) => {
          if (!route.bus_id && routeBusMap[route.id]) {
            const past = routeBusMap[route.id];
            route.bus_id = past.bus_id;
            if (past.buses) {
              route.bus_number = past.buses.bus_number || route.bus_number;
              route.source_id = past.buses.source_id || route.source_id;
            }
          }
        });
      }
    }

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
// Validates driver safety score against route difficulty:
//   >= 85  → demanding, moderate, simple
//   60-84  → moderate, simple
//   30-59  → simple only
//   < 30   → cannot be assigned
// ─────────────────────────────────────────────────────────────
router.patch('/:id/assign', async (req, res, next) => {
  try {
    const { id: routeId } = req.params;
    const { driverId, busId } = req.body;

    if (!driverId || !busId) {
      return next(createError(400, 'driverId and busId are required', 'VALIDATION'));
    }

    // Fetch driver safety score and route difficulty in parallel
    const [driverRes, routeRes] = await Promise.all([
      supabase.from('drivers').select('id, name, safety_score').eq('id', driverId).single(),
      supabase.from('routes').select('id, name, difficulty').eq('id', routeId).single(),
    ]);

    if (driverRes.error?.code === 'PGRST116') return next(createError(404, 'Driver not found', 'NOT_FOUND'));
    if (routeRes.error?.code === 'PGRST116') return next(createError(404, 'Route not found', 'NOT_FOUND'));
    assertNoError(driverRes.error, 'fetch driver');
    assertNoError(routeRes.error, 'fetch route');

    const score = Number(driverRes.data.safety_score);
    const difficulty = routeRes.data.difficulty;

    // Skip safety score validation for BUS-001 (test bus)
    const { data: busRow } = await supabase
      .from('buses').select('bus_number').eq('id', busId).single();
    const isTestBus = busRow?.bus_number === 'BUS-001';

    if (!isTestBus) {
      // Determine allowed difficulties based on safety score
      let allowedDifficulties = [];
      if (score >= 85) {
        allowedDifficulties = ['demanding', 'moderate', 'simple'];
      } else if (score >= 60) {
        allowedDifficulties = ['moderate', 'simple'];
      } else if (score >= 30) {
        allowedDifficulties = ['simple'];
      }
      // score < 30 → empty array → cannot assign

      if (!allowedDifficulties.includes(difficulty)) {
        const reason = score < 30
          ? `${driverRes.data.name} has a safety score of ${score}%, which is too low to be assigned any route.`
          : `${driverRes.data.name} has a safety score of ${score}%, which is too low for a ${difficulty} route. Eligible: ${allowedDifficulties.join(', ')}.`;
        return next(createError(400, reason, 'SCORE_TOO_LOW'));
      }
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
