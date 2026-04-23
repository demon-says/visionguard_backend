-- ============================================================
--  VISION GUARD — Complete Supabase Database Schema
--  Platform : Supabase (PostgreSQL 15+)
--  Author   : Vision Guard Project
-- ============================================================
-- Execution order matters — run this file top-to-bottom once
-- in the Supabase SQL Editor.
-- ============================================================


-- ============================================================
-- 0. EXTENSIONS
-- ============================================================
-- pgcrypto gives us gen_random_uuid() on older Supabase instances
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================
-- 1. ENUMS  (controlled vocabularies)
-- ============================================================

-- Matches AI raw_label values exactly
CREATE TYPE violation_type AS ENUM (
  'mobile',       -- "USING CELL PHONE / AIR BUDS"
  'sunglasses',   -- sunglasses detected
  'drowsy',       -- drowsiness / sleeping
  'smoking'       -- smoking detected
);

-- Route difficulty used by route decision logic
CREATE TYPE route_difficulty AS ENUM (
  'demanding',
  'moderate',
  'simple'
);

-- Driver operational status
CREATE TYPE driver_status AS ENUM (
  'active',
  'inactive',
  'suspended'
);

-- Violation review workflow status
CREATE TYPE violation_status AS ENUM (
  'pending',    -- newly stored, not yet reviewed
  'reviewed',   -- administrator has reviewed it
  'flagged'     -- marked for special attention
);

-- Assignment record status
CREATE TYPE assignment_status AS ENUM (
  'active',
  'inactive'
);


-- ============================================================
-- 2. HELPER: auto-update updated_at on any table
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 3. CORE TABLES
-- ============================================================

-- ------------------------------------------------------------
-- 3a. DRIVERS
--     Master record for every driver in the fleet.
--     safety_score and rank are maintained automatically
--     by triggers after each violation insert.
-- ------------------------------------------------------------
CREATE TABLE drivers (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name             VARCHAR(100) NOT NULL,
  license_number   VARCHAR(60)  UNIQUE NOT NULL,
  phone            VARCHAR(25),
  age              SMALLINT     CHECK (age BETWEEN 18 AND 80),
  experience_years SMALLINT     DEFAULT 0 CHECK (experience_years >= 0),

  -- Display helpers (used by frontend avatar)
  initials         VARCHAR(5),
  avatar_color     VARCHAR(10)  DEFAULT '#6366f1',

  -- Operational
  status           driver_status NOT NULL DEFAULT 'active',
  join_date        DATE,
  last_active      TIMESTAMPTZ,

  -- Calculated fields (kept denormalised for fast reads)
  -- Updated automatically by trigger on detected_violations
  safety_score     NUMERIC(5,2) NOT NULL DEFAULT 100.00
                   CHECK (safety_score BETWEEN 0 AND 100),
  rank             INTEGER,     -- 1 = best; recalculated after every violation

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_drivers_updated_at
BEFORE UPDATE ON drivers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 3b. BUSES
--     Each bus/vehicle unit monitored by the AI.
--     source_id is the key that links AI output to a bus.
-- ------------------------------------------------------------
CREATE TABLE buses (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_number  VARCHAR(30)  UNIQUE NOT NULL,  -- e.g. "BUS-101"

  -- This must match the key returned by the AI JSON (e.g. "WEBCAM-01")
  source_id   VARCHAR(60)  UNIQUE NOT NULL,

  status      VARCHAR(20)  NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'inactive', 'maintenance')),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_buses_updated_at
