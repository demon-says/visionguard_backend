-- ============================================================
--  Vision Guard – Migration: AI Endpoint Config
--  Run this ONCE in Supabase SQL Editor BEFORE starting the backend
-- ============================================================

-- 1. Add AI endpoint URL + poll interval to system_info
--    The URL is stored in the DB so it can be updated at runtime
--    via PUT /api/ai/config — no server restart needed when
--    Cloudflare Tunnel gives a new URL.
ALTER TABLE system_info
  ADD COLUMN IF NOT EXISTS ai_endpoint_url      TEXT,
  ADD COLUMN IF NOT EXISTS ai_poll_interval_sec INTEGER NOT NULL DEFAULT 30;

-- Seed the initial row if it doesn't exist yet
INSERT INTO system_info (system_version, ai_model_version, api_status, ai_poll_interval_sec)
SELECT '1.0.0', 'VisionGuard-AI-v1', 'active', 30
WHERE NOT EXISTS (SELECT 1 FROM system_info);

-- 2. Unique constraint so the backend can safely upsert violations
--    and avoid storing the same AI event twice when the poller
--    hits the endpoint before the driver finishes the violation.
ALTER TABLE detected_violations
  ADD CONSTRAINT IF NOT EXISTS uq_violation_event
  UNIQUE (source_id, detection_date, start_time, violation_type);

-- ============================================================
-- Done. You can now start the backend server.
-- ============================================================
