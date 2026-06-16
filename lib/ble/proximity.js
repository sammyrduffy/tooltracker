// ---------------------------------------------------------------------------
// lib/ble/proximity.js  —  Turn a raw radio signal into "how close is it?"
//
// A BLE beacon constantly shouts a tiny radio packet. A scanner that hears it
// reports an RSSI: how STRONG the signal was, in dBm. RSSI is always negative —
// closer to 0 means stronger/closer (e.g. -45), more negative means weaker/
// farther (e.g. -90).
//
// This file has NO database and NO networking on purpose. It is just the maths
// that converts a signal strength into an estimated distance in metres and a
// friendly "zone" (immediate / near / far). That makes it easy to test and to
// reuse from anywhere in the app.
// ---------------------------------------------------------------------------

// The four states we ever report. Matches Apple's iBeacon proximity wording so
// it's familiar if you read beacon documentation.
const ZONES = {
  IMMEDIATE: 'immediate', // basically touching it (< ~0.5 m)
  NEAR: 'near',           // same room / within the site (< ~3 m)
  FAR: 'far',             // hearing it, but at a distance
  UNKNOWN: 'unknown',     // not enough signal to judge
};

// "Measured power" (a.k.a. TX power) is the RSSI you'd expect to see from this
// beacon at exactly 1 metre. Every beacon can advertise its own value; when one
// doesn't tell us, we fall back to this. -59 dBm is the typical factory default
// for the Feasycom / Blue Charm tags you're testing with.
const DEFAULT_TX_POWER = -59;

// Distance thresholds (in metres) for each zone. Tune these per site once you
// have real hardware — concrete, steel and walls all change the readings.
const ZONE_THRESHOLDS = {
  immediate: 0.5,
  near: 3.0,
};

// Estimate distance in metres from a signal reading.
//
// This is the well-known iBeacon curve: it is an APPROXIMATION, not a tape
// measure. Radio bounces off walls and bodies, so treat the number as "roughly
// this far" and lean on the zone (below) for decisions.
//
// Returns null when there isn't enough information to estimate.
function estimateDistance(rssi, txPower = DEFAULT_TX_POWER) {
  // rssi === 0 is the conventional "couldn't measure it" value.
  if (rssi == null || rssi === 0) return null;
  if (!txPower || txPower > 0) txPower = DEFAULT_TX_POWER; // guard against wrong-sign tx_power

  const ratio = rssi / txPower; // both negative, so this is positive
  let d;
  if (ratio < 1.0) {
    d = Math.pow(ratio, 10);
  } else {
    d = 0.89976 * Math.pow(ratio, 7.7095) + 0.111;
  }
  return Math.min(d, 100); // cap at 100 m — beyond that signal is too weak to trust
}

// Bucket a distance into a zone. We pass rssi too so a "couldn't measure"
// reading (0 / null distance) reports UNKNOWN rather than a bogus zone.
function classifyZone(distanceM, rssi) {
  if (rssi === 0 || distanceM == null) return ZONES.UNKNOWN;
  if (distanceM < ZONE_THRESHOLDS.immediate) return ZONES.IMMEDIATE;
  if (distanceM < ZONE_THRESHOLDS.near) return ZONES.NEAR;
  return ZONES.FAR;
}

// Convenience: do both steps at once. Returns { distanceM, zone }.
function evaluate(rssi, txPower) {
  const distanceM = estimateDistance(rssi, txPower);
  return { distanceM, zone: classifyZone(distanceM, rssi) };
}

// ---------------------------------------------------------------------------
// Signal smoothing.
//
// A single RSSI reading jitters a lot — the same stationary beacon can read
// -60 then -78 then -64 within a second. An EMA (exponential moving average)
// keeps a running, weighted average so the zone doesn't flap. Keep one
// Smoother per beacon+scanner pair if you want steadier readings.
//
//   alpha: how much each NEW reading counts (0..1). Lower = smoother but slower
//   to react. 0.3 is a sensible starting point.
// ---------------------------------------------------------------------------
class RssiSmoother {
  constructor(alpha = 0.3) {
    this.alpha = alpha;
    this.value = null;
  }
  push(rssi) {
    if (rssi == null || rssi === 0) return this.value;
    this.value = this.value == null
      ? rssi
      : this.alpha * rssi + (1 - this.alpha) * this.value;
    return this.value;
  }
}

module.exports = {
  ZONES,
  DEFAULT_TX_POWER,
  ZONE_THRESHOLDS,
  estimateDistance,
  classifyZone,
  evaluate,
  RssiSmoother,
};
