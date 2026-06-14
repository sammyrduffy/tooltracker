// ---------------------------------------------------------------------------
// ble-mock.js  —  Pretend a Bluetooth gateway is posting to your server.
//
// Run it (with the app already running) to pump realistic fake beacon data
// through the REAL ingestion path — the HTTP route, the queue, the database,
// the read API — so you can build and test everything before hardware arrives:
//
//     npm run ble:mock
//
// It posts a batch of sightings every second, in the same {scanner, beacons:[…]}
// shape a typical gateway uses, so this also proves the gateway-agnostic route
// works. Stop it with Ctrl+C.
//
// Options (environment variables):
//     BLE_URL=http://localhost:3000/api/beacon-data   where to post
//     MOCK_BEACONS=4                                   how many beacons
//     MOCK_INTERVAL=1000                               ms between batches
//     MOCK_SCANNERS=gw-shop-01,gw-site-01              gateway ids to simulate
// ---------------------------------------------------------------------------

const { createMockFleet } = require('./lib/ble/sources/mock');

const URL = process.env.BLE_URL || 'http://localhost:3000/api/beacon-data';
const INTERVAL = Number(process.env.MOCK_INTERVAL) || 1000;
const BEACONS = Number(process.env.MOCK_BEACONS) || 4;
const SCANNERS = (process.env.MOCK_SCANNERS || 'gw-shop-01,gw-site-01')
  .split(',').map((s) => s.trim()).filter(Boolean);

const fleet = createMockFleet({ beaconCount: BEACONS, scannerKeys: SCANNERS });

console.log(`\n  Mock gateway → ${URL}`);
console.log(`  ${BEACONS} beacons, scanners [${SCANNERS.join(', ')}], every ${INTERVAL}ms.`);
console.log('  Press Ctrl+C to stop.\n');

async function tick() {
  const sightings = fleet.nextSightings();

  // Group this tick's sightings by gateway and post one batch per gateway, in
  // the {scanner, beacons:[…]} shape real gateways use.
  const byScanner = new Map();
  for (const s of sightings) {
    if (!byScanner.has(s.scannerKey)) byScanner.set(s.scannerKey, []);
    byScanner.get(s.scannerKey).push({
      uuid: s.uuid, major: s.major, minor: s.minor,
      rssi: s.rssi, txPower: s.txPower,
    });
  }

  for (const [scannerKey, beacons] of byScanner) {
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanner: scannerKey, beacons }),
      });
      const body = await res.json().catch(() => ({}));
      console.log(`  ${scannerKey}: sent ${beacons.length} → ${res.status} accepted=${body.accepted ?? '?'} queue=${body.queueDepth ?? '?'}`);
    } catch (err) {
      console.error(`  ${scannerKey}: POST failed — is the app running? (${err.message})`);
    }
  }
}

setInterval(tick, INTERVAL);
tick();
