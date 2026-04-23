// src/routes/fineAmounts.js
// GET /api/fine-amounts     → current fine amounts per violation type
// PUT /api/fine-amounts     → update one or more fine amounts

const express      = require('express');
const { supabase } = require('../config/supabase');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

function assertNoError(error, label) {
  if (error) throw createError(500, `DB error (${label}): ${error.message}`, 'DB_ERROR');
}

// ─────────────────────────────────────────────────────────────
// GET /api/fine-amounts
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('fine_amounts')
      .select('id, violation_type, amount, updated_at')
      .order('amount', { ascending: false });
    assertNoError(error, 'fine amounts');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/fine-amounts
// Body: [{ violation_type, amount }, ...]
// ─────────────────────────────────────────────────────────────
router.put('/', async (req, res, next) => {
  try {
    const amounts = req.body;
    if (!Array.isArray(amounts)) {
      return next(createError(400, 'Body must be an array of { violation_type, amount }', 'VALIDATION'));
    }

    const { data, error } = await supabase
      .from('fine_amounts')
      .upsert(amounts, { onConflict: 'violation_type' })
      .select('*');

    assertNoError(error, 'update fine amounts');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

module.exports = router;
