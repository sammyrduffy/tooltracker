// ---------------------------------------------------------------------------
// db.js  —  Database setup for Tool Tracker
//
// Uses Node's BUILT-IN SQLite (node:sqlite), so there is no separate database
// to install or run. The entire database lives in a single file on disk:
// "tooltracker.db" in this folder. To back up the data, just copy that file.
// To start completely fresh, delete that file and restart the app.
// ---------------------------------------------------------------------------

const path = require('path');
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
//  • In the cloud (Turso configured): connect directly to Turso over the
//    network for every query — no local replica, no sync. We used to keep an
//    "embedded replica" (a local copy that re-downloads in full from Turso on
//    every boot), but on a host with no persistent disk that means a FULL
//    database re-sync on every restart and every deploy. That burns through
//    Turso's free-tier "Syncs" (bytes transferred) quota fast — a handful of
//    deploys in a few days was enough to max it out and lock the account.
//    Direct remote queries are billed as ordinary row reads/writes instead,
//    a completely different quota with far more headroom for an app this
//    size. The tradeoff: each query is a network round-trip instead of a
//    local disk read, so pages with several queries load a bit slower.
//  • On the office PC (no Turso settings): use Node's built-in SQLite, exactly
//    as before. The single TOOLTRACKER_DB file is the real data.
//
// USE_LIBSQL=1 forces the libSQL driver against a plain local file — handy for
// testing the cloud code path on the PC without touching the real database.
// ---------------------------------------------------------------------------
let db;
if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
  const Database = require('libsql');
  db = new Database(process.env.TURSO_DATABASE_URL, {
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
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

// ---------------------------------------------------------------------------
// Migration: sites gain an optional "is_home" flag. Gateways at a home site
// auto-check tools back in when their beacon is detected there.
// ---------------------------------------------------------------------------
(function ensureSiteIsHome() {
  const cols = db.prepare('PRAGMA table_info(sites)').all();
  if (!cols.some((c) => c.name === 'is_home')) {
    db.prepare('ALTER TABLE sites ADD COLUMN is_home INTEGER NOT NULL DEFAULT 0').run();
  }
})();

// ---------------------------------------------------------------------------
// Fix: categories.key is UNIQUE locally but the constraint was never pushed to
// Turso (db.exec is local-only on libsql), so duplicates can creep in via:
//   a) a broken earlier migration that left all rows sharing one wrong key
//      (e.g. all 17 categories ended up with key='hand_tools')
//   b) the seed re-inserting default rows on every boot
//   c) a manager adding the same category name more than once
//
// Single-pass algorithm (rows processed in id order — lowest id = oldest):
//   • Compute each row's correct key from its label.
//   • If that correct key hasn't been claimed yet: assign it (update if the
//     row's current key is wrong) and mark it claimed.
//   • If that correct key is already claimed: this is a duplicate — delete it.
// This handles all three cases above without needing to group by anything.
// ---------------------------------------------------------------------------
(function fixCategoryKeys() {
  function toKey(label) {
    return String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  const rows = db.prepare('SELECT id, key, label FROM categories ORDER BY id').all();
  const claimed = new Set();
  let changed = false;
  for (const row of rows) {
    const correct = toKey(row.label);
    if (claimed.has(correct)) {
      // A surviving row already owns this correct key — this row is a duplicate.
      db.prepare('DELETE FROM categories WHERE id = ?').run(row.id);
      changed = true;
    } else {
      claimed.add(correct);
      if (row.key !== correct) {
        db.prepare('UPDATE categories SET key = ? WHERE id = ?').run(correct, row.id);
        changed = true;
      }
    }
  }
  if (changed) {
    // Remap any tools whose stored category no longer has a matching row.
    // (Happens when all rows shared a wrong key and tools were saved under it.)
    db.prepare(
      "UPDATE tools SET category = 'other' WHERE category NOT IN (SELECT key FROM categories)"
    ).run();
  }
})();

// ---------------------------------------------------------------------------
// Migration: tools gain an optional "quantity" — how many physical units are
// owned. Default 1 means a unique single item (current behaviour unchanged).
// Values > 1 enable bulk checkout: multiple people can check out different
// quantities simultaneously.
// ---------------------------------------------------------------------------
(function ensureToolQuantity() {
  const cols = db.prepare('PRAGMA table_info(tools)').all();
  if (!cols.some((c) => c.name === 'quantity')) {
    db.prepare('ALTER TABLE tools ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1').run();
  }
})();

// ---------------------------------------------------------------------------
// Migration: checkouts gain "quantity" to record how many units were taken in
// a single checkout. Defaults to 1 so all existing rows are correct.
// ---------------------------------------------------------------------------
(function ensureCheckoutQuantity() {
  const cols = db.prepare('PRAGMA table_info(checkouts)').all();
  if (!cols.some((c) => c.name === 'quantity')) {
    db.prepare('ALTER TABLE checkouts ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1').run();
  }
})();

// ---------------------------------------------------------------------------
// Seed the default tool categories the first time the app runs.
// ---------------------------------------------------------------------------
(function seedCategories() {
  // Check before inserting — INSERT OR IGNORE is unreliable in Turso because
  // the UNIQUE constraint on categories.key was never pushed there (db.exec is
  // local-only), so "OR IGNORE" never fires and every boot re-inserts rows.
  const defaults = [
    ['drill', 'Drill', '🪛', '#3b82f6', 0],
    ['saw', 'Saw', '🪚', '#10b981', 1],
    ['ladder', 'Ladder', '🪜', '#f59e0b', 2],
    ['other', 'Other', '🧰', '#a1a1aa', 3],
  ];
  const exists = db.prepare('SELECT 1 FROM categories WHERE key = ?');
  const insert = db.prepare('INSERT INTO categories (key, label, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)');
  for (const [key, label, icon, color, sort] of defaults) {
    if (!exists.get(key)) insert.run(key, label, icon, color, sort);
  }
})();

// ---------------------------------------------------------------------------
// Migration: audit tables — managers can walk a site, scan/tap each tool they
// physically see, then finish to get a list of everything not confirmed.
// ---------------------------------------------------------------------------
(function ensureAuditTables() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_by INTEGER REFERENCES employees(id),
      started_at TEXT    NOT NULL DEFAULT (datetime('now')),
      ended_at   TEXT,
      note       TEXT
    )
  `).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_scans (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id   INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
      tool_id    INTEGER NOT NULL REFERENCES tools(id)  ON DELETE CASCADE,
      scanned_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(audit_id, tool_id)
    )
  `).run();
})();

// ---------------------------------------------------------------------------
// Seed the "Gateway (Auto)" system employee used for BLE auto-checkouts.
// active=0 keeps it out of the employee picker on the sign-out page.
// The pin_hash has no ':' so verifyPin() always returns false — this account
// can never be used for manual sign-in.
// ---------------------------------------------------------------------------
(function ensureGatewayAutoEmployee() {
  const existing = db.prepare("SELECT id FROM employees WHERE name = 'Gateway (Auto)'").get();
  if (!existing) {
    db.prepare(
      "INSERT INTO employees (name, pin_hash, role, active) VALUES ('Gateway (Auto)', 'gateway-auto-nologin', 'employee', 0)"
    ).run();
    console.log("  ↳ Created 'Gateway (Auto)' system employee for BLE auto-checkouts");
  }
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
