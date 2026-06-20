// ---------------------------------------------------------------------------
// lib/categories.js  —  Tool categories (e.g. Drill, Saw, Ladder, Other).
// Managers can add/edit/remove these; everything is read fresh from the
// database so changes show up immediately everywhere.
// ---------------------------------------------------------------------------

const { db } = require('../db');

// `key` is a SQL reserved word. The libsql driver (Turso, in the cloud) returns
// the column name in its result rows as uppercase "KEY", while node:sqlite (the
// office PC) returns lowercase "key". Reading c.key therefore silently yielded
// `undefined` in production — every category collapsed to one undefined key and
// every dropdown showed the same single label. Normalize each row so callers
// can always read c.key regardless of which driver is active.
function normalizeRow(r) {
  if (r && r.key === undefined) {
    for (const k of Object.keys(r)) {
      if (k.toLowerCase() === 'key') { r.key = r[k]; break; }
    }
  }
  return r;
}

function listCategories() {
  return db.prepare('SELECT * FROM categories ORDER BY sort_order, label').all().map(normalizeRow);
}

// Fetch a single category by id with the same key-casing normalization.
function getCategoryById(id) {
  return normalizeRow(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
}

function categoryKeys() {
  return listCategories().map((c) => c.key);
}

// Build the { key: label }, { key: icon }, { key: color } lookup maps used
// throughout the templates as h.CATEGORY_LABELS[...] etc.
function categoryMaps() {
  const labels = {};
  const icons = {};
  const colors = {};
  for (const c of listCategories()) {
    labels[c.key] = c.label;
    icons[c.key] = c.icon;
    colors[c.key] = c.color;
  }
  return { labels, icons, colors };
}

// Turn a category name into a stable, URL/DB-safe key, e.g. "Power Drills" -> "power_drills".
function categoryKey(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

module.exports = { listCategories, getCategoryById, categoryKeys, categoryMaps, categoryKey };