BEFORE UPDATE ON buses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 3c. ROUTES
--     Route definitions and difficulty classification.
--     difficulty drives the route-assignment decision logic.
-- ------------------------------------------------------------
CREATE TABLE routes (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 VARCHAR(120)  NOT NULL,
  from_location        VARCHAR(100),
  to_location          VARCHAR(100),
  distance_km          NUMERIC(7,2)  CHECK (distance_km > 0),
  stops                SMALLINT      CHECK (stops >= 0),
  daily_trips          SMALLINT      CHECK (daily_trips >= 0),
  avg_travel_time_min  SMALLINT      CHECK (avg_travel_time_min > 0),
  passenger_capacity   SMALLINT      CHECK (passenger_capacity >= 0),
  difficulty           route_difficulty NOT NULL,
  description          TEXT,

  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_routes_updated_at
BEFORE UPDATE ON routes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 3d. ASSIGNMENTS
--     Connects a driver ↔ bus ↔ route at a point in time.
--     Only ONE active assignment per driver at a time.
--     This is how the backend identifies the driver from a
--     source_id without facial recognition.
-- ------------------------------------------------------------
CREATE TABLE assignments (
  id            UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id     UUID              NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  bus_id        UUID              NOT NULL REFERENCES buses(id)   ON DELETE CASCADE,
  route_id      UUID              NOT NULL REFERENCES routes(id)  ON DELETE CASCADE,
  status        assignment_status NOT NULL DEFAULT 'active',
  assigned_date TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,      -- set when status → inactive

  created_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- Only one ACTIVE assignment allowed per driver at a time
CREATE UNIQUE INDEX uq_driver_active_assignment
  ON assignments(driver_id)
  WHERE status = 'active';

-- Only one ACTIVE assignment allowed per bus at a time
CREATE UNIQUE INDEX uq_bus_active_assignment
  ON assignments(bus_id)
  WHERE status = 'active';


-- ------------------------------------------------------------
-- 3e. DETECTED VIOLATIONS
--     Core analytical table.
--     Every AI detection event ends up here.
--     Powers: dashboard cards, charts, driver ranking,
--             reports, route decisions, violation log.
-- ------------------------------------------------------------
CREATE TABLE detected_violations (
  id              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),

  -- AI traceability
  source_id       VARCHAR(60)      NOT NULL,  -- from AI JSON top-level key
  image_name      VARCHAR(200),
  image_url       TEXT,

  -- Resolved through assignments (no face recognition needed)
  bus_id          UUID             REFERENCES buses(id)   ON DELETE SET NULL,
  driver_id       UUID             REFERENCES drivers(id) ON DELETE SET NULL,

  -- Violation content (from AI latest_violation object)
  violation_label TEXT,            -- raw human-readable label from AI
  violation_type  violation_type   NOT NULL,  -- normalised category

  -- Timing (AI provides HH:MM:SS strings; stored as TIME)
  detection_date  DATE             NOT NULL DEFAULT CURRENT_DATE,
  start_time      TIME,
  end_time        TIME,
  duration_sec    NUMERIC(8,2),

  -- Metadata
  confidence      NUMERIC(5,2)     CHECK (confidence BETWEEN 0 AND 100),
  status          violation_status NOT NULL DEFAULT 'pending',
  reviewed_by     VARCHAR(100),
  reviewed_at     TIMESTAMPTZ,
  notes           TEXT,

  inserted_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 4. INDEXES  (query performance for frontend & analytics)
-- ============================================================

-- Fast driver-based violation lookup (driver detail page, ranking)
CREATE INDEX idx_dv_driver_id      ON detected_violations(driver_id);

-- Fast source lookup (backend maps AI source → bus → driver)
CREATE INDEX idx_dv_source_id      ON detected_violations(source_id);

-- Date-based queries (dashboard today, monthly reports)
CREATE INDEX idx_dv_detection_date ON detected_violations(detection_date);

-- Violation type filtering (type cards, pie chart)
CREATE INDEX idx_dv_type           ON detected_violations(violation_type);

-- Status filtering (violations page workflow)
CREATE INDEX idx_dv_status         ON detected_violations(status);

-- Bus lookup
CREATE INDEX idx_dv_bus_id         ON detected_violations(bus_id);

-- Combined index for most common dashboard query
CREATE INDEX idx_dv_driver_date    ON detected_violations(driver_id, detection_date);

-- Bus source_id lookup (used by backend on every AI fetch)
CREATE INDEX idx_buses_source_id   ON buses(source_id);

-- Active assignment lookup (used by backend to resolve driver)
CREATE INDEX idx_assign_driver_active
  ON assignments(driver_id, status)
  WHERE status = 'active';

CREATE INDEX idx_assign_bus_active
  ON assignments(bus_id, status)
  WHERE status = 'active';


-- ============================================================
-- 5. SETTINGS TABLES
-- ============================================================

-- ------------------------------------------------------------
-- 5a. DETECTION SETTINGS
--     Enable/disable each AI module and set confidence floor.
-- ------------------------------------------------------------
CREATE TABLE detection_settings (
  id                    UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  module_name           violation_type UNIQUE NOT NULL,
  is_enabled            BOOLEAN        NOT NULL DEFAULT TRUE,
  -- Detections below this confidence are discarded by the backend
  confidence_threshold  NUMERIC(5,2)   NOT NULL DEFAULT 75.00
                        CHECK (confidence_threshold BETWEEN 0 AND 100),
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_detection_settings_updated_at
BEFORE UPDATE ON detection_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 5b. ROUTE THRESHOLDS
--     Defines the safety score boundaries for route decisions.
--     score >= demanding_min         → demanding route
--     score >= moderate_min          → moderate route
--     score < moderate_min           → simple route
-- ------------------------------------------------------------
CREATE TABLE route_thresholds (
  id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  route_type       route_difficulty UNIQUE NOT NULL,
  -- Driver must have AT LEAST this score to be eligible
  min_safety_score NUMERIC(5,2)   NOT NULL
                   CHECK (min_safety_score BETWEEN 0 AND 100),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_route_thresholds_updated_at
BEFORE UPDATE ON route_thresholds
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 5c. NOTIFICATION SETTINGS
-- ------------------------------------------------------------
CREATE TABLE notification_settings (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_sound             BOOLEAN     NOT NULL DEFAULT TRUE,
  email_alerts            BOOLEAN     NOT NULL DEFAULT FALSE,
  sms_alerts              BOOLEAN     NOT NULL DEFAULT FALSE,
  auto_flag               BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Auto-suspend a driver when total violations reach this count
  auto_suspend_threshold  SMALLINT    NOT NULL DEFAULT 15
                          CHECK (auto_suspend_threshold > 0),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_notification_settings_updated_at
BEFORE UPDATE ON notification_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 5d. CAMERA SETTINGS
-- ------------------------------------------------------------
CREATE TABLE camera_settings (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution            VARCHAR(20) NOT NULL DEFAULT '1080p',
  frame_rate            SMALLINT    NOT NULL DEFAULT 30
                        CHECK (frame_rate > 0),
  retention_days        SMALLINT    NOT NULL DEFAULT 30
                        CHECK (retention_days > 0),
  capture_on_detection  BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_camera_settings_updated_at
BEFORE UPDATE ON camera_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 5e. SYSTEM INFO
-- ------------------------------------------------------------
CREATE TABLE system_info (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  system_version      VARCHAR(20) NOT NULL DEFAULT '1.0.0',
  ai_model_version    VARCHAR(60),
  api_status          VARCHAR(20) NOT NULL DEFAULT 'active'
                      CHECK (api_status IN ('active', 'inactive', 'error')),
  license_valid_until DATE,
  last_health_check   TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_system_info_updated_at
BEFORE UPDATE ON system_info
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 6. BUSINESS LOGIC FUNCTIONS
-- ============================================================

-- ------------------------------------------------------------
-- 6a. Calculate safety score for a driver
--     Deductions per violation type (configurable):
--       mobile      → -5 pts
--       drowsy      → -7 pts  (highest risk)
--       smoking     → -6 pts
--       sunglasses  → -3 pts  (lowest risk)
--     Score is floored at 0 and capped at 100.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION calculate_safety_score(p_driver_id UUID)
RETURNS NUMERIC AS $$
DECLARE
  v_mobile      INTEGER := 0;
  v_sunglasses  INTEGER := 0;
  v_drowsy      INTEGER := 0;
  v_smoking     INTEGER := 0;
  v_score       NUMERIC;
BEGIN
  SELECT
    COUNT(CASE WHEN violation_type = 'mobile'     THEN 1 END),
    COUNT(CASE WHEN violation_type = 'sunglasses' THEN 1 END),
    COUNT(CASE WHEN violation_type = 'drowsy'     THEN 1 END),
    COUNT(CASE WHEN violation_type = 'smoking'    THEN 1 END)
  INTO v_mobile, v_sunglasses, v_drowsy, v_smoking
  FROM detected_violations
  WHERE driver_id = p_driver_id;

  v_score := 100.00
    - (v_mobile      * 5)
    - (v_sunglasses  * 3)
    - (v_drowsy      * 7)
    - (v_smoking     * 6);

  RETURN GREATEST(LEAST(v_score, 100.00), 0.00);
END;
$$ LANGUAGE plpgsql STABLE;


-- ------------------------------------------------------------
-- 6b. Recalculate ranks for all drivers
--     Called after every violation insert.
--     Rank is 1 = safest driver.
--     Tie-break: fewer total violations wins.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_driver_rankings()
RETURNS VOID AS $$
BEGIN
  WITH ranked AS (
    SELECT
      d.id,
      ROW_NUMBER() OVER (
        ORDER BY d.safety_score DESC,
                 COUNT(dv.id)   ASC,
                 d.created_at   ASC
      ) AS new_rank
    FROM drivers d
    LEFT JOIN detected_violations dv ON dv.driver_id = d.id
    GROUP BY d.id
  )
  UPDATE drivers
  SET rank = ranked.new_rank
  FROM ranked
  WHERE drivers.id = ranked.id;
END;
$$ LANGUAGE plpgsql;


-- ------------------------------------------------------------
-- 6c. Recommend route difficulty based on current safety score
--     Reads thresholds from route_thresholds table so
--     administrators can adjust without code changes.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION recommend_route_type(p_safety_score NUMERIC)
RETURNS route_difficulty AS $$
DECLARE
  v_demanding_min  NUMERIC;
  v_moderate_min   NUMERIC;
BEGIN
  SELECT min_safety_score INTO v_demanding_min
    FROM route_thresholds WHERE route_type = 'demanding';

  SELECT min_safety_score INTO v_moderate_min
    FROM route_thresholds WHERE route_type = 'moderate';

  IF p_safety_score >= v_demanding_min THEN
    RETURN 'demanding';
  ELSIF p_safety_score >= v_moderate_min THEN
    RETURN 'moderate';
  ELSE
    RETURN 'simple';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;


-- ------------------------------------------------------------
-- 6d. Backend helper: resolve driver from AI source_id
--     Returns the driver_id and bus_id for an active source.
--     Used by the backend procedure instead of repeating JOINs.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_driver_from_source(p_source_id VARCHAR)
RETURNS TABLE(driver_id UUID, bus_id UUID) AS $$
BEGIN
  RETURN QUERY
  SELECT a.driver_id, a.bus_id
  FROM   buses b
  JOIN   assignments a ON a.bus_id = b.id AND a.status = 'active'
  WHERE  b.source_id = p_source_id
  LIMIT  1;
END;
$$ LANGUAGE plpgsql STABLE;


-- ============================================================
-- 7. TRIGGERS  (automation after violation events)
-- ============================================================

-- ------------------------------------------------------------
-- 7a. After a violation is inserted:
--       1. Update that driver's safety score
--       2. Refresh all driver rankings
--       3. Auto-suspend driver if threshold exceeded
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION after_violation_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_new_score   NUMERIC;
  v_total_count INTEGER;
  v_threshold   INTEGER;
BEGIN
  -- Skip if driver is not resolved
  IF NEW.driver_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 1. Recalculate safety score
  v_new_score := calculate_safety_score(NEW.driver_id);

  UPDATE drivers
  SET safety_score = v_new_score,
      updated_at   = NOW()
  WHERE id = NEW.driver_id;

  -- 2. Refresh all rankings
  PERFORM refresh_driver_rankings();

  -- 3. Auto-suspend if total violations exceed threshold
  SELECT auto_suspend_threshold INTO v_threshold
  FROM notification_settings LIMIT 1;

  SELECT COUNT(*) INTO v_total_count
  FROM detected_violations
  WHERE driver_id = NEW.driver_id;

  IF v_total_count >= v_threshold THEN
    UPDATE drivers
    SET status     = 'suspended',
        updated_at = NOW()
    WHERE id = NEW.driver_id
      AND status = 'active';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_violation_after_insert
AFTER INSERT ON detected_violations
FOR EACH ROW
EXECUTE FUNCTION after_violation_insert();


-- ------------------------------------------------------------
-- 7b. When an assignment ends (status → inactive):
--     record the ended_at timestamp automatically.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION on_assignment_deactivated()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'inactive' AND OLD.status = 'active' THEN
    NEW.ended_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assignment_ended_at
BEFORE UPDATE ON assignments
FOR EACH ROW
EXECUTE FUNCTION on_assignment_deactivated();


-- ============================================================
-- 8. VIEWS  (pre-joined data for frontend queries)
-- ============================================================

-- ------------------------------------------------------------
-- 8a. DRIVER STATS VIEW
--     One row per driver with everything the Drivers page needs:
--     rank, score, violation breakdown, route, bus.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_driver_stats AS
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
LEFT JOIN assignments       a  ON a.driver_id = d.id AND a.status = 'active'
LEFT JOIN routes            r  ON r.id = a.route_id
LEFT JOIN buses             b  ON b.id = a.bus_id
LEFT JOIN detected_violations dv ON dv.driver_id = d.id
GROUP BY
  d.id, d.name, d.license_number, d.phone, d.age, d.experience_years,
  d.initials, d.avatar_color, d.status, d.safety_score, d.rank,
  d.join_date, d.last_active, d.created_at,
  r.id, r.name, r.difficulty,
  b.id, b.bus_number, b.source_id;


-- ------------------------------------------------------------
-- 8b. VIOLATIONS DETAIL VIEW
--     Full violation log with driver name and route context.
--     Used by the Violations page table.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_violations_detail AS
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


-- ------------------------------------------------------------
-- 8c. DASHBOARD SUMMARY VIEW
--     Single-row summary of the entire fleet's current state.
--     Used to populate the top stat cards on the Dashboard page.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_summary AS
SELECT
  COUNT(DISTINCT d.id)                                     AS total_drivers,
  COUNT(DISTINCT d.id) FILTER (WHERE d.status = 'active') AS active_drivers,
  COUNT(DISTINCT d.id) FILTER (WHERE d.status = 'suspended') AS suspended_drivers,
  ROUND(AVG(d.safety_score), 1)                            AS avg_safety_score,
  COUNT(DISTINCT a.route_id)                               AS active_routes,

  -- Today's violations
  COUNT(dv.id) FILTER (
    WHERE dv.detection_date = CURRENT_DATE
  )                                                        AS violations_today,

  -- All-time
  COUNT(dv.id)                                             AS total_violations,

  -- By status
  COUNT(dv.id) FILTER (WHERE dv.status = 'pending')       AS pending_violations,
  COUNT(dv.id) FILTER (WHERE dv.status = 'flagged')       AS flagged_violations,
  COUNT(dv.id) FILTER (WHERE dv.status = 'reviewed')      AS reviewed_violations,

  -- By type (all-time)
  COUNT(dv.id) FILTER (WHERE dv.violation_type = 'mobile')      AS total_phone,
  COUNT(dv.id) FILTER (WHERE dv.violation_type = 'sunglasses')  AS total_sunglasses,
  COUNT(dv.id) FILTER (WHERE dv.violation_type = 'drowsy')      AS total_drowsy,
  COUNT(dv.id) FILTER (WHERE dv.violation_type = 'smoking')     AS total_smoking

FROM drivers d
LEFT JOIN assignments         a  ON a.driver_id = d.id AND a.status = 'active'
LEFT JOIN detected_violations dv ON dv.driver_id = d.id;


-- ------------------------------------------------------------
-- 8d. ROUTE ASSIGNMENT VIEW
--     Routes page: shows route details + currently assigned
--     driver with their safety score.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_route_assignments AS
SELECT
  r.id,
  r.name,
  r.from_location,
  r.to_location,
  r.distance_km,
  r.stops,
  r.daily_trips,
  r.avg_travel_time_min,
  r.passenger_capacity,
  r.difficulty,
  r.description,

  -- Assigned driver
  d.id          AS driver_id,
  d.name        AS driver_name,
  d.safety_score,
  d.rank        AS driver_rank,
  d.status      AS driver_status,
  d.initials,
  d.avatar_color,

  -- Bus on this assignment
  b.bus_number,
  b.source_id

FROM routes r
LEFT JOIN assignments a ON a.route_id = r.id AND a.status = 'active'
LEFT JOIN drivers     d ON d.id = a.driver_id
LEFT JOIN buses       b ON b.id = a.bus_id;


-- ------------------------------------------------------------
-- 8e. DAILY VIOLATION TREND VIEW
--     Used by the Reports page monthly/weekly chart.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_violation_trend AS
SELECT
  dv.detection_date,
  COUNT(dv.id)                                                   AS total,
  COUNT(CASE WHEN dv.violation_type = 'mobile'     THEN 1 END)  AS phone,
  COUNT(CASE WHEN dv.violation_type = 'sunglasses' THEN 1 END)  AS sunglasses,
  COUNT(CASE WHEN dv.violation_type = 'drowsy'     THEN 1 END)  AS drowsy,
  COUNT(CASE WHEN dv.violation_type = 'smoking'    THEN 1 END)  AS smoking
FROM detected_violations dv
GROUP BY dv.detection_date
ORDER BY dv.detection_date;


-- ------------------------------------------------------------
-- 8f. HOURLY VIOLATION PATTERN VIEW
--     Reports page: shows which hours have most violations.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_hourly_violation_pattern AS
SELECT
  EXTRACT(HOUR FROM start_time)::INTEGER AS hour,
  COUNT(*)                               AS total_violations,
  COUNT(CASE WHEN violation_type = 'mobile'     THEN 1 END) AS phone,
  COUNT(CASE WHEN violation_type = 'sunglasses' THEN 1 END) AS sunglasses,
  COUNT(CASE WHEN violation_type = 'drowsy'     THEN 1 END) AS drowsy,
  COUNT(CASE WHEN violation_type = 'smoking'    THEN 1 END) AS smoking
FROM detected_violations
WHERE start_time IS NOT NULL
GROUP BY EXTRACT(HOUR FROM start_time)
ORDER BY hour;


-- ============================================================
-- 9. ROW LEVEL SECURITY  (Supabase best practice)
-- ============================================================
-- All tables are locked down to authenticated users only.
-- Expand these policies when you add user roles.

ALTER TABLE drivers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE buses                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE detected_violations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE detection_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_thresholds      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE camera_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_info           ENABLE ROW LEVEL SECURITY;

-- Authenticated users can SELECT everything
CREATE POLICY "Authenticated read all"
  ON drivers               FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read all"
  ON buses                 FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read all"
  ON routes                FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read all"
  ON assignments           FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read all"
  ON detected_violations   FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read all"
  ON detection_settings    FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read all"
  ON route_thresholds      FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read all"
  ON notification_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read all"
  ON camera_settings       FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read all"
  ON system_info           FOR SELECT TO authenticated USING (true);

-- Authenticated users can INSERT / UPDATE / DELETE
CREATE POLICY "Authenticated write all"
  ON drivers               FOR ALL TO authenticated USING (true);
CREATE POLICY "Authenticated write all"
  ON buses                 FOR ALL TO authenticated USING (true);
CREATE POLICY "Authenticated write all"
  ON routes                FOR ALL TO authenticated USING (true);
CREATE POLICY "Authenticated write all"
  ON assignments           FOR ALL TO authenticated USING (true);
CREATE POLICY "Authenticated write all"
  ON detected_violations   FOR ALL TO authenticated USING (true);
CREATE POLICY "Authenticated write all"
  ON detection_settings    FOR ALL TO authenticated USING (true);
CREATE POLICY "Authenticated write all"
  ON route_thresholds      FOR ALL TO authenticated USING (true);
CREATE POLICY "Authenticated write all"
  ON notification_settings FOR ALL TO authenticated USING (true);
CREATE POLICY "Authenticated write all"
  ON camera_settings       FOR ALL TO authenticated USING (true);
CREATE POLICY "Authenticated write all"
  ON system_info           FOR ALL TO authenticated USING (true);


-- ============================================================
-- 10. SEED DATA  (initial configuration values)
-- ============================================================

-- Detection modules (one row per violation type)
INSERT INTO detection_settings (module_name, is_enabled, confidence_threshold) VALUES
  ('mobile',     TRUE, 75.00),
  ('sunglasses', TRUE, 75.00),
  ('drowsy',     TRUE, 75.00),
  ('smoking',    TRUE, 75.00)
ON CONFLICT (module_name) DO NOTHING;


-- Route decision thresholds
-- Score >= 88 → demanding | 65–87 → moderate | < 65 → simple
-- Adjust in Settings page without touching code.
INSERT INTO route_thresholds (route_type, min_safety_score) VALUES
  ('demanding', 88.00),
  ('moderate',  65.00),
  ('simple',     0.00)
ON CONFLICT (route_type) DO NOTHING;


-- Default notification preferences
INSERT INTO notification_settings
  (alert_sound, email_alerts, sms_alerts, auto_flag, auto_suspend_threshold)
VALUES
  (TRUE, FALSE, FALSE, TRUE, 15)
ON CONFLICT DO NOTHING;


-- Default camera configuration
INSERT INTO camera_settings
  (resolution, frame_rate, retention_days, capture_on_detection)
VALUES
  ('1080p', 30, 30, TRUE)
ON CONFLICT DO NOTHING;


-- System information
INSERT INTO system_info
  (system_version, ai_model_version, api_status)
VALUES
  ('1.0.0', 'VisionGuard-AI-v1', 'active')
ON CONFLICT DO NOTHING;


-- ============================================================
-- 11. SAMPLE DATA  (matches frontend mock — remove in production)
-- ============================================================

-- Buses (source_id must match AI JSON keys)
INSERT INTO buses (bus_number, source_id) VALUES
  ('BUS-001', 'WEBCAM-01'),
  ('BUS-002', 'WEBCAM-02'),
  ('BUS-003', 'WEBCAM-03'),
  ('BUS-004', 'WEBCAM-04'),
  ('BUS-005', 'WEBCAM-05'),
  ('BUS-006', 'WEBCAM-06'),
  ('BUS-007', 'WEBCAM-07'),
  ('BUS-008', 'WEBCAM-08'),
  ('BUS-009', 'WEBCAM-09'),
  ('BUS-010', 'WEBCAM-10');

-- Routes
INSERT INTO routes (name, from_location, to_location, distance_km, stops, daily_trips, avg_travel_time_min, passenger_capacity, difficulty, description) VALUES
  ('Metro Express Line A',  'Central Station',  'Northgate Terminal',  28, 14, 12, 65, 80, 'demanding', 'High-frequency express route through the city center with multiple intersections and heavy traffic zones.'),
  ('Airport Shuttle Line B','City Hub',          'International Airport',35, 6,  8,  55, 60, 'demanding', 'Long-distance shuttle connecting city center to airport, requiring precise scheduling and highway driving.'),
  ('City Center Route C',   'West Gate',         'East Terminal',       22, 20, 15, 50, 70, 'demanding', 'Busy cross-city route through commercial districts with narrow streets and pedestrian zones.'),
  ('Suburban Line D',       'Downtown Park',     'Riverside Estate',    18, 16, 10, 42, 65, 'moderate',  'Suburban connector route with moderate traffic and residential stops.'),
  ('Cross-Town Route E',    'South Market',      'University Campus',   15, 12, 11, 38, 55, 'moderate',  'Mid-city route serving commercial and educational areas with mixed traffic.'),
  ('North District Line F', 'Old Town Square',   'Northern Mall',       12, 10,  9, 30, 50, 'moderate',  'Neighborhood route through northern residential areas with moderate passenger load.'),
  ('Local Street Route G',  'West Park',         'Community Center',    8,   8,  7, 25, 40, 'simple',    'Short local route through quiet residential streets with low traffic volume.'),
  ('Inner Ring Route H',    'Market Square',     'Hospital District',   7,   7,  6, 22, 35, 'simple',    'Short urban loop with minimal complexity, serving inner-city neighborhoods.'),
  ('Depot Route I',         'Bus Depot',         'Warehouse District',  5,   5,  5, 18, 30, 'simple',    'Restricted industrial route with minimal passenger interaction and low complexity.'),
  ('Restricted Route J',    'Depot Gate',        'Parking Zone',        3,   3,  2, 10,  0, 'simple',    'Minimal-use restricted route for probationary or suspended drivers only.');

-- Drivers (safety_score and rank will be recalculated by trigger after violations are inserted)
INSERT INTO drivers (name, license_number, phone, age, experience_years, initials, avatar_color, status, join_date, safety_score) VALUES
  ('James Carter',  'DL-2019-4421', NULL, 34, 7,  'JC', '#6366f1', 'active',    '2019-03-15', 100),
  ('Sofia Alvarez', 'DL-2021-7834', NULL, 28, 5,  'SA', '#06b6d4', 'active',    '2021-07-20', 100),
  ('Marcus Johnson','DL-2015-1102', NULL, 41, 11, 'MJ', '#10b981', 'active',    '2015-11-08', 100),
  ('Priya Sharma',  'DL-2020-3356', NULL, 32, 6,  'PS', '#f59e0b', 'active',    '2020-01-12', 100),
  ('Daniel Kim',    'DL-2018-9901', NULL, 37, 8,  'DK', '#8b5cf6', 'active',    '2018-06-03', 100),
  ('Amina Hassan',  'DL-2022-6672', NULL, 29, 4,  'AH', '#ec4899', 'active',    '2022-03-18', 100),
  ('Robert Walsh',  'DL-2013-4410', NULL, 45, 13, 'RW', '#f97316', 'active',    '2013-09-22', 100),
  ('Yuki Tanaka',   'DL-2023-1188', NULL, 26, 3,  'YT', '#14b8a6', 'active',    '2023-02-14', 100),
  ('Carlos Mendez', 'DL-2017-5543', NULL, 38, 9,  'CM', '#ef4444', 'inactive',  '2017-04-30', 100),
  ('Lena Fischer',  'DL-2019-8823', NULL, 31, 7,  'LF', '#dc2626', 'suspended', '2019-08-11', 100);

-- Assignments: wire each driver → bus → route
-- Using CTEs to look up IDs by name safely
WITH
  d  AS (SELECT id, name FROM drivers),
  b  AS (SELECT id, bus_number FROM buses),
  r  AS (SELECT id, name FROM routes)
INSERT INTO assignments (driver_id, bus_id, route_id, status)
SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'James Carter')  d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-001') b,
  (SELECT id FROM routes  WHERE name = 'Metro Express Line A') r
UNION ALL SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'Sofia Alvarez') d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-002') b,
  (SELECT id FROM routes  WHERE name = 'Airport Shuttle Line B') r
UNION ALL SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'Marcus Johnson') d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-003') b,
  (SELECT id FROM routes  WHERE name = 'City Center Route C') r
UNION ALL SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'Priya Sharma') d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-004') b,
  (SELECT id FROM routes  WHERE name = 'Suburban Line D') r
UNION ALL SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'Daniel Kim') d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-005') b,
  (SELECT id FROM routes  WHERE name = 'Cross-Town Route E') r
UNION ALL SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'Amina Hassan') d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-006') b,
  (SELECT id FROM routes  WHERE name = 'North District Line F') r
UNION ALL SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'Robert Walsh') d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-007') b,
  (SELECT id FROM routes  WHERE name = 'Local Street Route G') r
