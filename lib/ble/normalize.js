// ---------------------------------------------------------------------------
// lib/ble/normalize.js  —  Speak every gateway's dialect.
//
// Different BLE gateways post wildly different JSON. One sends {"rssi": -60},
// another {"RSSI": -60}, a third wraps a batch as {"scanner":"x","beacons":[…]}.
// Rather than teach the rest of the app every dialect, we funnel them ALL
// through here and emit one tidy shape — a "sighting":
//
//   {
//     scannerKey: 'gw-shop-01',  // who heard it (required)
//     uuid:       'f7826da6...', // iBeacon proximity UUID (required)
//     major:      100,           // optional
//     minor:      7,             // optional
//     rssi:       -67,           // signal strength, dBm (required)
//     txPower:    -59,           // calibrated 1 m power, optional
//     mac:        'aa:bb:..',    // optional
//     observedAt: '2026-..Z'     // when the gateway saw it, optional
//   }
//
// To support a new gateway brand, just add its field names to the alias lists
// below — no other file needs to change.
// ---------------------------------------------------------------------------

const { toSqliteDateTime } = require('./time');

// Pull the first present value from a list of possible field names.
function pick(obj, names) {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  }
  return undefined;
}

const FIELD = {
  scannerKey: ['scannerKey', 'scanner_id', 'scannerId', 'gateway', 'gatewayId', 'gw', 'source'],
  uuid:       ['uuid', 'proximityUUID', 'proximityUuid', 'ibeaconUuid', 'namespace'],
  major:      ['major', 'Major'],
  minor:      ['minor', 'Minor'],
  rssi:       ['rssi', 'RSSI', 'rssiDbm'],
  txPower:    ['txPower', 'txpower', 'measuredPower', 'calibratedPower', 'tx'],
  mac:        ['mac', 'macAddress', 'address', 'bdaddr'],
  observedAt: ['observedAt', 'timestamp', 'time', 'ts', 'seenAt'],
};

function toInt(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

// Turn one raw object into a clean sighting, or null if it's unusable.
// `fallbackScannerKey` lets a batch wrapper supply the scanner id once for all
// of its beacons instead of repeating it on each entry.
function normalizeOne(raw, fallbackScannerKey) {
  if (!raw || typeof raw !== 'object') return null;

  const scannerKey = pick(raw, FIELD.scannerKey) || fallbackScannerKey;
  const uuid = pick(raw, FIELD.uuid);
  const rssi = toInt(pick(raw, FIELD.rssi));

  // Without "who heard it", "which beacon", and "how strong", we can't use it.
  if (!scannerKey || !uuid || rssi === undefined) return null;

  let observedAt = pick(raw, FIELD.observedAt);
  if (observedAt !== undefined) {
    // Accept ISO strings or epoch numbers (seconds or milliseconds).
    const d = typeof observedAt === 'number'
      ? new Date(observedAt < 1e12 ? observedAt * 1000 : observedAt)
      : new Date(observedAt);
    observedAt = isNaN(d.getTime()) ? undefined : toSqliteDateTime(d);
  }

  return {
    scannerKey: String(scannerKey),
    uuid: String(uuid).toLowerCase(),
    major: toInt(pick(raw, FIELD.major)),
    minor: toInt(pick(raw, FIELD.minor)),
    rssi,
    txPower: toInt(pick(raw, FIELD.txPower)),
    mac: pick(raw, FIELD.mac) ? String(pick(raw, FIELD.mac)).toLowerCase() : undefined,
    observedAt, // may be undefined; the ingester defaults it to "now"
  };
}

// Accept the three shapes gateways post in the wild and always return an array
// of clean sightings (dropping any that are unusable):
//   1. a single sighting object
//   2. an array of sighting objects
//   3. a batch wrapper: { scanner: 'key' | {...}, beacons: [ ... ] }
function normalizePayload(body) {
  if (!body || typeof body !== 'object') return [];

  // Shape 3: a batch wrapper with a shared scanner and a list of beacons.
  const list = body.beacons || body.readings || body.devices;
  if (Array.isArray(list)) {
    const sc = body.scanner || body.gateway || {};
    const fallback = typeof sc === 'string' ? sc : pick(sc || {}, FIELD.scannerKey) || pick(body, FIELD.scannerKey);
    return list.map((item) => normalizeOne(item, fallback)).filter(Boolean);
  }

  // Shape 2: a bare array of sightings.
  if (Array.isArray(body)) {
    return body.map((item) => normalizeOne(item)).filter(Boolean);
  }

  // Shape 1: a single sighting.
  const one = normalizeOne(body);
  return one ? [one] : [];
}

module.exports = { normalizePayload, normalizeOne };
