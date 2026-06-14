// ---------------------------------------------------------------------------
// lib/ble/time.js  —  Timestamps that match the rest of the app.
//
// The rest of Tool Tracker stores dates the way SQLite's datetime('now') does:
// "YYYY-MM-DD HH:MM:SS" (UTC, space-separated, no fractional seconds). The
// shared helpers (durationSince, formatDateTime in lib/helpers.js) expect that
// exact shape. Beacon timestamps need to look the same so "last seen 3m ago"
// works on the beacon pairing screen without a separate code path.
// ---------------------------------------------------------------------------

function toSqliteDateTime(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function sqliteNow() {
  return toSqliteDateTime(new Date());
}

module.exports = { toSqliteDateTime, sqliteNow };
