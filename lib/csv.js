// ---------------------------------------------------------------------------
// csv.js  —  A small, correct CSV parser (no external dependency).
//
// Handles quoted fields, commas and line breaks inside quotes, and escaped
// quotes ("" inside a quoted field). Returns an array of rows, each an array
// of string cells. Strips a leading UTF-8 BOM (Excel adds one).
// ---------------------------------------------------------------------------

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  text = String(text).replace(/^﻿/, '');

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignore — newline is handled on \n
    } else {
      field += c;
    }
  }
  // Flush the final field/row if the file didn't end with a newline.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  // Drop completely blank rows (e.g. trailing empty lines).
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

module.exports = { parseCSV };
