// src/routes/penalties.js
// POST  /api/penalties/:violationId        → issue fine or warning on a violation
// GET   /api/penalties/driver/:driverId    → all penalties for a driver (paginated)
// GET   /api/penalties/summary             → total fines count + value (dashboard use)

const express      = require('express');
const { supabase } = require('../config/supabase');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

function assertNoError(error, label) {
  if (error) throw createError(500, `DB error (${label}): ${error.message}`, 'DB_ERROR');
}

// ─────────────────────────────────────────────────────────────
// POST /api/penalties/:violationId
// Body: { issuedBy: 'Admin Name' }
// Calls the DB function issue_penalty() which handles
// eligibility (fine vs warning) atomically.
// ─────────────────────────────────────────────────────────────
router.post('/:violationId', async (req, res, next) => {
  try {
    const { violationId } = req.params;
    const { issuedBy = 'System' } = req.body;

    const { data, error } = await supabase
      .rpc('issue_penalty', {
        p_violation_id : violationId,
        p_issued_by    : issuedBy,
      });

    if (error) {
      if (error.message.includes('no resolved driver')) {
        return next(createError(422, 'Violation has no resolved driver — cannot issue penalty', 'NO_DRIVER'));
      }
      return next(createError(500, `DB error (issue_penalty): ${error.message}`, 'DB_ERROR'));
    }

    const result = data?.[0];
    res.status(201).json({
      success : true,
      data    : {
        penaltyType     : result.penalty_type,
        fineAmount      : result.fine_amount,
        violationCount  : result.violation_count,
        message         : result.penalty_type === 'fine'
          ? `Fine of PKR ${Number(result.fine_amount).toLocaleString()} issued.`
          : `Warning issued (driver has ${result.violation_count} violations — fine threshold not yet reached).`,
      },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/penalties/driver/:driverId?page=1&limit=20
// Returns paginated violations that have a penalty attached.
// ─────────────────────────────────────────────────────────────
router.get('/driver/:driverId', async (req, res, next) => {
  try {
    const { driverId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const pageNum  = Math.max(Number(page), 1);
    const pageSize = Math.min(Number(limit), 100);
    const from     = (pageNum - 1) * pageSize;
    const to       = from + pageSize - 1;

    const { data, error, count } = await supabase
      .from('v_violations_detail')
      .select('id, violation_type, violation_label, detection_date, start_time, penalty_type, fine_amount, penalty_issued_at, penalty_issued_by', { count: 'exact' })
      .eq('driver_id', driverId)
      .not('penalty_type', 'is', null)
      .order('penalty_issued_at', { ascending: false })
      .range(from, to);

    assertNoError(error, 'driver penalties');

    res.json({
      success : true,
      data,
      meta    : { total: count, page: pageNum, limit: pageSize },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// GET /api/penalties/summary
// Returns total fines count and total value — used by dashboard
// ─────────────────────────────────────────────────────────────
router.get('/summary', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('v_dashboard_summary')
      .select('total_fines_issued, total_warnings_issued, total_fines_value')
      .single();

    assertNoError(error, 'penalties summary');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

module.exports = router;
