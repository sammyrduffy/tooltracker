// ---------------------------------------------------------------------------
// backup-db.js  —  Makes a timestamped, consistent copy of tooltracker.db.
//
//   node backup-db.js
//
// Uses SQLite's "VACUUM INTO" so the copy is safe even while the app is
// running and writing to the database. Keeps the most recent 30 backups in
// backups/ and deletes older ones automatically.
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { db } = require('./db');

const BACKUP_DIR = path.join(__dirname, 'backups');
const KEEP = 30;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(BACKUP_DIR, `tooltracker-${stamp}.db`);

db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);

const files = fs.readdirSync(BACKUP_DIR)
  .filter((f) => f.startsWith('tooltracker-') && f.endsWith('.db'))
  .sort();
while (files.length > KEEP) {
  fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
}

console.log(`Backed up to ${dest}`);
