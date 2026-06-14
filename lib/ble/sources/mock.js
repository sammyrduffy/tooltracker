// ---------------------------------------------------------------------------
// lib/ble/sources/mock.js  —  Pretend hardware.
//
// Generates believable beacon sightings so you can build and test the database,
// the API and the front-end long before any physical tags arrive. It models a
// small fleet of beacons, each slowly wandering between "near a gateway" and
// "far away", with the random signal jitter real radios show.
//
// Two ways to use it:
//   • createMockFleet(opts)  -> an object with nextSightings(), to drive your
//     own loop (the standalone ble-mock.js script POSTs these to the API).
//   • createMockSource(opts) -> a start/stop source that feeds ingestSighting()
//     directly, for when you set BLE_SOURCE=mock and just want data flowing.
// ---------------------------------------------------------------------------

// A fixed UUID so every mock beacon belongs to the same "deployment". Pair real
// tools to these in the beacons table to see them light up on screen.
const MOCK_UUID = 'f7826da6-4fa2-4e98-8024-bc5b71e0893e';

const { sqliteNow } = require('../time');

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Build a fleet of `beaconCount` beacons "heard" by `scannerKeys` gateways.
// Each beacon keeps a private "true" RSSI that drifts over time; nextSightings()
// returns what each gateway hears this tick (with per-reading jitter).
function createMockFleet(opts = {}) {
  const beaconCount = opts.beaconCount || 4;
  const scannerKeys = opts.scannerKeys || ['gw-shop-01', 'gw-site-01'];
  const txPower = opts.txPower || -59;

  const beacons = [];
  for (let i = 0; i < beaconCount; i++) {
    beacons.push({
      major: 100,
      minor: i + 1,
      // Start somewhere between strong (-50) and weak (-90).
      baseRssi: randInt(-90, -50),
      // Which gateway is "closest" right now (others hear it weaker).
      homeScanner: randInt(0, scannerKeys.length - 1),
    });
  }

  function step(b) {
    // Random walk the underlying signal, clamped to a realistic window.
    b.baseRssi += randInt(-3, 3);
    if (b.baseRssi > -45) b.baseRssi = -45;
    if (b.baseRssi < -95) b.baseRssi = -95;
    // Occasionally a beacon "moves" to be closest to a different gateway.
    if (Math.random() < 0.05) b.homeScanner = randInt(0, scannerKeys.length - 1);
  }

  // Returns an array of normalized sightings for this moment in time.
  function nextSightings() {
    const now = sqliteNow();
    const out = [];
    for (const b of beacons) {
      step(b);
      scannerKeys.forEach((scannerKey, idx) => {
        // The "home" gateway hears the true signal; others hear it much weaker.
        const penalty = idx === b.homeScanner ? 0 : randInt(15, 30);
        const jitter = randInt(-4, 4);
        let rssi = b.baseRssi - penalty + jitter;
        if (rssi > -30) rssi = -30;
        if (rssi < -99) rssi = -99;
        out.push({
          scannerKey,
          uuid: MOCK_UUID,
          major: b.major,
          minor: b.minor,
          rssi,
          txPower,
          observedAt: now,
        });
      });
    }
    return out;
  }

  return { beacons, scannerKeys, nextSightings };
}

// A self-contained source: on start() it ticks a fleet on a timer and pushes
// each sighting straight into the ingest pipeline. Used when BLE_SOURCE=mock.
function createMockSource(opts = {}) {
  const { ingestSighting } = require('../ingest');
  const fleet = createMockFleet(opts);
  const intervalMs = opts.intervalMs || 1000;
  let timer = null;

  return {
    name: 'mock',
    start() {
      if (timer) return;
      timer = setInterval(() => {
        for (const s of fleet.nextSightings()) ingestSighting(s);
      }, intervalMs);
      console.log(`  [ble] mock source running: ${fleet.beacons.length} beacons every ${intervalMs}ms`);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

module.exports = { createMockFleet, createMockSource, MOCK_UUID };
