// ---------------------------------------------------------------------------
// lib/ble/schema.js  —  Database tables for beacon tracking.
//
// Called once at start-up. Like the rest of the app it uses "IF NOT EXISTS",
// so running it every boot is safe and never touches existing data.
//
// Four tables, each with one job:
//   scanners      — the THINGS that listen (a phone, or a fixed gateway). A
//                   fixed gateway is tied to a site, which is how we know
//                   "anything this gateway hears is AT that site".
//   beacons       — the registry that pairs a physical beacon to one of your
//                   tools ("beacon ABC is stuck on the orange drill").
//   beacon_events — the raw history: every sighting, ever. High volume.
//   beacon_state  — the latest known position of each beacon (a fast rollup so
//                   "where is everything right now?" is a single quick read).
// ---------------------------------------------------------------------------

function ensureBleSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scanners (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scanner_key TEXT    NOT NULL UNIQUE,            -- id a gateway/phone sends with each scan
      name        TEXT,                                -- friendly name a manager sets later
      site_id     INTEGER REFERENCES sites(id) ON DELETE SET NULL, -- where a FIXED scanner lives
      kind        TEXT    NOT NULL DEFAULT 'gateway',  -- gateway | phone | mock
      last_seen   TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS beacons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      beacon_key  TEXT    NOT NULL UNIQUE,             -- normalized "uuid|major|minor"
      uuid        TEXT    NOT NULL,
      major       INTEGER,
      minor       INTEGER,
      mac         TEXT,                                 -- some beacons/gateways report a MAC too
      tx_power    INTEGER,                              -- this beacon's calibrated 1 m power, if known
      tool_id     INTEGER REFERENCES tools(id) ON DELETE SET NULL, -- the tool it's attached to
      label       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS beacon_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      beacon_id   INTEGER REFERENCES beacons(id) ON DELETE SET NULL, -- NULL = unregistered beacon
      beacon_key  TEXT    NOT NULL,                     -- raw identity, even if unregistered
      scanner_id  INTEGER NOT NULL REFERENCES scanners(id) ON DELETE CASCADE,
      rssi        INTEGER NOT NULL,
      tx_power    INTEGER,
      distance_m  REAL,                                 -- estimate from the proximity engine
      zone        TEXT,                                 -- immediate | near | far | unknown
      observed_at TEXT    NOT NULL,                     -- when the SCANNER saw it
      received_at TEXT    NOT NULL DEFAULT (datetime('now')) -- when WE stored it
    );

    -- "Show me the recent trail for this beacon" and time-window cleanups.
    CREATE INDEX IF NOT EXISTS idx_bevents_beacon_time ON beacon_events(beacon_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_bevents_time        ON beacon_events(observed_at);

    -- One row per "visit": the first and last time a paired beacon was seen
    -- at a site before it moved to a different one. A new row starts only when
    -- the gateway site changes — signal gaps at the same site don't split it.
    CREATE TABLE IF NOT EXISTS beacon_site_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      beacon_key TEXT    NOT NULL,
      beacon_id  INTEGER REFERENCES beacons(id)  ON DELETE SET NULL,
      tool_id    INTEGER REFERENCES tools(id)     ON DELETE SET NULL,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      scanner_id INTEGER REFERENCES scanners(id)  ON DELETE SET NULL,
      first_seen TEXT    NOT NULL,
      last_seen  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bss_tool  ON beacon_site_sessions(tool_id,  first_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_bss_site  ON beacon_site_sessions(site_id,  first_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_bss_bkey  ON beacon_site_sessions(beacon_key, first_seen DESC);

    -- One row per beacon: its most recent sighting. Upserted on every flush.
    CREATE TABLE IF NOT EXISTS beacon_state (
      beacon_key      TEXT PRIMARY KEY,
      beacon_id       INTEGER REFERENCES beacons(id)  ON DELETE CASCADE,
      last_scanner_id INTEGER REFERENCES scanners(id) ON DELETE SET NULL,
      last_site_id    INTEGER REFERENCES sites(id)    ON DELETE SET NULL,
      last_rssi       INTEGER,
      last_distance_m REAL,
      last_zone       TEXT,
      last_seen       TEXT
    );
  `);

  // Migration: add the "active" column if an older scanner row predates it.
  const scannerCols = db.prepare('PRAGMA table_info(scanners)').all();
  if (!scannerCols.some((c) => c.name === 'active')) {
    db.prepare('ALTER TABLE scanners ADD COLUMN active INTEGER NOT NULL DEFAULT 1').run();
  }
}

module.exports = { ensureBleSchema };
