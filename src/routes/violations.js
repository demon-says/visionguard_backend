// src/routes/violations.js
// GET   /api/violations                → paginated log with filters
// GET   /api/violations/:id            → single violation detail
// PATCH /api/violations/:id            → update one violation's status/notes
// PATCH /api/violations/bulk           → bulk status update

const express      = require('express');
const { supabase } = require('../config/supabase');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

function assertNoError(error, label) {
  if (error) throw createError(500, `DB error (${label}): ${error.message}`, 'DB_ERROR');
}

const VALID_STATUSES = ['pending', 'reviewed', 'flagged'];
const VALID_TYPES    = ['mobile', 'sunglasses', 'drowsy', 'smoking'];

// ─────────────────────────────────────────────────────────────
// GET /api/violations
// Query params:
//   type       = mobile | sunglasses | drowsy | smoking
//   status     = pending | reviewed | flagged
//   driverName = partial match
//   dateFrom   = YYYY-MM-DD
//   dateTo     = YYYY-MM-DD
//   page, limit
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      type, status, driverName,
      dateFrom, dateTo,
      page = 1, limit = 20,
    } = req.query;

    const pageNum  = Math.max(Number(page),  1);
    const pageSize = Math.min(Number(limit), 100);
    const from     = (pageNum - 1) * pageSize;
    const to       = from + pageSize - 1;

    let query = supabase
      .from('v_violations_detail')
      .select('*', { count: 'exact' });

    if (type       && VALID_TYPES.includes(type))       query = query.eq('violation_type', type);
    if (status     && VALID_STATUSES.includes(status))  query = query.eq('status', status);
    if (driverName) query = query.ilike('driver_name', `%${driverName}%`);
    if (dateFrom)   query = query.gte('detection_date', dateFrom);
    if (dateTo)     query = query.lte('detection_date', dateTo);

    query = query
      .order('inserted_at', { ascending: false })
      .range(from, to);

    const { data, error, count } = await query;
    assertNoError(error, 'violations list');

    res.json({
      success : true,
      data,
      meta    : { total: count, page: pageNum, limit: pageSize },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/violations/:id
// Single violation with full driver + route context.
// ─────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('v_violations_detail')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error?.code === 'PGRST116') return next(createError(404, 'Violation not found', 'NOT_FOUND'));
    assertNoError(error, 'violation detail');

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/violations/:id
// Body: { status, notes, reviewedBy }
// ─────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const { status, notes, reviewedBy } = req.body;

    if (status && !VALID_STATUSES.includes(status)) {
      return next(createError(400, `Invalid status. Must be: ${VALID_STATUSES.join(', ')}`, 'VALIDATION'));
    }

    const updates = {};
    if (status)     { updates.status      = status; }
    if (notes)      { updates.notes       = notes; }
    if (reviewedBy) {
      updates.reviewed_by = reviewedBy;
      updates.reviewed_at = new Date().toISOString();
    }

    if (Object.keys(updates).length === 0) {
      return next(createError(400, 'No updatable fields provided', 'VALIDATION'));
    }

    const { data, error } = await supabase
      .from('detected_violations')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, status, reviewed_by, reviewed_at')
      .single();

    if (error?.code === 'PGRST116') return next(createError(404, 'Violation not found', 'NOT_FOUND'));
    assertNoError(error, 'update violation');

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/violations/bulk
// Bulk-update status for multiple violations in ONE DB call.
// Body: { ids: ['uuid', ...], status: 'reviewed', reviewedBy: 'Admin' }
// ─────────────────────────────────────────────────────────────
router.patch('/bulk', async (req, res, next) => {
  try {
    const { ids, status, reviewedBy } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return next(createError(400, 'ids must be a non-empty array', 'VALIDATION'));
    }
    if (!VALID_STATUSES.includes(status)) {
      return next(createError(400, `Invalid status. Must be: ${VALID_STATUSES.join(', ')}`, 'VALIDATION'));
    }

    const updates = {
      status,
      reviewed_by: reviewedBy || null,
      reviewed_at: status === 'reviewed' ? new Date().toISOString() : null,
    };

    const { data, error } = await supabase
      .from('detected_violations')
      .update(updates)
      .in('id', ids)
      .select('id, status');

    assertNoError(error, 'bulk update violations');

    res.json({
      success  : true,
      data     : { updated: data?.length ?? 0 },
    });
  } catch (err) { next(err); }
});

module.exports = router;
