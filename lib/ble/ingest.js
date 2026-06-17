// ---------------------------------------------------------------------------
// lib/ble/ingest.js  —  The single front door for ALL beacon sightings.
//
// Every source — the mock simulator, a local radio, or a field gateway posting
// over HTTP — calls ingestSighting(). Nothing writes to the database directly.
//
// Why a queue?  node:sqlite is SYNCHRONOUS: a write blocks Node's single thread
// until it finishes. A busy site with several gateways can produce hundreds of
// sightings a second; writing each one the instant it arrives would freeze the
// whole web app in tiny stutters. So instead:
//
//   1. ingestSighting() just shoves the sighting onto an in-memory array and
//      returns immediately (microseconds). The HTTP route can answer "202
//      Accepted" without waiting for any disk work.
//   2. A timer wakes up a few times a second and flushes whatever has piled up
//      in ONE transaction (one disk sync for the whole batch instead of one per
//      sighting). If a flood is still waiting afterwards, it reschedules itself
//      on the next tick instead of sleeping the full interval.
//
// This decouples "receiving" from "storing": receiving is always fast, storing
// happens in efficient bursts.
// ---------------------------------------------------------------------------

const { db, transaction } = require('../../db');
const { evaluate, DEFAULT_TX_POWER } = require('./proximity');
const { ensureBleSchema } = require('./schema');
const { sqliteNow } = require('./time');

// node:sqlite checks that tables exist the moment a statement is prepared, and
// the prepared statements below run as soon as this file is required — which can
// happen before initBle() runs. So make sure the tables exist right now. It's
// idempotent ("IF NOT EXISTS"), so calling it again from initBle() is harmless.
ensureBleSchema(db);

// --- Tunables ---------------------------------------------------------------
const FLUSH_INTERVAL_MS = 1000; // how often to drain the queue
const MAX_PER_FLUSH = 500;      // cap rows per transaction so a flush stays short
const MAX_QUEUE = 50000;        // hard memory cap; beyond this we shed load

// --- In-memory state --------------------------------------------------------
let queue = [];
let flushTimer = null;
let dropped = 0; // count of sightings shed when the queue overflowed
let lastFlushError = null; // last error from flush(), for /api/health diagnostics

// Build the key that uniquely identifies a physical beacon.
function beaconKey(uuid, major, minor) {
  return `${String(uuid).toLowerCase()}|${major ?? ''}|${minor ?? ''}`;
}

