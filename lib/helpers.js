// ---------------------------------------------------------------------------
// helpers.js  —  Small shared utility functions used by pages.
// ---------------------------------------------------------------------------

// Human-friendly "how long ago" text, e.g. "3h 12m" or "2d 4h".
// Pass an ISO date string (the way SQLite stores our dates) and optionally an
// end time; defaults to "now".
function durationSince(fromISO, toISO) {
  if (!fromISO) return '';
  // SQLite stores UTC like "2026-06-11 14:30:00"; make it explicit UTC for JS.
  const start = new Date(fromISO.replace(' ', 'T') + 'Z');
  const end = toISO ? new Date(toISO.replace(' ', 'T') + 'Z') : new Date();
  let mins = Math.max(0, Math.round((end - start) / 60000));
  const days = Math.floor(mins / 1440); mins -= days * 1440;
  const hours = Math.floor(mins / 60); mins -= hours * 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// Total whole minutes between two ISO dates (used as a sortable raw value
// alongside the friendly durationSince() text).
function minutesSince(fromISO, toISO) {
  if (!fromISO) return 0;
  const start = new Date(fromISO.replace(' ', 'T') + 'Z');
  const end = toISO ? new Date(toISO.replace(' ', 'T') + 'Z') : new Date();
  return Math.max(0, Math.round((end - start) / 60000));
}

// Number of whole days between a date and now (used for the 7-day highlight).
function daysSince(fromISO) {
  if (!fromISO) return 0;
  const start = new Date(fromISO.replace(' ', 'T') + 'Z');
  return Math.floor((Date.now() - start) / 86400000);
}

// Billable whole days a tool was out: at least 1 day, rounding any partial day
// up (a tool out for 25 hours bills 2 days). Used by the billing report.
function billableDays(fromISO, toISO) {
  if (!fromISO) return 0;
  return Math.max(1, Math.ceil(minutesSince(fromISO, toISO) / 1440));
}

// Turn a stored date into the user's local, readable form e.g. "Jun 11, 2:30 PM".
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Build a CSS conic-gradient() string from { drill: 2, saw: 1, ... } counts
// and a matching { drill: '#...', saw: '#...' } color map.
// Returns null if there are no tools at all (so the caller can show an empty state).
function pieGradient(counts, colors) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (!total) return null;
  let start = 0;
  const stops = [];
  for (const cat of Object.keys(counts)) {
    const n = counts[cat];
    if (!n) continue;
    const end = start + (n / total) * 360;
    stops.push(`${colors[cat] || '#a1a1aa'} ${start}deg ${end}deg`);
    start = end;
  }
  return `conic-gradient(${stops.join(', ')})`;
}
const STATUS_LABELS = {
  available: 'Available',
  signed_out: 'Signed out',
  needs_repair: 'Needs repair',
  in_repair: 'In repair',
  missing: 'Missing',
};

// Gateway "powered on" status from how fresh its last_seen is. Gateways post
// a heartbeat roughly every 5 min (throttled server-side); allow a couple of
// missed cycles before calling it stale, longer before offline.
function scannerStatus(lastSeenISO) {
  if (!lastSeenISO) return 'offline';
  const mins = minutesSince(lastSeenISO);
  if (mins <= 10) return 'online';
  if (mins <= 30) return 'stale';
  return 'offline';
}
const SCANNER_STATUS_LABELS = { online: 'Online', stale: 'Stale', offline: 'Offline' };

module.exports = {
  durationSince,
  minutesSince,
  daysSince,
  billableDays,
  formatDateTime,
  STATUS_LABELS,
  scannerStatus,
  SCANNER_STATUS_LABELS,
  pieGradient,
};
