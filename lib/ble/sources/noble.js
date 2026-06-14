// ---------------------------------------------------------------------------
// lib/ble/sources/noble.js  —  Listen on a REAL Bluetooth radio.
//
// This is the source you'll switch on once hardware arrives and you want THIS
// computer (with a BLE adapter or a cheap USB dongle) to do the scanning —
// before you move to fixed gateways.
//
// It uses @abandonware/noble, the maintained fork of the classic `noble`
// library and the standard choice for server-side BLE scanning on Node. It is
// NOT a dependency in package.json on purpose: it needs native build tools and
// a real radio, neither of which you have while testing with the simulator.
// Installing it should be a deliberate step:
//
//     npm install @abandonware/noble
//
// Until then this file simply reports that it's unavailable and does nothing —
// the rest of the app keeps working.
//
// Recommendation: for your phase-by-phase plan, develop and test against the
// mock source / ble-mock.js script now. Reach for noble only when you have a
// tag in hand and want to confirm real packets parse correctly. After that,
// the fixed Blue Charm gateways will POST to /api/beacon-data and you won't run
// noble in production at all — the gateway path replaces it.
// ---------------------------------------------------------------------------

const { sqliteNow } = require('../time');

const APPLE_COMPANY_ID = 0x004c; // Apple's id; iBeacon ads are "Apple manufacturer data"
const IBEACON_TYPE = 0x02;       // sub-type that marks the data as an iBeacon

// Parse an iBeacon out of a manufacturer-data buffer, or return null.
// Layout after the 2-byte company id: [type=0x02][len=0x15][16-byte uuid]
// [2-byte major][2-byte minor][1-byte measured power].
function parseIBeacon(manufacturerData) {
  if (!manufacturerData || manufacturerData.length < 25) return null;
  if (manufacturerData.readUInt16LE(0) !== APPLE_COMPANY_ID) return null;
  if (manufacturerData[2] !== IBEACON_TYPE) return null;

  const uuidHex = manufacturerData.slice(4, 20).toString('hex');
  const uuid = [
    uuidHex.slice(0, 8), uuidHex.slice(8, 12), uuidHex.slice(12, 16),
    uuidHex.slice(16, 20), uuidHex.slice(20, 32),
  ].join('-');
  return {
    uuid,
    major: manufacturerData.readUInt16BE(20),
    minor: manufacturerData.readUInt16BE(22),
    txPower: manufacturerData.readInt8(24), // signed: measured power at 1 m
  };
}

// Build the source. `scannerKey` is the id recorded for sightings this machine
// hears (defaults to the hostname).
function createNobleSource(opts = {}) {
  const scannerKey = opts.scannerKey || `local-${require('os').hostname()}`;
  let noble = null;

  return {
    name: 'noble',
    start() {
      const { ingestSighting } = require('../ingest');
      try {
        noble = require('@abandonware/noble');
      } catch (err) {
        console.warn('  [ble] noble source unavailable — run `npm install @abandonware/noble` when you have hardware.');
        return;
      }

      noble.on('stateChange', (state) => {
        if (state === 'poweredOn') {
          noble.startScanning([], true); // [] = all UUIDs, true = allow duplicates (we WANT repeats)
          console.log(`  [ble] noble scanning on this machine as "${scannerKey}"`);
        } else {
          noble.stopScanning();
        }
      });

      noble.on('discover', (peripheral) => {
        const ad = peripheral.advertisement || {};
        const beacon = parseIBeacon(ad.manufacturerData);
        if (!beacon) return; // not an iBeacon ad we understand
        ingestSighting({
          scannerKey,
          uuid: beacon.uuid,
          major: beacon.major,
          minor: beacon.minor,
          rssi: peripheral.rssi,
          txPower: beacon.txPower,
          mac: peripheral.address,
          observedAt: sqliteNow(),
        });
      });
    },
    stop() {
      if (noble) { try { noble.stopScanning(); } catch (_) {} }
    },
  };
}

module.exports = { createNobleSource, parseIBeacon };
