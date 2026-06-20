// ---------------------------------------------------------------------------
// routes/api.js  —  Machine-facing JSON endpoints for beacon data.
//
//   POST /api/beacon-data        Gateways/phones post sightings here. Accepts
//                                any of the common JSON shapes (see normalize.js),
//                                queues them, and answers 202 immediately — it
//                                never blocks the caller on disk writes.
//   GET  /api/beacon-data/state  "Where is every tracked tool right now?" —
//                                the latest sighting per beacon, joined to the
//                                tool and site. Handy for the front-end.
//   GET  /api/health             Liveness + queue depth.
//
// This router parses JSON itself (the main app only parses form posts), so
// adding it doesn't change how the rest of the site reads requests.
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { normalizePayload } = require('../lib/ble/normalize');
const { ingestSighting, stats, heartbeat } = require('../lib/ble/ingest');

// Parse JSON bodies for this router only. The limit guards against a gateway
// (or a bad actor) posting an enormous batch that could exhaust memory.
router.use(express.json({ limit: '2mb' }));

// --- Ingestion: the gateway-agnostic front door -----------------------------
router.post('/beacon-data', (req, res) => {
  const sightings = normalizePayload(req.body);
  if (sightings.length === 0) {
    return res.status(400).json({ error: 'No usable sightings in payload.' });
  }
  let accepted = 0;
  for (const s of sightings) { if (ingestSighting(s)) accepted++; }

  // 202 = "got it, will process". We return before anything touches the disk.
  res.status(202).json({
    accepted,
    rejected: sightings.length - accepted, // shed only if the queue is flooded
    queueDepth: stats().queueDepth,
  });
});

// --- Heartbeat: "I'm powered on" even with no beacons in range --------------
// Gateways call this on their own timer, independent of beacon sightings, so
// a Pi sitting somewhere with no tagged tool nearby still shows as online.
router.post('/heartbeat', (req, res) => {
  const scannerKey = req.body && req.body.scanner_key;
  if (!scannerKey) return res.status(400).json({ error: 'scanner_key required' });
  heartbeat(scannerKey);
  res.status(204).end();
});

// --- Read: current position of each tracked tool ----------------------------
const stateQuery = db.prepare(`
  SELECT
    bs.beacon_key, bs.last_rssi, bs.last_distance_m, bs.last_zone, bs.last_seen,
    b.uuid, b.major, b.minor, b.label AS beacon_label,
    t.id AS tool_id, t.name AS tool_name, t.short_id AS tool_short_id,
    sc.scanner_key, sc.name AS scanner_name,
    s.id AS site_id, s.name AS site_name
  FROM beacon_state bs
  LEFT JOIN beacons  b  ON b.beacon_key = bs.beacon_key
  LEFT JOIN tools    t  ON t.id  = b.tool_id
  LEFT JOIN scanners sc ON sc.id = bs.last_scanner_id
  LEFT JOIN sites    s  ON s.id  = bs.last_site_id
  ORDER BY bs.last_seen DESC
`);

router.get('/beacon-data/state', (req, res) => {
  res.json({ beacons: stateQuery.all() });
});

// --- Health -----------------------------------------------------------------
router.get('/health', (req, res) => {
  res.json({ ok: true, ...stats() });
});

module.exports = router;
