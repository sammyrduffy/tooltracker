// ---------------------------------------------------------------------------
// db.js  —  Database setup for Tool Tracker
//
// Uses Node's BUILT-IN SQLite (node:sqlite), so there is no separate database
// to install or run. The entire database lives in a single file on disk:
// "tooltracker.db" in this folder. To back up the data, just copy that file.
// To start completely fresh, delete that file and restart the app.
// ---------------------------------------------------------------------------

const path = require('path');
const os = require('os');
const crypto = require('crypto');

// The database file lives next to this code file. A TOOLTRACKER_DB environment
// variable can point it elsewhere (handy for tests / a scratch copy) without
// touching the real data.
const DB_FILE = process.env.TOOLTRACKER_DB || path.join(__dirname, 'tooltracker.db');

// ---------------------------------------------------------------------------
// Pick the database driver. Both expose the SAME synchronous calls
// (db.prepare(...).get/all/run, db.exec(...)) so nothing else in the app
// changes.
//
//  • In the cloud (Turso configured): use libSQL with an "embedded replica".
//    The permanent home of the data is Turso; we keep a fast local copy and
//    sync it. The local copy can be thrown away on every restart — it just
//    re-downloads from Turso — which is exactly what we need on a host with
//    no permanent disk.
//  • On the office PC (no Turso settings): use Node's built-in SQLite, exactly
//    as before. The single TOOLTRACKER_DB file is the real data.
//
// USE_LIBSQL=1 forces the libSQL driver against a plain local file — handy for
// testing the cloud code path on the PC without touching the real database.
// ---------------------------------------------------------------------------
let db;
if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
  const Database = require('libsql');
  // The local replica is a disposable, fast copy of the Turso data — it
  // re-downloads on every boot, so it can live in a throwaway temp folder.
  // (Render's free tier has no permanent disk; a temp path is always writable.)
  const localCopy = process.env.TOOLTRACKER_DB || path.join(os.tmpdir(), 'tooltracker-replica.db');
  db = new Database(localCopy, {
    syncUrl: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  db.sync();                                 // pull the latest data on startup
  setInterval(() => { try { db.sync(); } catch (_) {} }, 60 * 1000); // keep fresh
} else if (process.env.USE_LIBSQL) {
  const Database = require('libsql');
  db = new Database(DB_FILE);
} else {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_FILE);
}

