// ---------------------------------------------------------------------------
// lib/categories.js  —  Tool categories (e.g. Drill, Saw, Ladder, Other).
// Managers can add/edit/remove these; everything is read fresh from the
// database so changes show up immediately everywhere.
// ---------------------------------------------------------------------------

const { db } = require('../db');

function listCategories() {
  return db.prepare('SELECT * FROM categories ORDER BY sort_order, label').all();
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

module.exports = { listCategories, categoryKeys, categoryMaps, categoryKey };
