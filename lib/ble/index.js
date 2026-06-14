// ---------------------------------------------------------------------------
// lib/ble/index.js  —  One call to switch the beacon subsystem on.
//
// server.js does `require('./lib/ble').initBle()` once at start-up. That:
//   1. creates the beacon tables (safe to run every boot),
//   2. starts the background flush loop that drains the ingest queue,
//   3. optionally starts ONE scanning source, chosen by an environment
//      variable so production behaviour is explicit and opt-in:
//
//        BLE_SOURCE=none    (default) accept gateway POSTs only — no local scan
//        BLE_SOURCE=mock    run the built-in simulator in-process
//        BLE_SOURCE=noble   scan a real radio on this machine (needs the lib)
//
// The HTTP ingestion route (POST /api/beacon-data) is always available
// regardless of BLE_SOURCE — that's how fixed gateways will feed in.
// ---------------------------------------------------------------------------

const { db } = require('../../db');
const { ensureBleSchema } = require('./schema');
const { startFlusher } = require('./ingest');

let activeSource = null;

function initBle() {
  ensureBleSchema(db);
  startFlusher();

  const which = (process.env.BLE_SOURCE || 'none').toLowerCase();
  if (which === 'mock') {
    activeSource = require('./sources/mock').createMockSource();
  } else if (which === 'noble') {
    activeSource = require('./sources/noble').createNobleSource();
  }

  if (activeSource) activeSource.start();
  console.log(`  [ble] beacon subsystem ready (source: ${which})`);
}

module.exports = { initBle };
