// src/services/violationProcessor.js
// ─────────────────────────────────────────────────────────────
// The most important service in Vision Guard.
// Receives the raw AI JSON, resolves every source to a driver
// IN PARALLEL, then bulk-inserts all valid violations in a
// single DB round-trip.
//
// AI JSON shape (one or many sources):
// {
//   "WEBCAM-01": {
//     "source_id": "WEBCAM-01",
//     "latest_violation": {
//       "label": "USING CELL PHONE / AIR BUDS",
//       "raw_label": "mobile",
//       "start_time": "20:25:54",
//       "end_time":   "20:25:57",
//       "duration_sec": 2.09,
//       "image_name": "WEBCAM-01_0018.jpg",
//       "image_url":  "http://..."
//     }
//   },
//   "WEBCAM-02": { ... }
// }
// ─────────────────────────────────────────────────────────────

const { supabase } = require('../config/supabase');

// ── Raw AI label → DB enum (violation_type) ──────────────────
// Handles whatever string the AI might return in raw_label.
const RAW_LABEL_MAP = {
  mobile       : 'mobile',
  phone        : 'mobile',
  'cell phone' : 'mobile',
  airbuds      : 'mobile',
  sunglasses   : 'sunglasses',
  'sun glasses': 'sunglasses',
  glasses      : 'sunglasses',
  drowsy       : 'drowsy',
  drowsiness   : 'drowsy',
  sleeping     : 'drowsy',
  sleep        : 'drowsy',
  smoking      : 'smoking',
  cigarette    : 'smoking',
  smoke        : 'smoking',
};

function normalizeViolationType(rawLabel = '') {
  return RAW_LABEL_MAP[rawLabel.toLowerCase().trim()] || null;
}

// ── Today's date in YYYY-MM-DD ────────────────────────────────
function todayDate() {
  return new Date().toISOString().split('T')[0];
}

// ─────────────────────────────────────────────────────────────
// STEP 1 – Load ALL detection settings in one query.
//          Returns a Map: violation_type → { is_enabled, confidence_threshold }
// ─────────────────────────────────────────────────────────────
async function loadDetectionSettings() {
  const { data, error } = await supabase
    .from('detection_settings')
    .select('module_name, is_enabled, confidence_threshold');

  if (error) throw new Error(`Failed to load detection settings: ${error.message}`);

  const map = new Map();
  for (const row of data) map.set(row.module_name, row);
  return map;
}

// ─────────────────────────────────────────────────────────────
// STEP 2 – Resolve source_id → { driver_id, bus_id }
//          Uses the DB function resolve_driver_from_source()
//          which does:  buses ← assignments → driver
//          Returns null if no active assignment found.
// ─────────────────────────────────────────────────────────────
async function resolveDriver(sourceId) {
  const { data, error } = await supabase
    .rpc('resolve_driver_from_source', { p_source_id: sourceId });

  if (error) {
    console.warn(`[Processor] Could not resolve driver for source "${sourceId}": ${error.message}`);
    return null;
  }
  return data?.[0] || null; // { driver_id, bus_id }
}

// ─────────────────────────────────────────────────────────────
// STEP 3 – Validate and build a single violation record.
//          Returns null if the violation should be skipped.
// ─────────────────────────────────────────────────────────────
function buildRecord(sourceData, resolved, detectionSettings, detectionDate) {
  const lv = sourceData.latest_violation;
  if (!lv) return null; // source has no current violation

  const violationType = normalizeViolationType(lv.raw_label);
  if (!violationType) {
    console.warn(`[Processor] Unknown raw_label "${lv.raw_label}" from ${sourceData.source_id}`);
    return null;
  }

  // Check if this module is enabled
  const setting = detectionSettings.get(violationType);
  if (!setting?.is_enabled) return null;

  // Check confidence threshold (AI may or may not provide confidence)
  if (lv.confidence !== undefined && lv.confidence < setting.confidence_threshold) {
    console.info(
      `[Processor] Skipping low-confidence detection: ${lv.confidence} < ${setting.confidence_threshold}`
    );
    return null;
  }

  return {
    source_id       : sourceData.source_id,
    bus_id          : resolved?.bus_id    || null,
    driver_id       : resolved?.driver_id || null,
    violation_label : lv.label,
    violation_type  : violationType,
    image_name      : lv.image_name,
    image_url       : lv.image_url,
    detection_date  : detectionDate,
    start_time      : lv.start_time,   // "HH:MM:SS" from AI
    end_time        : lv.end_time,
    duration_sec    : lv.duration_sec,
    confidence      : lv.confidence ?? null,
    status          : 'pending',
  };
}

// ─────────────────────────────────────────────────────────────
// STEP 4 – Bulk-insert records.
//          Uses ignoreDuplicates so re-polling the same event
//          (same source + date + start_time + type) is harmless.
// ─────────────────────────────────────────────────────────────
async function bulkInsertViolations(records) {
  if (records.length === 0) return { inserted: 0 };

  const { data, error } = await supabase
    .from('detected_violations')
    .upsert(records, {
      onConflict     : 'source_id,detection_date,start_time,violation_type',
      ignoreDuplicates: true,
    })
    .select('id');

  if (error) throw new Error(`Bulk insert failed: ${error.message}`);

  return { inserted: data?.length ?? 0 };
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT – processAIResponse(aiJson)
// ─────────────────────────────────────────────────────────────
// aiJson is the full parsed JSON body from the AI endpoint.
// Returns a summary object for logging.
// ─────────────────────────────────────────────────────────────
async function processAIResponse(aiJson) {
  const sources = Object.values(aiJson); // array of source objects
  if (sources.length === 0) return { processed: 0, inserted: 0, skipped: 0 };

  const detectionDate = todayDate();

  // ── Load settings + resolve all drivers IN PARALLEL ──────────
  const [detectionSettings, resolvedList] = await Promise.all([
    loadDetectionSettings(),
    // Resolve every source concurrently – one DB call per source
    Promise.all(sources.map((src) => resolveDriver(src.source_id))),
  ]);

  // ── Build records (synchronous, no DB calls) ──────────────────
  const records = [];
  let skipped = 0;

  sources.forEach((src, idx) => {
    const resolved = resolvedList[idx];
    const record = buildRecord(src, resolved, detectionSettings, detectionDate);
    if (record) {
      records.push(record);
    } else {
      skipped++;
    }
  });

  // ── Bulk insert (single DB round-trip) ────────────────────────
  const { inserted } = await bulkInsertViolations(records);

  return {
    processed : sources.length,
    inserted,
    skipped,
    duplicates: records.length - inserted,
  };
}

module.exports = { processAIResponse };