UNION ALL SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'Yuki Tanaka') d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-008') b,
  (SELECT id FROM routes  WHERE name = 'Inner Ring Route H') r
UNION ALL SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'Carlos Mendez') d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-009') b,
  (SELECT id FROM routes  WHERE name = 'Depot Route I') r
UNION ALL SELECT d.id, b.id, r.id, 'active'::assignment_status FROM
  (SELECT id FROM drivers WHERE name = 'Lena Fischer') d,
  (SELECT id FROM buses   WHERE bus_number = 'BUS-010') b,
  (SELECT id FROM routes  WHERE name = 'Restricted Route J') r;

-- Sample violations
-- Trigger will auto-update safety_score and rank after each INSERT
INSERT INTO detected_violations
  (source_id, bus_id, driver_id, violation_label, violation_type,
   detection_date, start_time, end_time, duration_sec, confidence, status)
SELECT
  b.source_id, b.id, d.id,
  'USING CELL PHONE / AIR BUDS', 'mobile',
  '2026-04-18', '09:15:00', '09:15:04', 3.8, 94, 'flagged'
FROM drivers d, buses b, assignments a
WHERE d.name = 'Lena Fischer' AND a.driver_id = d.id AND b.id = a.bus_id AND a.status = 'active';

INSERT INTO detected_violations
  (source_id, bus_id, driver_id, violation_label, violation_type,
   detection_date, start_time, end_time, duration_sec, confidence, status)