// Make foreign keys (the links between tables) actually enforced.
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// Create the tables if they do not exist yet. Running this every startup is
// safe — "IF NOT EXISTS" means existing data is left untouched.
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS tools (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    short_id        TEXT    NOT NULL UNIQUE,   -- the code used in the QR sticker / URL
    name            TEXT    NOT NULL,
    description     TEXT,
    serial_number   TEXT,
    category        TEXT    NOT NULL DEFAULT 'other',  -- drill | saw | ladder | other
    purchase_value  REAL,
    condition_notes TEXT,
    photo           TEXT,                       -- filename of an uploaded photo (optional)
    status          TEXT    NOT NULL DEFAULT 'available', -- available | signed_out | in_repair | missing
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS employees (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    pin_hash    TEXT    NOT NULL,               -- the PIN, securely hashed (never stored in plain text)
    role        TEXT    NOT NULL DEFAULT 'employee', -- employee | manager
    active      INTEGER NOT NULL DEFAULT 1,     -- 1 = active, 0 = hidden/retired
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    address     TEXT,
    active      INTEGER NOT NULL DEFAULT 1,     -- 1 = active, 0 = inactive
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checkouts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id     INTEGER NOT NULL REFERENCES tools(id)     ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    site_id     INTEGER REFERENCES sites(id),
    time_out    TEXT    NOT NULL DEFAULT (datetime('now')),
    time_in     TEXT,                            -- NULL while the tool is still out
    notes       TEXT
  );

  -- Speeds up the common "what is still out?" lookups.
  CREATE INDEX IF NOT EXISTS idx_checkouts_open ON checkouts(tool_id) WHERE time_in IS NULL;

  -- Simple key/value settings (e.g. the base web address used in QR codes).
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Tool categories: managers can add their own (drill, saw, ladder, etc.).
  CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL UNIQUE,    -- stored on tools.category
    label       TEXT    NOT NULL,
    icon        TEXT    NOT NULL DEFAULT '🧰',
    color       TEXT    NOT NULL DEFAULT '#a1a1aa',  -- used in charts/legends
    sort_order  INTEGER NOT NULL DEFAULT 0
  );

  -- Materials: bulk supplies tracked by quantity + location (no sign-out, no QR).
  CREATE TABLE IF NOT EXISTS materials (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'Miscellaneous',
    quantity    REAL    NOT NULL DEFAULT 0,
    unit        TEXT,                              -- e.g. ea, sheets, ft, boxes, bags
    location    TEXT,                              -- where the material currently is
    notes       TEXT,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Field-reported tool problems. A crew member flags a tool as needing repair
  -- (with a note + optional photo); a manager later resolves it.
  CREATE TABLE IF NOT EXISTS tool_issues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id     INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    reported_by INTEGER REFERENCES employees(id),
    note        TEXT,
    photo       TEXT,                              -- filename/URL of an uploaded photo (optional)
    status      TEXT    NOT NULL DEFAULT 'open',   -- open | resolved
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  -- Speeds up "does this tool have an open issue?" lookups.
  CREATE INDEX IF NOT EXISTS idx_tool_issues_open ON tool_issues(tool_id) WHERE status = 'open';
`);

// ---------------------------------------------------------------------------
// Migration: materials gain a normalized "name_key" so that small differences
// in case/spacing/plurals count as the same material. Add the column if an
// older database doesn't have it yet, then fill in any blanks.
// ---------------------------------------------------------------------------
const { materialKey } = require('./lib/materials');
(function ensureMaterialKey() {
  const cols = db.prepare('PRAGMA table_info(materials)').all();
  if (!cols.some((c) => c.name === 'name_key')) {
    db.prepare('ALTER TABLE materials ADD COLUMN name_key TEXT').run();
  }
  const rows = db.prepare("SELECT id, name FROM materials WHERE name_key IS NULL OR name_key = ''").all();
  const upd = db.prepare('UPDATE materials SET name_key = ? WHERE id = ?');
  for (const r of rows) upd.run(materialKey(r.name), r.id);
})();

// ---------------------------------------------------------------------------
// Migration: sites gain an optional "photo" (filename of an uploaded image),
// shown in the Job sites list.
// ---------------------------------------------------------------------------
(function ensureSitePhoto() {
  const cols = db.prepare('PRAGMA table_info(sites)').all();
  if (!cols.some((c) => c.name === 'photo')) {
    db.prepare('ALTER TABLE sites ADD COLUMN photo TEXT').run();
  }
})();

// ---------------------------------------------------------------------------
// Migration: tools gain an optional "billable_rate" — a per-DAY charge used by
// the billing report (what to bill a job/client for using the tool).
// ---------------------------------------------------------------------------
(function ensureBillableRate() {
  const cols = db.prepare('PRAGMA table_info(tools)').all();
  if (!cols.some((c) => c.name === 'billable_rate')) {
    db.prepare('ALTER TABLE tools ADD COLUMN billable_rate REAL').run();
  }
})();

(function ensureScannerActive() {
  const cols = db.prepare('PRAGMA table_info(scanners)').all();
  if (!cols.some((c) => c.name === 'active')) {
    db.prepare('ALTER TABLE scanners ADD COLUMN active INTEGER NOT NULL DEFAULT 1').run();
  }
})();

// ---------------------------------------------------------------------------
// Seed the default tool categories the first time the app runs.
// ---------------------------------------------------------------------------
(function seedCategories() {
  // INSERT OR IGNORE runs on every boot so the defaults always reach Turso,
  // even if the table was empty after a fresh sync. Existing rows are untouched.
  const defaults = [
    ['drill', 'Drill', '🪛', '#3b82f6', 0],
    ['saw', 'Saw', '🪚', '#10b981', 1],
    ['ladder', 'Ladder', '🪜', '#f59e0b', 2],
    ['other', 'Other', '🧰', '#a1a1aa', 3],
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO categories (key, label, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)');
  for (const [key, label, icon, color, sort] of defaults) insert.run(key, label, icon, color, sort);
})();

// ---------------------------------------------------------------------------
// PIN security helpers.
// We never store the actual PIN. We store a one-way "hash" of it (using Node's
// built-in scrypt). To check a PIN we hash the entered value and compare.
// ---------------------------------------------------------------------------
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  // Constant-time comparison to avoid timing leaks.
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Short ID generator for tools (used in the QR-code URL, e.g. /t/7QF3KP).
// Uses characters that are hard to confuse by eye (no 0/O, 1/I, etc.).
// ---------------------------------------------------------------------------
const SHORT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateShortId(length = 6) {
  let id = '';
  for (let i = 0; i < length; i++) {
    id += SHORT_ALPHABET[crypto.randomInt(SHORT_ALPHABET.length)];
  }
  return id;
}

// Returns a short ID guaranteed not to already exist in the tools table.
function generateUniqueShortId() {
  const exists = db.prepare('SELECT 1 FROM tools WHERE short_id = ?');
  let id;
  do {
    id = generateShortId();
  } while (exists.get(id));
  return id;
}

// ---------------------------------------------------------------------------
// First-run safety net: if there are NO employees at all, create a starter
// manager so you can actually log in and start adding things. You should
// change this PIN (or delete this account) once you've made your own manager.
// ---------------------------------------------------------------------------
function bootstrapDefaultManager() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM employees').get().n;
  if (count === 0) {
    db.prepare(
      'INSERT INTO employees (name, pin_hash, role) VALUES (?, ?, ?)'
    ).run('Manager', hashPin('1234'), 'manager');
    console.log('  ↳ Created a starter manager account: name "Manager", PIN 1234');
    console.log('    (Change this PIN or delete the account after you log in.)');
  }
}

// --- Settings (key/value) helpers ------------------------------------------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// Runs several database changes as one all-or-nothing unit. If anything throws
// partway through, every change is undone (rolled back). Node's built-in SQLite
// has no transaction() shortcut, so we wrap BEGIN/COMMIT/ROLLBACK ourselves.
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

module.exports = {
  db,
  hashPin,
  verifyPin,
  generateUniqueShortId,
  bootstrapDefaultManager,
  transaction,
  getSetting,
  setSetting,
};
