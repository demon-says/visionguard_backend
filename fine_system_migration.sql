-- ============================================================
--  VISION GUARD — Fine System Migration
--  Run this ONCE in the Supabase SQL Editor.
--  Prerequisites: base schema must already be deployed.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. New enum: penalty_type
-- ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'penalty_type') THEN
    CREATE TYPE penalty_type AS ENUM ('fine', 'warning');
  END IF;
END $$;


-- ────────────────────────────────────────────────────────────
-- 2. New table: fine_amounts (configurable fine values)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fine_amounts (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_type  violation_type UNIQUE NOT NULL,
  amount          NUMERIC(10,2)  NOT NULL CHECK (amount >= 0),
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on changes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fine_amounts_updated_at'
  ) THEN
    CREATE TRIGGER trg_fine_amounts_updated_at
    BEFORE UPDATE ON fine_amounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Seed default fine amounts
INSERT INTO fine_amounts (violation_type, amount) VALUES
  ('mobile',     10000.00),
  ('drowsy',     12000.00),
  ('smoking',     8000.00),
  ('sunglasses',  6000.00)
ON CONFLICT (violation_type) DO NOTHING;


-- ────────────────────────────────────────────────────────────
-- 3. New columns on detected_violations
-- ────────────────────────────────────────────────────────────
ALTER TABLE detected_violations
  ADD COLUMN IF NOT EXISTS penalty_type       penalty_type   NULL,
  ADD COLUMN IF NOT EXISTS fine_amount        NUMERIC(10,2)  NULL,
  ADD COLUMN IF NOT EXISTS penalty_issued_at  TIMESTAMPTZ    NULL,
  ADD COLUMN IF NOT EXISTS penalty_issued_by  VARCHAR(100)   NULL;

-- Constraint: fine_amount must match penalty_type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_fine_amount'
  ) THEN
    ALTER TABLE detected_violations
      ADD CONSTRAINT chk_fine_amount
        CHECK (
          (penalty_type = 'fine'    AND fine_amount IS NOT NULL AND fine_amount > 0) OR
          (penalty_type = 'warning' AND fine_amount IS NULL) OR
          (penalty_type IS NULL)
        );
  END IF;
END $$;

-- Index for penalty-based filtering and dashboard aggregates
CREATE INDEX IF NOT EXISTS idx_dv_penalty_type
  ON detected_violations(penalty_type)
  WHERE penalty_type IS NOT NULL;


-- ────────────────────────────────────────────────────────────
-- 4. DB function: get_driver_violation_count
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_driver_violation_count(p_driver_id UUID)
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER
  FROM detected_violations
  WHERE driver_id = p_driver_id;
$$ LANGUAGE SQL STABLE;


-- ────────────────────────────────────────────────────────────
-- 5. DB function: issue_penalty (atomic penalty issuance)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION issue_penalty(
  p_violation_id  UUID,
  p_issued_by     VARCHAR(100)
)
RETURNS TABLE(
  penalty_type    penalty_type,
  fine_amount     NUMERIC,
  violation_count INTEGER
) AS $$
DECLARE
  v_driver_id      UUID;
  v_vtype          violation_type;
  v_vcount         INTEGER;
  v_fine_amount    NUMERIC;
  v_penalty        penalty_type;
BEGIN
  -- Lock the violation row
  SELECT dv.driver_id, dv.violation_type
  INTO   v_driver_id, v_vtype
  FROM   detected_violations dv
  WHERE  dv.id = p_violation_id
  FOR UPDATE;

  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'Violation % has no resolved driver', p_violation_id;
  END IF;

  -- Count driver's total violations
  v_vcount := get_driver_violation_count(v_driver_id);

  -- Decide penalty type
  IF v_vcount > 10 THEN
    v_penalty := 'fine';
    SELECT fa.amount INTO v_fine_amount
    FROM fine_amounts fa
    WHERE fa.violation_type = v_vtype;
  ELSE
    v_penalty     := 'warning';
    v_fine_amount := NULL;
  END IF;

  -- Write penalty to the violation row
  UPDATE detected_violations dv
  SET
    penalty_type      = v_penalty,
    fine_amount       = v_fine_amount,
    penalty_issued_at = NOW(),
    penalty_issued_by = p_issued_by,
    status            = CASE WHEN dv.status = 'pending' THEN 'reviewed' ELSE dv.status END
  WHERE dv.id = p_violation_id;

  RETURN QUERY SELECT v_penalty, v_fine_amount, v_vcount;
END;
$$ LANGUAGE plpgsql;


-- ────────────────────────────────────────────────────────────
-- 6. Update views to include penalty columns
--    Must DROP first because CREATE OR REPLACE cannot change
--    column order in PostgreSQL.
-- ────────────────────────────────────────────────────────────

-- 6a. v_violations_detail — add penalty columns
DROP VIEW IF EXISTS v_violations_detail;
CREATE VIEW v_violations_detail AS
SELECT
  dv.id,
  dv.source_id,
  dv.violation_label,
  dv.violation_type,
  dv.image_name,
  dv.image_url,
  dv.detection_date,
  dv.start_time,
  dv.end_time,
  dv.duration_sec,
  dv.confidence,
  dv.status,
  dv.reviewed_by,
  dv.reviewed_at,
  dv.notes,
  dv.inserted_at,
  -- Penalty columns (NEW)
  dv.penalty_type,
  dv.fine_amount,
  dv.penalty_issued_at,
  dv.penalty_issued_by,
  -- Driver info
  d.id    AS driver_id,
  d.name  AS driver_name,
  d.initials,
  d.avatar_color,
  -- Route info
  r.name        AS route_name,
  r.difficulty  AS route_difficulty,
  -- Bus info
  b.bus_number
