// ---------------------------------------------------------------------------
// lib/labelid.js  —  Human-friendly tool IDs like "PNEU 003".
//
// Each tool stores a per-category sequence number (tools.label_seq). The
// displayed ID is the category's abbreviation + that zero-padded number. This
// replaces the random short_id (e.g. NH428B) everywhere it's shown to people;
// the short_id still lives on as the invisible QR-code URL key (/t/<short_id>),
// so existing printed stickers keep working.
// ---------------------------------------------------------------------------

// Fixed abbreviations for the known categories. Unknown (manager-added)
// categories fall back to the first 5 letters of their label.
const CAT_ABBR = {
  clamps: 'CLMP', corded_tools: 'CORD', corded_tools_and_accessories: 'CORD-ACC',
  drill: 'DRL', fans: 'FAN', heaters: 'HTR', hoses: 'HOSE',
  ladder: 'LDR', ladders: 'LDR', measuring_tools: 'MEAS', other: 'OTHR',
  pneumatic_tools: 'PNEU', pumps: 'PUMP', saw: 'SAW', scaffolding: 'SCAFF',
  unassigned: 'UNA', vacuums: 'VAC',
};

function catAbbr(key, categoryLabels) {
  if (!key) return 'TOOL';
  return CAT_ABBR[key] || ((categoryLabels && categoryLabels[key]) || key).slice(0, 5).toUpperCase();
}

// "PNEU 003" — null if the tool has no sequence yet (shouldn't happen after
// the backfill, but callers can fall back to short_id).
function toolLabelId(tool, categoryLabels) {
  if (!tool || tool.label_seq == null) return null;
  return catAbbr(tool.category, categoryLabels) + ' ' + String(tool.label_seq).padStart(3, '0');
}

// Remove words from the tool name that already appear in the category label so
// the abbreviation prefix on a printed label isn't redundant (e.g. drop
// "Pneumatic" when the PNEU prefix is shown). Short words (≤3 chars) are left
// alone to avoid over-stripping (Saw, Fan, etc.).
function labelName(name, catKey, categoryLabels) {
  const catLabel = (categoryLabels && categoryLabels[catKey]) || '';
  const words = catLabel.split(/\s+/).filter((w) => w.length > 3);
  let result = name || '';
  for (const w of words) {
    result = result.replace(new RegExp('\\b' + w + '\\b', 'gi'), '');
  }
  return result.replace(/\s{2,}/g, ' ').trim() || name;
}

module.exports = { CAT_ABBR, catAbbr, toolLabelId, labelName };
