// src/routes/drivers.js
// GET  /api/drivers                  → paginated + filtered list
// GET  /api/drivers/:id              → full driver profile
// GET  /api/drivers/:id/violations   → driver's violation history
// PATCH /api/drivers/:id/status      → update driver status
// PATCH /api/drivers/:id/assignment  → change driver's route/bus

const express      = require('express');
const { supabase } = require('../config/supabase');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

function assertNoError(error, label) {
  if (error) throw createError(500, `DB error (${label}): ${error.message}`, 'DB_ERROR');
}

// Valid enum values (guard against bad query params)
const VALID_STATUSES    = ['active', 'inactive', 'suspended'];
const VALID_ROUTE_TYPES = ['demanding', 'moderate', 'simple'];

// ─────────────────────────────────────────────────────────────
// GET /api/drivers
// Query params:
//   status     = active | inactive | suspended
//   routeType  = demanding | moderate | simple
//   search     = partial name or license match
//   sortBy     = rank | safety_score | total_violations | name
//   order      = asc | desc
//   page       = 1
//   limit      = 20
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      status, routeType, search,
      sortBy = 'rank', order = 'asc',
      page = 1, limit = 20,
    } = req.query;

    const pageNum  = Math.max(Number(page),  1);
    const pageSize = Math.min(Number(limit), 100);
    const from     = (pageNum - 1) * pageSize;
    const to       = from + pageSize - 1;

    let query = supabase
      .from('v_driver_stats')
      .select(
        'id, name, license_number, initials, avatar_color, status, ' +
        'safety_score, rank, total_violations, phone_violations, ' +
        'sunglasses_violations, drowsiness_violations, smoking_violations, ' +
        'route_id, route_name, route_type, bus_number, recommended_route_type, ' +
        'experience_years, join_date, last_active',
        { count: 'exact' }
      );

    // Filters
    if (status && VALID_STATUSES.includes(status)) {
      query = query.eq('status', status);
    }
    if (routeType && VALID_ROUTE_TYPES.includes(routeType)) {
      query = query.eq('route_type', routeType);
    }
    if (search) {
      query = query.or(`name.ilike.%${search}%,license_number.ilike.%${search}%`);
    }

    // Sorting
    const validSortCols = ['rank', 'safety_score', 'total_violations', 'name'];
    const col = validSortCols.includes(sortBy) ? sortBy : 'rank';
    query = query.order(col, { ascending: order !== 'desc' });

    // Pagination
    query = query.range(from, to);

    const { data, error, count } = await query;
    assertNoError(error, 'drivers list');

    res.json({
      success : true,
      data,
      meta    : { total: count, page: pageNum, limit: pageSize },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/drivers/:id
// Full driver profile from v_driver_stats + recent violations.
// Both queries run in PARALLEL.
// ─────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Run profile + recent violations concurrently
    const [profileResult, violationsResult] = await Promise.all([
      supabase
        .from('v_driver_stats')
        .select('*')
        .eq('id', id)
        .single(),
      supabase
        .from('v_violations_detail')
        .select(
          'id, violation_type, violation_label, image_url, detection_date, ' +
          'start_time, end_time, duration_sec, confidence, status, inserted_at'
        )
        .eq('driver_id', id)
        .order('inserted_at', { ascending: false })
        .limit(50),
    ]);

    if (profileResult.error?.code === 'PGRST116') {
      return next(createError(404, 'Driver not found', 'NOT_FOUND'));
    }

    assertNoError(profileResult.error,    'driver profile');
    assertNoError(violationsResult.error, 'driver violations');

    res.json({
      success : true,
      data    : {
        ...profileResult.data,
        recentViolations: violationsResult.data,
      },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/drivers/:id/violations
// Full paginated violation history for one driver.
// ─────────────────────────────────────────────────────────────
router.get('/:id/violations', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type, status, page = 1, limit = 20 } = req.query;

    const pageNum  = Math.max(Number(page),  1);
    const pageSize = Math.min(Number(limit), 100);
    const from     = (pageNum - 1) * pageSize;
    const to       = from + pageSize - 1;

    let query = supabase
      .from('v_violations_detail')
      .select('*', { count: 'exact' })
      .eq('driver_id', id);

    if (type)   query = query.eq('violation_type', type);
    if (status) query = query.eq('status', status);

    query = query.order('inserted_at', { ascending: false }).range(from, to);

    const { data, error, count } = await query;
    assertNoError(error, 'driver violation history');

    res.json({
      success : true,
      data,
      meta    : { total: count, page: pageNum, limit: pageSize },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/drivers/:id/status
// Body: { status: 'active' | 'inactive' | 'suspended' }
// ─────────────────────────────────────────────────────────────
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return next(createError(400, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`, 'VALIDATION'));
    }

    const { data, error } = await supabase
      .from('drivers')
      .update({
        status,
        last_active: status === 'suspended' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, name, status')
      .single();

    if (error?.code === 'PGRST116') return next(createError(404, 'Driver not found', 'NOT_FOUND'));
    assertNoError(error, 'update driver status');

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/drivers/:id/assignment
// Re-assign a driver to a different route and bus.
// Body: { routeId: 'uuid', busId: 'uuid' }
// Deactivates the current assignment and creates a new one.
// ─────────────────────────────────────────────────────────────
router.patch('/:id/assignment', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { routeId, busId } = req.body;

    if (!routeId || !busId) {
      return next(createError(400, 'routeId and busId are required', 'VALIDATION'));
    }

    // Deactivate current assignment + create new one — in parallel
    const [deactivate, insert] = await Promise.all([
      supabase
        .from('assignments')
        .update({ status: 'inactive', ended_at: new Date().toISOString() })
        .eq('driver_id', id)
        .eq('status', 'active'),
      supabase
        .from('assignments')
        .insert({ driver_id: id, route_id: routeId, bus_id: busId, status: 'active' })
        .select('id')
        .single(),
    ]);

    assertNoError(deactivate.error, 'deactivate old assignment');
    assertNoError(insert.error,     'create new assignment');

    res.json({ success: true, data: { assignmentId: insert.data.id } });
  } catch (err) { next(err); }
});

module.exports = router;