SELECT
  b.source_id, b.id, d.id,
  'DROWSINESS DETECTED', 'drowsy',
  '2026-04-18', '08:55:00', '08:55:06', 5.5, 89, 'flagged'
FROM drivers d, buses b, assignments a
WHERE d.name = 'Carlos Mendez' AND a.driver_id = d.id AND b.id = a.bus_id AND a.status = 'active';

INSERT INTO detected_violations
  (source_id, bus_id, driver_id, violation_label, violation_type,
   detection_date, start_time, end_time, duration_sec, confidence, status)
SELECT
  b.source_id, b.id, d.id,
  'USING CELL PHONE / AIR BUDS', 'mobile',
  '2026-04-18', '08:40:00', '08:40:03', 2.9, 97, 'pending'
FROM drivers d, buses b, assignments a
WHERE d.name = 'Yuki Tanaka' AND a.driver_id = d.id AND b.id = a.bus_id AND a.status = 'active';

-- ============================================================
-- END OF SCHEMA
-- ============================================================
-- Tables  : drivers, buses, routes, assignments,
--           detected_violations,
--           detection_settings, route_thresholds,
--           notification_settings, camera_settings, system_info
--
-- Views   : v_driver_stats, v_violations_detail,
--           v_dashboard_summary, v_route_assignments,
--           v_daily_violation_trend, v_hourly_violation_pattern
--
-- Functions: calculate_safety_score, refresh_driver_rankings,
--            recommend_route_type, resolve_driver_from_source
--
-- Triggers : trg_violation_after_insert,
--            trg_assignment_ended_at, set_updated_at (x8)
-- ============================================================


Further modifications in the above schema:

-- 1. Add AI config columns to system_info
ALTER TABLE system_info
  ADD COLUMN IF NOT EXISTS ai_endpoint_url      TEXT,
  ADD COLUMN IF NOT EXISTS ai_poll_interval_sec INTEGER NOT NULL DEFAULT 30;

-- Seed the initial row if it doesn't exist yet
INSERT INTO system_info (system_version, ai_model_version, api_status, ai_poll_interval_sec)
SELECT '1.0.0', 'VisionGuard-AI-v1', 'active', 30
WHERE NOT EXISTS (SELECT 1 FROM system_info);

-- 2. Unique constraint (drop first if exists, then create)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_violation_event'
  ) THEN
    ALTER TABLE detected_violations
      ADD CONSTRAINT uq_violation_event
      UNIQUE (source_id, detection_date, start_time, violation_type);
  END IF;
END $$;