FROM detected_violations dv
LEFT JOIN drivers d ON d.id = dv.driver_id
LEFT JOIN buses   b ON b.id = dv.bus_id
LEFT JOIN assignments a ON a.driver_id = d.id AND a.status = 'active'
LEFT JOIN routes   r ON r.id = a.route_id;


-- 6b. v_dashboard_summary — add fine aggregates
DROP VIEW IF EXISTS v_dashboard_summary;
CREATE VIEW v_dashboard_summary AS
SELECT
  COUNT(DISTINCT d.id)                                         AS total_drivers,
  COUNT(DISTINCT d.id) FILTER (WHERE d.status = 'active')     AS active_drivers,
  COUNT(DISTINCT d.id) FILTER (WHERE d.status = 'suspended')  AS suspended_drivers,
  ROUND(AVG(d.safety_score), 1)                               AS avg_safety_score,
  COUNT(DISTINCT a.route_id)                                   AS active_routes,
  -- Today's violations
  COUNT(dv.id) FILTER (WHERE dv.detection_date = CURRENT_DATE) AS violations_today,
  -- All-time
  COUNT(dv.id)                                                 AS total_violations,
  -- By status
  COUNT(dv.id) FILTER (WHERE dv.status = 'pending')           AS pending_violations,
  COUNT(dv.id) FILTER (WHERE dv.status = 'flagged')           AS flagged_violations,
  COUNT(dv.id) FILTER (WHERE dv.status = 'reviewed')          AS reviewed_violations,
  -- By type (all-time)
  COUNT(dv.id) FILTER (WHERE dv.violation_type = 'mobile')    AS total_phone,
  COUNT(dv.id) FILTER (WHERE dv.violation_type = 'sunglasses') AS total_sunglasses,
  COUNT(dv.id) FILTER (WHERE dv.violation_type = 'drowsy')    AS total_drowsy,
  COUNT(dv.id) FILTER (WHERE dv.violation_type = 'smoking')   AS total_smoking,
  -- Fine aggregates (NEW)
  COUNT(dv.id)  FILTER (WHERE dv.penalty_type = 'fine')       AS total_fines_issued,
  COUNT(dv.id)  FILTER (WHERE dv.penalty_type = 'warning')    AS total_warnings_issued,
  COALESCE(SUM(dv.fine_amount) FILTER (WHERE dv.penalty_type = 'fine'), 0) AS total_fines_value
FROM drivers d
LEFT JOIN assignments         a  ON a.driver_id = d.id AND a.status = 'active'
LEFT JOIN detected_violations dv ON dv.driver_id = d.id;


-- 6c. v_driver_stats — add per-driver fine summary
DROP VIEW IF EXISTS v_driver_stats;
CREATE VIEW v_driver_stats AS
SELECT
  d.id,
  d.name,
  d.license_number,
  d.phone,
  d.age,
  d.experience_years,
  d.initials,
  d.avatar_color,
  d.status,
  d.safety_score,
  d.rank,
  d.join_date,
  d.last_active,
  d.created_at,
  -- Violation breakdown
  COUNT(dv.id)                                                   AS total_violations,
  COUNT(CASE WHEN dv.violation_type = 'mobile'     THEN 1 END)  AS phone_violations,
  COUNT(CASE WHEN dv.violation_type = 'sunglasses' THEN 1 END)  AS sunglasses_violations,
  COUNT(CASE WHEN dv.violation_type = 'drowsy'     THEN 1 END)  AS drowsiness_violations,
  COUNT(CASE WHEN dv.violation_type = 'smoking'    THEN 1 END)  AS smoking_violations,
  -- Fine summary (NEW)
  COUNT(dv.id)  FILTER (WHERE dv.penalty_type = 'fine')         AS total_fines_count,
  COUNT(dv.id)  FILTER (WHERE dv.penalty_type = 'warning')      AS total_warnings_count,
  COALESCE(SUM(dv.fine_amount) FILTER (WHERE dv.penalty_type = 'fine'), 0) AS total_fines_value,
  -- Current assignment
  r.id          AS route_id,
  r.name        AS route_name,
  r.difficulty  AS route_type,
  b.id          AS bus_id,
  b.bus_number,
  b.source_id,
  -- Recommended route based on current score
  recommend_route_type(d.safety_score) AS recommended_route_type
FROM drivers d
LEFT JOIN assignments           a  ON a.driver_id = d.id AND a.status = 'active'
LEFT JOIN routes                r  ON r.id = a.route_id
LEFT JOIN buses                 b  ON b.id = a.bus_id
LEFT JOIN detected_violations   dv ON dv.driver_id = d.id
GROUP BY
  d.id, d.name, d.license_number, d.phone, d.age, d.experience_years,
  d.initials, d.avatar_color, d.status, d.safety_score, d.rank,
  d.join_date, d.last_active, d.created_at,
  r.id, r.name, r.difficulty,
  b.id, b.bus_number, b.source_id;


-- ────────────────────────────────────────────────────────────
-- 7. RLS policies for fine_amounts
-- ────────────────────────────────────────────────────────────
ALTER TABLE fine_amounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read fine_amounts"
  ON fine_amounts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated write fine_amounts"
  ON fine_amounts FOR ALL TO authenticated USING (true);


-- ============================================================
-- END OF FINE SYSTEM MIGRATION
-- ============================================================