// --- Prepared statements (compiled once, reused — fast and injection-safe) ---
const findScanner   = db.prepare('SELECT id, site_id FROM scanners WHERE scanner_key = ?');
const insertScanner = db.prepare("INSERT INTO scanners (scanner_key, kind) VALUES (?, 'gateway')");
const touchScanner  = db.prepare('UPDATE scanners SET last_seen = ? WHERE id = ?');
const findBeacon    = db.prepare('SELECT id, tx_power FROM beacons WHERE beacon_key = ?');
const insertEvent   = db.prepare(`
  INSERT INTO beacon_events
    (beacon_id, beacon_key, scanner_id, rssi, tx_power, distance_m, zone, observed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertState = db.prepare(`
  INSERT INTO beacon_state
    (beacon_key, beacon_id, last_scanner_id, last_site_id, last_rssi, last_distance_m, last_zone, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(beacon_key) DO UPDATE SET
    beacon_id       = excluded.beacon_id,
    last_scanner_id = excluded.last_scanner_id,
    last_site_id    = excluded.last_site_id,
    last_rssi       = excluded.last_rssi,
    last_distance_m = excluded.last_distance_m,
    last_zone       = excluded.last_zone,
    last_seen       = excluded.last_seen
  -- Only move forward in time, so an out-of-order straggler can't overwrite a
  -- newer reading we already recorded.
  WHERE excluded.last_seen >= beacon_state.last_seen
`);

// Resolve (and remember) the scanner row for a key. A gateway we've never seen
// auto-registers itself so it shows up for a manager to name + assign a site.
// Cached in memory because the same handful of scanners repeat constantly.
const scannerCache = new Map(); // scanner_key -> { id, site_id }
function resolveScanner(scannerKey) {
  let s = scannerCache.get(scannerKey);
  if (s) return s;
  let row = findScanner.get(scannerKey);
  if (!row) {
    const info = insertScanner.run(scannerKey);
    row = { id: Number(info.lastInsertRowid), site_id: null };
  }
  s = { id: row.id, site_id: row.site_id };
  scannerCache.set(scannerKey, s);
  return s;
}

// A manager changing a scanner's site (elsewhere in the app) should be picked
// up promptly; call this after such an edit to forget the cached site.
function invalidateScannerCache() {
  scannerCache.clear();
}

// --- Public API -------------------------------------------------------------

// Accept one normalized sighting. Returns true if queued, false if shed.
function ingestSighting(s) {
  if (!s || !s.scannerKey || !s.uuid || s.rssi === undefined) return false;
  if (queue.length >= MAX_QUEUE) { dropped++; return false; }
  queue.push(s);
  return true;
}

// Drain up to MAX_PER_FLUSH sightings into the database in one transaction.
// Safe to call manually (the mock script and tests do). Never throws — a bad
// batch is logged and dropped rather than killing the flush loop.
function flush() {
  if (queue.length === 0) return 0;

  const batch = queue.splice(0, MAX_PER_FLUSH);
  const seenScanners = new Map(); // scanner_id -> latest observed_at, to touch once each

  // Resolve all scanners first (outside any transaction) so the INSERT goes
  // to Turso as a standalone autocommit write before we reference it via FK.
  try {
    for (const s of batch) resolveScanner(s.scannerKey);
  } catch (err) {
    lastFlushError = err.message;
    console.error('  [ble] scanner resolve failed:', err.message);
    return 0;
  }

  // Write events + state individually. Atomicity isn't needed for telemetry —
  // losing a sighting on a crash is fine; a failed FK or constraint just skips
  // that one sighting rather than dropping the whole batch.
  let written = 0;
  for (const s of batch) {
    try {
      const observedAt = s.observedAt || sqliteNow();
      const scanner = resolveScanner(s.scannerKey);
      const key = beaconKey(s.uuid, s.major, s.minor);
      const beacon = findBeacon.get(key);
      const txPower = s.txPower ?? (beacon && beacon.tx_power) ?? DEFAULT_TX_POWER;
      const { distanceM, zone } = evaluate(s.rssi, txPower);
      const beaconId = beacon ? beacon.id : null;

      insertEvent.run(beaconId, key, scanner.id, s.rssi, txPower, distanceM, zone, observedAt);
      upsertState.run(key, beaconId, scanner.id, scanner.site_id, s.rssi, distanceM, zone, observedAt);

      const prev = seenScanners.get(scanner.id);
      if (!prev || observedAt > prev) seenScanners.set(scanner.id, observedAt);
      written++;
    } catch (err) {
      lastFlushError = err.message;
      console.error('  [ble] sighting write failed:', err.message);
    }
  }
  try {
    for (const [scannerId, ts] of seenScanners) touchScanner.run(ts, scannerId);
  } catch (_) {}

  // If a flood is still waiting, come back immediately rather than idling a
  // whole interval — keeps the queue from growing under sustained load.
  if (queue.length > 0) setImmediate(flush);
  return batch.length;
}

// Start the background flush loop. unref() lets a short-lived script (the mock
// generator, tests) exit naturally without the timer holding the process open.
function startFlusher(intervalMs = FLUSH_INTERVAL_MS) {
  if (flushTimer) return;
  flushTimer = setInterval(flush, intervalMs);
  if (flushTimer.unref) flushTimer.unref();
}

function stopFlusher() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

// A peek at health, handy for a /api/health endpoint or debugging.
function stats() {
  return { queueDepth: queue.length, dropped, flushing: !!flushTimer, lastFlushError };
}

module.exports = {
  ingestSighting,
  flush,
  startFlusher,
  stopFlusher,
  stats,
  beaconKey,
  invalidateScannerCache,
};
