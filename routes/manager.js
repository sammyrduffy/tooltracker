// ---------------------------------------------------------------------------
// routes/manager.js  —  Manager login and the management screens.
//
// Everything under /manager (except the login page itself) requires a manager
// to be logged in with their PIN.
// ---------------------------------------------------------------------------

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const { db, hashPin, verifyPin, generateUniqueShortId, setSetting, getSetting, transaction } = require('../db');
const helpers = require('../lib/helpers');
const { resolveBaseUrl } = require('../lib/baseurl');
const { LABEL_SHEETS, DEFAULT_SHEET } = require('../lib/labels');
const { MATERIAL_TYPES, materialKey } = require('../lib/materials');
const { parseCSV } = require('../lib/csv');
const { listCategories, categoryKeys, categoryMaps, categoryKey } = require('../lib/categories');
const { ensureBleSchema } = require('../lib/ble/schema');
const { invalidateScannerCache } = require('../lib/ble/ingest');

// Make sure the beacon tables exist before any prepared statement below
// touches them — this module can be required before lib/ble/ingest.js runs.
ensureBleSchema(db);

// --- Photo uploads for tools and sites --------------------------------------
// lib/photos picks where they land: public/uploads on a PC, Cloudinary in the
// cloud. Add `uploadToCloud` right after `upload.single('photo')` on any route
// that accepts a photo.
const { upload, uploadToCloud } = require('../lib/photos');

// CSV uploads are read straight from memory (no file saved to disk).
const uploadCsv = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });


// --- Gatekeeper: require a logged-in manager or field user for everything below
function requireManager(req, res, next) {
  if (req.session.manager) {
    // Sessions created before the Field User role existed have no role saved —
    // treat those as managers so old logins keep their full access.
    if (!req.session.manager.role) req.session.manager.role = 'manager';
    return next();
  }
  return res.redirect('/manager/login');
}

// --- Permission gate: restrict a route to specific roles --------------------
// Use after requireManager. Pass the role(s) allowed to use the route — anyone
// logged in with a different role gets a 403 "access denied" page instead.
// Example:
//   router.post('/tools/:id/delete', checkPermission('manager'), (req, res) => { ... });
function checkPermission(...allowedRoles) {
  return (req, res, next) => {
    if (allowedRoles.includes(req.session.manager.role)) return next();
    res.status(403).render('message', {
      title: 'Access denied',
      heading: 'Access denied',
      body: "You don't have permission to do that. Ask a manager if you need access.",
      backUrl: '/manager', backLabel: 'Back to home',
    });
  };
}

// ===========================================================================
// LOGIN / LOGOUT
// ===========================================================================
router.get('/login', (req, res) => {
  const managers = db.prepare(
    "SELECT id, name FROM employees WHERE role IN ('manager', 'field_user') AND active = 1 ORDER BY name"
  ).all();
  res.render('manager/login', { managers, error: null });
});

router.post('/login', (req, res) => {
  const manager = db.prepare(
    "SELECT * FROM employees WHERE id = ? AND role IN ('manager', 'field_user') AND active = 1"
  ).get(Number(req.body.employee_id));

  const renderError = () => {
    const managers = db.prepare(
      "SELECT id, name FROM employees WHERE role IN ('manager', 'field_user') AND active = 1 ORDER BY name"
    ).all();
    res.status(401).render('manager/login', {
      managers, error: 'Wrong name or PIN. Please try again.',
    });
  };

  if (!manager || !verifyPin(req.body.pin, manager.pin_hash)) return renderError();

  req.session.manager = { id: manager.id, name: manager.name, role: manager.role };
  res.redirect('/manager');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/manager/login'));
});

// Everything past this point requires login.
router.use(requireManager);

// ===========================================================================
// SETTINGS — install instructions, profile, account, invite link
// ===========================================================================
router.get('/settings', (req, res) => {
  res.render('manager/settings', { url: resolveBaseUrl(req) });
});

// --- Update your own display name --------------------------------------------
router.post('/settings/profile', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    req.session.flash = { type: 'error', text: 'Please enter a name.' };
    return res.redirect('/manager/settings');
  }
  db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(name, req.session.manager.id);
  req.session.manager.name = name;
  req.session.flash = { type: 'success', text: 'Profile updated.' };
  res.redirect('/manager/settings');
});

// --- Change your own PIN ------------------------------------------------------
router.post('/settings/pin', (req, res) => {
  const current = (req.body.current_pin || '').trim();
  const next = (req.body.new_pin || '').trim();
  const confirm = (req.body.confirm_pin || '').trim();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.session.manager.id);

  const fail = (text) => { req.session.flash = { type: 'error', text }; res.redirect('/manager/settings'); };

  if (!verifyPin(current, employee.pin_hash)) return fail('Your current PIN was incorrect.');
  if (!/^\d{4}$/.test(next)) return fail('Your new PIN must be exactly 4 digits.');
  if (next !== confirm) return fail('The new PINs you entered don\'t match.');

  db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(hashPin(next), employee.id);
  req.session.flash = { type: 'success', text: 'PIN updated.' };
  res.redirect('/manager/settings');
});

// ===========================================================================
// DASHBOARD — what's out (grouped by site), plus simple stats
// ===========================================================================
router.get('/', (req, res) => {
  const counts = {
    tools: db.prepare('SELECT COUNT(*) AS n FROM tools').get().n,
    out: db.prepare("SELECT COUNT(*) AS n FROM tools WHERE status = 'signed_out'").get().n,
    employees: db.prepare('SELECT COUNT(*) AS n FROM employees WHERE active = 1').get().n,
    sites: db.prepare('SELECT COUNT(*) AS n FROM sites WHERE active = 1').get().n,
    materials: db.prepare('SELECT COUNT(*) AS n FROM materials').get().n,
    beacons: db.prepare('SELECT COUNT(*) AS n FROM beacon_state').get().n,
  };

  // Everything currently signed out, longest-out first.
  const out = db.prepare(`
    SELECT c.time_out, t.id AS tool_id, t.name AS tool_name, t.short_id,
           e.name AS employee_name, s.name AS site_name
    FROM checkouts c
    JOIN tools t ON t.id = c.tool_id
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN sites s ON s.id = c.site_id
    WHERE c.time_in IS NULL
    ORDER BY c.time_out ASC
  `).all();

  // Group those rows by site name for the dashboard.
  const bySite = [];
  const index = new Map();
  for (const row of out) {
    const key = row.site_name || 'No site recorded';
    if (!index.has(key)) { index.set(key, { site: key, items: [] }); bySite.push(index.get(key)); }
    index.get(key).items.push(row);
  }

  // Stats: most-used tools, and tools never used.
  const mostUsed = db.prepare(`
    SELECT t.name, COUNT(c.id) AS uses
    FROM tools t JOIN checkouts c ON c.tool_id = t.id
    GROUP BY t.id ORDER BY uses DESC, t.name LIMIT 5
  `).all();
  const neverUsed = db.prepare(`
    SELECT t.name FROM tools t
    LEFT JOIN checkouts c ON c.tool_id = t.id
    WHERE c.id IS NULL ORDER BY t.name
  `).all();

  res.render('manager/dashboard', { counts, bySite, totalOut: out.length, mostUsed, neverUsed });
});

// Download the full checkout history as a CSV (opens in Excel / Google Sheets).
router.get('/export/checkouts.csv', checkPermission('manager'), (req, res) => {
  const rows = db.prepare(`
    SELECT t.name AS tool, t.short_id AS code, e.name AS employee, s.name AS site,
           c.time_out, c.time_in, c.notes
    FROM checkouts c
    JOIN tools t ON t.id = c.tool_id
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN sites s ON s.id = c.site_id
    ORDER BY c.time_out DESC
  `).all();

  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Tool', 'Code', 'Employee', 'Site', 'Time out (UTC)', 'Time in (UTC)', 'Duration', 'Still out?', 'Notes'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.tool, r.code, r.employee, r.site || '',
      r.time_out || '', r.time_in || '',
      helpers.durationSince(r.time_out, r.time_in),
      r.time_in ? 'No' : 'Yes',
      r.notes || '',
    ].map(esc).join(','));
  }

  sendCsv(res, 'checkout-history.csv', header, rows.map((r) => [
    r.tool, r.code, r.employee, r.site || '', r.time_out || '', r.time_in || '',
    helpers.durationSince(r.time_out, r.time_in), r.time_in ? 'No' : 'Yes', r.notes || '',
  ]));
});

// Writes a CSV download (BOM so Excel reads accents; quotes fields as needed).
function sendCsv(res, filename, header, rows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + body);
}

// A site's checkout history within an optional date range.
router.get('/export/site-history.csv', checkPermission('manager'), (req, res) => {
  const siteId = Number(req.query.site_id);
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) return res.redirect('/manager/sites');

  const where = ['c.site_id = ?'];
  const params = [siteId];
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();
  if (from) { where.push('date(c.time_out) >= date(?)'); params.push(from); }
  if (to) { where.push('date(c.time_out) <= date(?)'); params.push(to); }

  const rows = db.prepare(`
    SELECT t.name AS tool, t.short_id AS code, e.name AS employee, c.time_out, c.time_in, c.notes
    FROM checkouts c
    JOIN tools t ON t.id = c.tool_id
    JOIN employees e ON e.id = c.employee_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.time_out DESC
  `).all(...params);

  const safeName = site.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'site';
  sendCsv(res, `${safeName}-history.csv`,
    ['Tool', 'Code', 'Employee', 'Out', 'In', 'Duration', 'Still out', 'Notes'],
    rows.map((r) => [
      r.tool, r.code, r.employee, r.time_out || '', r.time_in || '',
      helpers.durationSince(r.time_out, r.time_in), r.time_in ? 'No' : 'Yes', r.notes || '',
    ]));
});

// Full tools inventory as CSV.
router.get('/export/tools.csv', checkPermission('manager'), (req, res) => {
  const rows = db.prepare(`
    SELECT t.name, t.short_id, t.category, t.serial_number, t.purchase_value, t.status, t.condition_notes,
      (SELECT s.name FROM checkouts c LEFT JOIN sites s ON s.id = c.site_id
       WHERE c.tool_id = t.id AND c.time_in IS NULL ORDER BY c.id DESC LIMIT 1) AS out_site
    FROM tools t ORDER BY t.name
  `).all();
  const home = getSetting('home_location') || 'Office';
  sendCsv(res, 'tools-inventory.csv',
    ['Tool', 'Code', 'Category', 'Serial #', 'Value', 'Status', 'Current location', 'Condition notes'],
    rows.map((t) => [
      t.name, t.short_id, t.category, t.serial_number || '', t.purchase_value != null ? t.purchase_value : '',
      (helpers.STATUS_LABELS[t.status] || t.status),
      t.status === 'signed_out' ? (t.out_site || 'Out') : (t.status === 'available' ? home : ''),
      t.condition_notes || '',
    ]));
});

// Full materials inventory as CSV.
router.get('/export/materials.csv', checkPermission('manager'), (req, res) => {
  const rows = db.prepare('SELECT name, type, quantity, unit, location, notes FROM materials ORDER BY type, name').all();
  sendCsv(res, 'materials-inventory.csv',
    ['Material', 'Type', 'Quantity', 'Unit', 'Location', 'Notes'],
    rows.map((m) => [m.name, m.type, m.quantity, m.unit || '', m.location || '', m.notes || '']));
});

// Reports hub + a printable inventory audit page.
const HISTORY_PREVIEW_LIMIT = 200;
router.get('/reports', checkPermission('manager'), (req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY name').all();
  const siteId = Number(req.query.site) || null;
  const site = siteId ? sites.find((s) => s.id === siteId) || null : null;

  const historyWhere = [];
  const historyParams = [];
  if (site) { historyWhere.push('c.site_id = ?'); historyParams.push(site.id); }
  const history = db.prepare(`
    SELECT t.name AS tool, t.short_id AS code, e.name AS employee,
           s.name AS site, c.time_out, c.time_in, c.notes
    FROM checkouts c
    JOIN tools t ON t.id = c.tool_id
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN sites s ON s.id = c.site_id
    ${historyWhere.length ? 'WHERE ' + historyWhere.join(' AND ') : ''}
    ORDER BY c.time_out DESC
    LIMIT ${HISTORY_PREVIEW_LIMIT}
  `).all(...historyParams);

  const materialsWhere = [];
  const materialsParams = [];
  if (site) { materialsWhere.push('lower(trim(location)) = lower(trim(?))'); materialsParams.push(site.name); }
  const materials = db.prepare(`
    SELECT name, type, quantity, unit, location, notes, updated_at
    FROM materials
    ${materialsWhere.length ? 'WHERE ' + materialsWhere.join(' AND ') : ''}
    ORDER BY type, name
  `).all(...materialsParams);

  res.render('manager/reports', {
    counts: {
      tools: db.prepare('SELECT COUNT(*) AS n FROM tools').get().n,
      materials: db.prepare('SELECT COUNT(*) AS n FROM materials').get().n,
      checkouts: db.prepare('SELECT COUNT(*) AS n FROM checkouts').get().n,
    },
    sites, siteId, history, materials, historyLimit: HISTORY_PREVIEW_LIMIT,
  });
});

router.get('/reports/inventory', checkPermission('manager'), (req, res) => {
  const home = getSetting('home_location') || 'Office';
  const tools = db.prepare(`
    SELECT t.*, (SELECT s.name FROM checkouts c LEFT JOIN sites s ON s.id = c.site_id
       WHERE c.tool_id = t.id AND c.time_in IS NULL ORDER BY c.id DESC LIMIT 1) AS out_site
    FROM tools t ORDER BY t.name
  `).all();
  const materials = db.prepare('SELECT * FROM materials ORDER BY type, name').all();
  res.render('manager/report-inventory', { tools, materials, home, generatedAt: new Date() });
});

// --- Billing -----------------------------------------------------------------
// Charge = billable days out × the tool's per-day rate, for every checkout that
// STARTED within the date range, limited to tools that have a rate set.
// Returns line items plus totals grouped by tool and by site.
function buildBilling(fromRaw, toRaw) {
  const to = (toRaw || '').trim() || new Date().toISOString().slice(0, 10);
  const from = (fromRaw || '').trim() || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT t.id AS tool_id, t.name AS tool, t.short_id AS code, t.billable_rate AS rate,
           e.name AS employee, s.id AS site_id, s.name AS site, c.time_out, c.time_in
    FROM checkouts c
    JOIN tools t ON t.id = c.tool_id
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN sites s ON s.id = c.site_id
    WHERE t.billable_rate IS NOT NULL AND t.billable_rate > 0
      AND date(c.time_out) >= date(?) AND date(c.time_out) <= date(?)
    ORDER BY c.time_out DESC
  `).all(from, to);

  const byToolMap = new Map();
  const bySiteMap = new Map();
  let grandTotal = 0;
  const lineItems = rows.map((r) => {
    const days = helpers.billableDays(r.time_out, r.time_in);
    const charge = days * r.rate;
    grandTotal += charge;
    const tk = r.tool_id;
    const tprev = byToolMap.get(tk) || { tool: r.tool, code: r.code, days: 0, charge: 0 };
    tprev.days += days; tprev.charge += charge; byToolMap.set(tk, tprev);
    const sk = r.site_id == null ? 'none' : r.site_id;
    const sprev = bySiteMap.get(sk) || { site: r.site || 'No job site', days: 0, charge: 0 };
    sprev.days += days; sprev.charge += charge; bySiteMap.set(sk, sprev);
    return { ...r, days, charge };
  });

  return {
    from, to, lineItems, grandTotal,
    byTool: [...byToolMap.values()].sort((a, b) => b.charge - a.charge),
    bySite: [...bySiteMap.values()].sort((a, b) => b.charge - a.charge),
  };
}

router.get('/reports/billing', checkPermission('manager'), (req, res) => {
  res.render('manager/report-billing', buildBilling(req.query.from, req.query.to));
});

router.get('/export/billing.csv', checkPermission('manager'), (req, res) => {
  const { lineItems } = buildBilling(req.query.from, req.query.to);
  sendCsv(res, 'billing.csv',
    ['Tool', 'Code', 'Site', 'Person', 'Time out (UTC)', 'Time in (UTC)', 'Days', 'Rate/day', 'Charge'],
    lineItems.map((r) => [
      r.tool, r.code, r.site || 'No job site', r.employee,
      r.time_out || '', r.time_in || '', r.days,
      Number(r.rate).toFixed(2), Number(r.charge).toFixed(2),
    ]));
});

// ===========================================================================
// TOOLS
// ===========================================================================
const TOOL_STATUSES = ['available', 'signed_out', 'needs_repair', 'in_repair', 'missing'];

router.get('/tools', (req, res) => {
  const q = (req.query.q || '').trim();
  const category = categoryKeys().includes(req.query.category) ? req.query.category : '';
  const status = TOOL_STATUSES.includes(req.query.status) ? req.query.status : '';

  const where = [];
  const params = [];
  if (q) {
    where.push("(name LIKE ? OR coalesce(description,'') LIKE ? OR coalesce(serial_number,'') LIKE ? OR short_id LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (category) { where.push('category = ?'); params.push(category); }
  if (status) { where.push('status = ?'); params.push(status); }

  const sql = `SELECT t.*,
      (SELECT s.name FROM checkouts c LEFT JOIN sites s ON s.id = c.site_id
       WHERE c.tool_id = t.id AND c.time_in IS NULL ORDER BY c.id DESC LIMIT 1) AS out_site
    FROM tools t`
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY t.name';
  const tools = db.prepare(sql).all(...params);
  const sites = db.prepare('SELECT * FROM sites WHERE active = 1 ORDER BY name').all();

  res.render('manager/tools', {
    tools, q, category, status, categories: categoryKeys(), statuses: TOOL_STATUSES, sites,
    homeLocation: getSetting('home_location') || 'Office',
  });
});

// --- Bulk import tools from a CSV file -------------------------------------
router.get('/tools/import', checkPermission('manager'), (req, res) => {
  res.render('manager/tool-import', { result: null, error: null });
});

router.get('/tools/template.csv', checkPermission('manager'), (req, res) => {
  const sample = [
    'name,description,serial_number,category,purchase_value,condition_notes',
    'DeWalt 20V Drill,Cordless with 2 batteries,DCD777-001,drill,199,Good',
    'Makita Circular Saw,7-1/4 inch blade,MK-5007,saw,149,',
    '8 ft Step Ladder,Fiberglass,,ladder,120,Minor scuff',
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tools-template.csv"');
  res.send('﻿' + sample);
});

router.post('/tools/import', checkPermission('manager'), uploadCsv.single('file'), (req, res) => {
  const fail = (msg) => res.status(400).render('manager/tool-import', { result: null, error: msg });
  if (!req.file) return fail('Please choose a CSV file to upload.');

  const rows = parseCSV(req.file.buffer.toString('utf8'));
  if (rows.length < 2) return fail('The file needs a header row plus at least one tool row.');

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (names) => { for (const n of names) { const i = header.indexOf(n); if (i !== -1) return i; } return -1; };
  const idx = {
    name: col(['name', 'tool', 'item']),
    description: col(['description', 'desc']),
    serial: col(['serial_number', 'serial', 'serial #', 'serialnumber', 'serial number']),
    category: col(['category', 'type']),
    value: col(['purchase_value', 'value', 'price', 'cost']),
    condition: col(['condition_notes', 'condition', 'notes']),
  };
  if (idx.name === -1) {
    return fail('Could not find a "name" column. The first row must name the columns, e.g. name,description,serial_number,category,purchase_value,condition_notes');
  }

  const cell = (row, i) => (i === -1 || i >= row.length ? '' : String(row[i]).trim());
  const result = { added: 0, skipped: 0, errors: [], total: rows.length - 1 };
  const findSerial = db.prepare('SELECT 1 FROM tools WHERE serial_number = ? LIMIT 1');
  const validCategories = categoryKeys();
  const fallbackCategory = validCategories.includes('other') ? 'other' : validCategories[0];

  transaction(() => {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const name = cell(row, idx.name);
      if (!name) { result.skipped++; result.errors.push(`Row ${r + 1}: no name — skipped.`); continue; }

      const serial = cell(row, idx.serial) || null;
      if (serial && findSerial.get(serial)) {
        result.skipped++; result.errors.push(`Row ${r + 1} (${name}): serial "${serial}" already exists — skipped.`); continue;
      }

      const vRaw = cell(row, idx.value);
      let value = null;
      if (vRaw !== '') {
        const v = Number(vRaw.replace(/[$,]/g, ''));
        if (Number.isNaN(v) || v < 0) {
          result.skipped++; result.errors.push(`Row ${r + 1} (${name}): value "${vRaw}" is not a valid number — skipped.`); continue;
        }
        value = v;
      }

      let category = cell(row, idx.category).toLowerCase();
      if (!validCategories.includes(category)) category = fallbackCategory;

      db.prepare(`
        INSERT INTO tools (short_id, name, description, serial_number, category, purchase_value, condition_notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'available')
      `).run(generateUniqueShortId(), name, cell(row, idx.description) || null, serial, category, value, cell(row, idx.condition) || null);
      result.added++;
    }
  });

  res.render('manager/tool-import', { result, error: null });
});

// Mark a tool Available / Needs repair / In repair / Missing. Any open checkout
// is closed (a repair, a write-off, or a manager force-return all end the loan).
// Moving to In repair or Available also resolves any open field-reported issues.
router.post('/tools/:id/status', checkPermission('manager'), (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(Number(req.params.id));
  if (!tool) return res.redirect('/manager/tools');
  const status = ['available', 'needs_repair', 'in_repair', 'missing'].includes(req.body.status) ? req.body.status : null;
  if (status) {
    transaction(() => {
      db.prepare("UPDATE checkouts SET time_in = datetime('now') WHERE tool_id = ? AND time_in IS NULL").run(tool.id);
      db.prepare('UPDATE tools SET status = ? WHERE id = ?').run(status, tool.id);
      // Taking it in for repair (or returning it to service) clears open issues.
      if (status === 'in_repair' || status === 'available') {
        db.prepare("UPDATE tool_issues SET status = 'resolved', resolved_at = datetime('now') WHERE tool_id = ? AND status = 'open'").run(tool.id);
      }
    });
    req.session.flash = { type: 'success', text: '✓ Marked ' + helpers.STATUS_LABELS[status] };
  }
  const back = req.body.return_to;
  res.redirect(back && back.startsWith('/manager') ? back : '/manager/tools');
});

router.get('/tools/new', checkPermission('manager'), (req, res) => {
  res.render('manager/tool-form', { tool: null, categories: categoryKeys(), error: null, openIssue: null });
});

// The most recent unresolved field-reported issue for a tool (or null).
const getOpenIssue = db.prepare(`
  SELECT i.*, e.name AS reporter_name
  FROM tool_issues i
  LEFT JOIN employees e ON e.id = i.reported_by
  WHERE i.tool_id = ? AND i.status = 'open'
  ORDER BY i.id DESC LIMIT 1
`);

router.post('/tools', checkPermission('manager'), upload.single('photo'), uploadToCloud, (req, res) => {
  const data = readToolForm(req);
  if (data.error) {
    return res.status(400).render('manager/tool-form', {
      tool: req.body, categories: categoryKeys(), error: data.error, openIssue: null,
    });
  }
  const shortId = generateUniqueShortId();
  db.prepare(`
    INSERT INTO tools (short_id, name, description, serial_number, category,
                       purchase_value, billable_rate, condition_notes, photo, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available')
  `).run(shortId, data.name, data.description, data.serial_number, data.category,
         data.purchase_value, data.billable_rate, data.condition_notes,
         req.file ? req.file.filename : null);
  req.session.flash = { type: 'success', text: '✓ Tool added' };
  res.redirect('/manager/tools');
});

router.get('/tools/:id/edit', (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(Number(req.params.id));
  if (!tool) return res.redirect('/manager/tools');
  res.render('manager/tool-form', { tool, categories: categoryKeys(), error: null, openIssue: getOpenIssue.get(tool.id) || null });
});

router.post('/tools/:id', checkPermission('manager'), upload.single('photo'), uploadToCloud, (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(Number(req.params.id));
  if (!tool) return res.redirect('/manager/tools');
  const data = readToolForm(req);
  if (data.error) {
    return res.status(400).render('manager/tool-form', {
      tool: { ...tool, ...req.body }, categories: categoryKeys(), error: data.error,
      openIssue: getOpenIssue.get(tool.id) || null,
    });
  }
  db.prepare(`
    UPDATE tools SET name = ?, description = ?, serial_number = ?, category = ?,
           purchase_value = ?, billable_rate = ?, condition_notes = ?,
           photo = COALESCE(?, photo)
    WHERE id = ?
  `).run(data.name, data.description, data.serial_number, data.category,
         data.purchase_value, data.billable_rate, data.condition_notes,
         req.file ? req.file.filename : null, tool.id);
  req.session.flash = { type: 'success', text: '✓ Saved' };
  res.redirect('/manager/tools');
});

router.post('/tools/:id/delete', checkPermission('manager'), (req, res) => {
  db.prepare('DELETE FROM tools WHERE id = ?').run(Number(req.params.id));
  req.session.flash = { type: 'success', text: 'Tool deleted' };
  res.redirect('/manager/tools');
});

// Per-tool history: every checkout (past and current) for this tool.
router.get('/tools/:id/history', (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(Number(req.params.id));
  if (!tool) return res.redirect('/manager/tools');
  const history = db.prepare(`
    SELECT c.time_out, c.time_in, e.name AS employee_name, s.name AS site_name
    FROM checkouts c
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN sites s ON s.id = c.site_id
    WHERE c.tool_id = ?
    ORDER BY c.time_out DESC
  `).all(tool.id);
  res.render('manager/tool-history', { tool, history });
});

// Compact history fragment for the expandable row on the tools list.
router.get('/tools/:id/history-fragment', (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(Number(req.params.id));
  if (!tool) return res.status(404).send('');
  const history = db.prepare(`
    SELECT c.time_out, c.time_in, e.name AS employee_name, s.name AS site_name
    FROM checkouts c
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN sites s ON s.id = c.site_id
    WHERE c.tool_id = ?
    ORDER BY c.time_out DESC
  `).all(tool.id);
  const home = getSetting('home_location') || 'Office';
  let currentLocation = home;
  if (tool.status === 'signed_out') {
    currentLocation = (history.find((c) => !c.time_in) || {}).site_name || 'Out';
  } else if (tool.status !== 'available') {
    currentLocation = helpers.STATUS_LABELS[tool.status] || tool.status;
  }
  res.render('manager/_history-fragment', { tool, history, currentLocation });
});

// Bulk move: send several tools (available or signed-out) to a job site at once.
// Signed-out tools have their open checkout re-assigned to the new site.
// Available tools get a new checkout (to the manager doing the move) and flip to signed_out.
router.post('/tools/move', checkPermission('manager'), (req, res) => {
  let ids = req.body.tool_ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(Boolean);
  const destSiteId = Number(req.body.destination_site_id) || null;

  if (ids.length && destSiteId) {
    const getOpenCheckout = db.prepare('SELECT id FROM checkouts WHERE tool_id = ? AND time_in IS NULL');
    const updateCheckout = db.prepare('UPDATE checkouts SET site_id = ? WHERE id = ?');
    const insertCheckout = db.prepare('INSERT INTO checkouts (tool_id, employee_id, site_id) VALUES (?, ?, ?)');
    const markSignedOut = db.prepare("UPDATE tools SET status = 'signed_out' WHERE id = ?");
    transaction(() => {
      for (const toolId of ids) {
        const open = getOpenCheckout.get(toolId);
        if (open) {
          updateCheckout.run(destSiteId, open.id);
        } else {
          insertCheckout.run(toolId, req.session.manager.id, destSiteId);
          markSignedOut.run(toolId);
        }
      }
    });
  }
  const dest = destSiteId ? db.prepare('SELECT name FROM sites WHERE id = ?').get(destSiteId) : null;
  req.session.flash = ids.length && dest
    ? { type: 'success', text: `✓ Moved ${ids.length} tool${ids.length === 1 ? '' : 's'} to ${dest.name}` }
    : { type: 'error', text: 'Select at least one tool and a destination site.' };
  const returnTo = (req.body.return_to || '').trim();
  res.redirect(returnTo.startsWith('/manager/') ? returnTo : '/manager/tools');
});

// Reads + validates the tool form fields. Returns { error } or clean values.
function readToolForm(req) {
  const name = (req.body.name || '').trim();
  if (!name) return { error: 'A tool name is required.' };
  const validCategories = categoryKeys();
  let category = (req.body.category || '').trim();
  if (!validCategories.includes(category)) category = validCategories.includes('other') ? 'other' : (validCategories[0] || 'other');
  let purchase_value = null;
  if ((req.body.purchase_value || '').trim() !== '') {
    const v = Number(req.body.purchase_value);
    if (Number.isNaN(v) || v < 0) return { error: 'Purchase value must be a number.' };
    purchase_value = v;
  }
  let billable_rate = null;
  if ((req.body.billable_rate || '').trim() !== '') {
    const v = Number(req.body.billable_rate);
    if (Number.isNaN(v) || v < 0) return { error: 'Billable rate must be a number.' };
    billable_rate = v;
  }
  return {
    name,
    description: (req.body.description || '').trim() || null,
    serial_number: (req.body.serial_number || '').trim() || null,
    category,
    purchase_value,
    billable_rate,
    condition_notes: (req.body.condition_notes || '').trim() || null,
  };
}

// ===========================================================================
// PRINT LABELS (QR-code sticker sheets)
// ===========================================================================
router.get('/labels', checkPermission('manager'), (req, res) => {
  const sheetKey = LABEL_SHEETS[req.query.sheet] ? req.query.sheet : DEFAULT_SHEET;
  const spec = LABEL_SHEETS[sheetKey];

  // Which tools to print: specific ids, a category, or everything.
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const category = categoryKeys().includes(req.query.category) ? req.query.category : '';
  let tools;
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    tools = db.prepare(`SELECT * FROM tools WHERE id IN (${ph}) ORDER BY name`).all(...ids);
  } else if (category) {
    tools = db.prepare('SELECT * FROM tools WHERE category = ? ORDER BY name').all(category);
  } else {
    tools = db.prepare('SELECT * FROM tools ORDER BY name').all();
  }

  // Optionally skip some label positions (to reuse a partly-used sheet).
  const skip = Math.max(0, Math.min(parseInt(req.query.skip, 10) || 0, spec.cols * spec.rows - 1));

  // Build the full list of cells (blank skips + tools), then split into pages.
  const perPage = spec.cols * spec.rows;
  const cells = [...Array(skip).fill(null), ...tools];
  const pages = [];
  for (let i = 0; i < cells.length; i += perPage) pages.push(cells.slice(i, i + perPage));
  if (pages.length === 0) pages.push([]);

  res.render('manager/labels', {
    sheets: LABEL_SHEETS, sheetKey, spec,
    categories: categoryKeys(), category,
    skip, tools, pages,
    baseUrl: resolveBaseUrl(req),
    idsParam: String(req.query.ids || ''),
  });
});

// Save the web address that QR codes should encode.
router.post('/labels/base-url', checkPermission('manager'), (req, res) => {
  const value = (req.body.base_url || '').trim().replace(/\/+$/, '');
  setSetting('base_url', value);
  res.redirect(req.body.return_to && req.body.return_to.startsWith('/manager/labels')
    ? req.body.return_to : '/manager/labels');
});

// ===========================================================================
// MATERIALS (bulk supplies — quantity + location, no sign-out, no QR)
// ===========================================================================
router.get('/materials', (req, res) => {
  const type = MATERIAL_TYPES.includes(req.query.type) ? req.query.type : '';
  const location = (req.query.location || '').trim();

  // Build the filter (type and/or site/location can each narrow the list).
  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (location) { where.push("lower(coalesce(location, '')) = lower(?)"); params.push(location); }
  const sql = 'SELECT * FROM materials'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY type, name';
  const materials = db.prepare(sql).all(...params);

  // The list of places that currently hold materials, for the site filter.
  const locations = db.prepare(
    "SELECT DISTINCT location FROM materials WHERE location IS NOT NULL AND trim(location) <> '' ORDER BY location"
  ).all().map((r) => r.location);

  res.render('manager/materials', { materials, types: MATERIAL_TYPES, type, locations, location, destinations: allLocations() });
});

// Move selected: move the chosen quantity of each checked material to one destination.
router.post('/materials/move-selected', (req, res) => {
  let ids = req.body.mat_ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(Boolean);
  const materials = ids.map((id) => db.prepare('SELECT * FROM materials WHERE id = ?').get(id)).filter(Boolean);
  const dest = (req.body.destination || '').trim();

  if (!materials.length || !dest) return res.redirect('/manager/materials');

  let moved = 0;
  transaction(() => {
    for (const m of materials) {
      const qty = Number(req.body['qty_' + m.id]);
      if (!qty || qty <= 0) continue;
      if (String(m.location || '').toLowerCase() === dest.toLowerCase()) continue; // already there
      const moveQty = Math.min(qty, m.quantity);
      if (moveQty >= m.quantity) {
        db.prepare('DELETE FROM materials WHERE id = ?').run(m.id);
      } else {
        db.prepare("UPDATE materials SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ?")
          .run(moveQty, m.id);
      }
      upsertMaterial({ name: m.name, type: m.type, quantity: moveQty, unit: m.unit, location: dest, notes: m.notes });
      moved++;
    }
  });

  req.session.flash = { type: 'success', text: `✓ Moved ${moved} material${moved === 1 ? '' : 's'} to ${dest}` };
  res.redirect('/manager/materials?location=' + encodeURIComponent(dest));
});

// --- Bulk import materials from a CSV file ---------------------------------
router.get('/materials/import', (req, res) => {
  res.render('manager/material-import', { result: null, error: null });
});

router.get('/materials/template.csv', (req, res) => {
  const sample = [
    'name,type,quantity,unit,location,notes',
    '2x4x8 Stud,Framing,250,ea,Riverside Renovation,',
    '1/2in Drywall 4x8,Interior,60,sheets,Oakwood New Build,',
    '12-2 Romex,Electrical,4,boxes,Shop / Warehouse,blue jacket',
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="materials-template.csv"');
  res.send('﻿' + sample);
});

router.post('/materials/import', uploadCsv.single('file'), (req, res) => {
  const fail = (msg) => res.status(400).render('manager/material-import', { result: null, error: msg });
  if (!req.file) return fail('Please choose a CSV file to upload.');

  const rows = parseCSV(req.file.buffer.toString('utf8'));
  if (rows.length < 2) return fail('The file needs a header row plus at least one material row.');

  // Match header columns by name (case-insensitive, with common alternatives).
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (names) => { for (const n of names) { const i = header.indexOf(n); if (i !== -1) return i; } return -1; };
  const idx = {
    name: col(['name', 'material', 'item']),
    type: col(['type', 'category']),
    quantity: col(['quantity', 'qty', 'count', 'amount']),
    unit: col(['unit', 'units', 'uom']),
    location: col(['location', 'site', 'place', 'where']),
    notes: col(['notes', 'note', 'description']),
  };
  if (idx.name === -1) {
    return fail('Could not find a "name" column. The first row must name the columns, e.g. name,type,quantity,unit,location,notes');
  }

  const cell = (row, i) => (i === -1 || i >= row.length ? '' : String(row[i]).trim());
  const result = { added: 0, merged: 0, skipped: 0, errors: [], total: rows.length - 1 };

  transaction(() => {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const name = cell(row, idx.name);
      if (!name) { result.skipped++; result.errors.push(`Row ${r + 1}: no name — skipped.`); continue; }

      const qRaw = cell(row, idx.quantity);
      let quantity = 0;
      if (qRaw !== '') {
        const q = Number(qRaw.replace(/,/g, ''));
        if (Number.isNaN(q) || q < 0) {
          result.skipped++; result.errors.push(`Row ${r + 1} (${name}): quantity "${qRaw}" is not a valid number — skipped.`); continue;
        }
        quantity = q;
      }

      let type = cell(row, idx.type);
      const typeMatch = MATERIAL_TYPES.find((t) => t.toLowerCase() === type.toLowerCase());
      type = typeMatch || 'Miscellaneous';

      const action = upsertMaterial({
        name, type, quantity,
        unit: cell(row, idx.unit) || null,
        location: cell(row, idx.location) || null,
        notes: cell(row, idx.notes) || null,
      });
      if (action === 'merged') result.merged++; else result.added++;
    }
  });

  res.render('manager/material-import', { result, error: null });
});

router.get('/materials/new', (req, res) => {
  res.render('manager/material-form', {
    material: null, types: MATERIAL_TYPES, locations: locationSuggestions(), names: materialNames(), error: null,
  });
});

router.post('/materials', (req, res) => {
  const data = readMaterialForm(req);
  if (data.error) {
    return res.status(400).render('manager/material-form', {
      material: req.body, types: MATERIAL_TYPES, locations: locationSuggestions(), names: materialNames(), error: data.error,
    });
  }
  const act = upsertMaterial(data);
  req.session.flash = { type: 'success', text: act === 'merged' ? '✓ Quantity added to existing material' : '✓ Material added' };
  res.redirect('/manager/materials' + (data.location ? '?location=' + encodeURIComponent(data.location) : ''));
});

// Add a material, OR — if the same name already exists at the same location —
// add to that first entry's quantity instead of creating a duplicate row.
// Returns 'merged' or 'inserted'. Used by both the add form and the CSV import.
function upsertMaterial(data) {
  // Match on the normalized name key + the same location (case/space/plural-insensitive).
  const existing = db.prepare(`
    SELECT * FROM materials
    WHERE name_key = ?
      AND lower(trim(coalesce(location, ''))) = lower(trim(coalesce(?, '')))
    ORDER BY id LIMIT 1
  `).get(materialKey(data.name), data.location);

  if (existing) {
    db.prepare("UPDATE materials SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?")
      .run(data.quantity, existing.id);
    return 'merged';
  }
  db.prepare(`
    INSERT INTO materials (name, name_key, type, quantity, unit, location, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.name, materialKey(data.name), data.type, data.quantity, data.unit, data.location, data.notes);
  return 'inserted';
}

router.get('/materials/:id/edit', (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(req.params.id));
  if (!material) return res.redirect('/manager/materials');
  res.render('manager/material-form', {
    material, types: MATERIAL_TYPES, locations: locationSuggestions(), names: materialNames(), error: null,
  });
});

router.post('/materials/:id', (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(req.params.id));
  if (!material) return res.redirect('/manager/materials');
  const data = readMaterialForm(req);
  if (data.error) {
    return res.status(400).render('manager/material-form', {
      material: { ...material, ...req.body }, types: MATERIAL_TYPES,
      locations: locationSuggestions(), names: materialNames(), error: data.error,
    });
  }
  db.prepare(`
    UPDATE materials SET name = ?, name_key = ?, type = ?, quantity = ?, unit = ?, location = ?,
           notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(data.name, materialKey(data.name), data.type, data.quantity, data.unit, data.location, data.notes, material.id);
  req.session.flash = { type: 'success', text: '✓ Saved' };
  res.redirect('/manager/materials');
});

router.post('/materials/:id/delete', (req, res) => {
  db.prepare('DELETE FROM materials WHERE id = ?').run(Number(req.params.id));
  req.session.flash = { type: 'success', text: 'Material deleted' };
  res.redirect('/manager/materials');
});

// --- Transfer: move some quantity of a material to another site ------------
router.get('/materials/:id/transfer', (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(req.params.id));
  if (!material) return res.redirect('/manager/materials');
  res.render('manager/material-transfer', { material, locations: transferLocations(material), error: null });
});

router.post('/materials/:id/transfer', (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(req.params.id));
  if (!material) return res.redirect('/manager/materials');
  const err = (m) => res.status(400).render('manager/material-transfer', { material, locations: transferLocations(material), error: m });

  const dest = (req.body.destination || '').trim();
  const qty = Number(req.body.quantity);
  if (!dest) return err('Choose where to move it.');
  if (Number.isNaN(qty) || qty <= 0) return err('Enter how many to move.');
  if (qty > material.quantity) return err(`Only ${material.quantity} ${material.unit || ''} available to move.`);
  if (dest.toLowerCase() === String(material.location || '').toLowerCase()) return err('It is already at that location.');

  transaction(() => {
    if (qty >= material.quantity) {
      db.prepare('DELETE FROM materials WHERE id = ?').run(material.id);
    } else {
      db.prepare("UPDATE materials SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ?")
        .run(qty, material.id);
    }
    upsertMaterial({
      name: material.name, type: material.type, quantity: qty,
      unit: material.unit, location: dest, notes: material.notes,
    });
  });

  req.session.flash = { type: 'success', text: `✓ Moved ${qty} ${material.unit || ''} of ${material.name} to ${dest}`.replace('  ', ' ') };
  res.redirect('/manager/materials' + '?location=' + encodeURIComponent(dest));
});

// Destination suggestions for a transfer: the shop, active sites, and any place
// that already holds materials — minus where this material currently is.
// All known places: the shop, active sites, and anywhere materials already are.
function allLocations() {
  const set = new Set(['Shop / Warehouse']);
  db.prepare('SELECT name FROM sites WHERE active = 1 ORDER BY name').all().forEach((s) => set.add(s.name));
  db.prepare("SELECT DISTINCT location FROM materials WHERE location IS NOT NULL AND trim(location) <> ''")
    .all().forEach((r) => set.add(r.location));
  return [...set].sort();
}
function transferLocations(material) {
  return allLocations().filter((l) => l.toLowerCase() !== String((material && material.location) || '').toLowerCase());
}

// Suggested locations for the form's dropdown: active site names + the shop.
function locationSuggestions() {
  const siteNames = db.prepare('SELECT name FROM sites WHERE active = 1 ORDER BY name')
    .all().map((s) => s.name);
  return ['Shop / Warehouse', ...siteNames];
}

// Existing material names, for type-ahead autocomplete on the add/edit form.
function materialNames() {
  return db.prepare('SELECT DISTINCT name FROM materials ORDER BY name').all().map((m) => m.name);
}

function readMaterialForm(req) {
  const name = (req.body.name || '').trim();
  if (!name) return { error: 'A material name is required.' };
  let type = (req.body.type || 'Miscellaneous').trim();
  if (!MATERIAL_TYPES.includes(type)) type = 'Miscellaneous';
  let quantity = 0;
  if ((req.body.quantity || '').toString().trim() !== '') {
    const q = Number(req.body.quantity);
    if (Number.isNaN(q) || q < 0) return { error: 'Quantity must be a number (0 or more).' };
    quantity = q;
  }
  return {
    name, type, quantity,
    unit: (req.body.unit || '').trim() || null,
    location: (req.body.location || '').trim() || null,
    notes: (req.body.notes || '').trim() || null,
  };
}

// ===========================================================================
// EMPLOYEES
// ===========================================================================
router.use('/employees', checkPermission('manager'));

const EMPLOYEE_ROLES = ['manager', 'field_user', 'employee'];

router.get('/employees', (req, res) => {
  const q = (req.query.q || '').trim();
  const role = EMPLOYEE_ROLES.includes(req.query.role) ? req.query.role : '';

  const where = [];
  const params = [];
  if (q) {
    where.push('name LIKE ?');
    params.push(`%${q}%`);
  }
  if (role) { where.push('role = ?'); params.push(role); }

  const sql = 'SELECT * FROM employees'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY name';
  const employees = db.prepare(sql).all(...params);
  res.render('manager/employees', { employees, q, role });
});

router.get('/employees/new', (req, res) => {
  res.render('manager/employee-form', { employee: null, error: null });
});

router.post('/employees', (req, res) => {
  const data = readEmployeeForm(req, true);
  if (data.error) {
    return res.status(400).render('manager/employee-form', {
      employee: req.body, error: data.error,
    });
  }
  db.prepare('INSERT INTO employees (name, pin_hash, role, active) VALUES (?, ?, ?, ?)')
    .run(data.name, hashPin(data.pin), data.role, data.active);
  res.redirect('/manager/employees');
});

router.get('/employees/:id/edit', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
  if (!employee) return res.redirect('/manager/employees');
  res.render('manager/employee-form', { employee, error: null });
});

router.post('/employees/:id', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
  if (!employee) return res.redirect('/manager/employees');
  const data = readEmployeeForm(req, false);
  if (data.error) {
    return res.status(400).render('manager/employee-form', {
      employee: { ...employee, ...req.body }, error: data.error,
    });
  }
  // Only change the PIN if a new one was typed in.
  if (data.pin) {
    db.prepare('UPDATE employees SET name = ?, pin_hash = ?, role = ?, active = ? WHERE id = ?')
      .run(data.name, hashPin(data.pin), data.role, data.active, employee.id);
  } else {
    db.prepare('UPDATE employees SET name = ?, role = ?, active = ? WHERE id = ?')
      .run(data.name, data.role, data.active, employee.id);
  }
  res.redirect('/manager/employees');
});

router.post('/employees/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE employee_id = ?').get(id).n;
  if (used > 0) {
    return res.render('message', {
      title: 'Cannot delete',
      heading: 'Cannot delete this person',
      body: 'This employee appears in checkout history, so deleting them would erase that record. Edit them and switch them to "Inactive" instead — they will disappear from the pick lists but history stays intact.',
      backUrl: '/manager/employees', backLabel: 'Back to employees',
    });
  }
  db.prepare('DELETE FROM employees WHERE id = ?').run(id);
  res.redirect('/manager/employees');
});

function readEmployeeForm(req, pinRequired) {
  const name = (req.body.name || '').trim();
  if (!name) return { error: 'A name is required.' };
  const pin = (req.body.pin || '').trim();
  if (pinRequired && !pin) return { error: 'A 4-digit PIN is required.' };
  if (pin && !/^\d{4}$/.test(pin)) return { error: 'The PIN must be exactly 4 digits.' };
  const role = ['manager', 'field_user'].includes(req.body.role) ? req.body.role : 'employee';
  const active = req.body.active === '0' ? 0 : 1;
  return { name, pin, role, active };
}

// ===========================================================================
// SITES
// ===========================================================================
router.get('/sites', (req, res) => {
  const q = (req.query.q || '').trim();

  const where = [];
  const params = [];
  if (q) {
    where.push("(name LIKE ? OR coalesce(address,'') LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like);
  }

  const sql = 'SELECT * FROM sites'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY name';
  const sites = db.prepare(sql).all(...params);
  res.render('manager/sites', { sites, q });
});

router.get('/sites/new', checkPermission('manager'), (req, res) => {
  res.render('manager/site-form', { site: null, error: null });
});

// What's currently at a site: tools signed out to it + materials located there.
router.get('/sites/:id/contents', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!site) return res.redirect('/manager/sites');
  const tools = db.prepare(`
    SELECT t.*, c.time_out FROM checkouts c
    JOIN tools t ON t.id = c.tool_id
    WHERE c.time_in IS NULL AND c.site_id = ?
    ORDER BY t.name
  `).all(site.id);
  const materials = db.prepare(
    "SELECT * FROM materials WHERE lower(trim(location)) = lower(trim(?)) ORDER BY type, name"
  ).all(site.name);
  res.render('manager/site-contents', { site, tools, materials });
});

// Compact mini-report fragment for the expandable row on the sites list.
router.get('/sites/:id/report-fragment', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!site) return res.status(404).send('');
  const toolsOut = db.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE site_id = ? AND time_in IS NULL').get(site.id).n;
  const materials = db.prepare(
    "SELECT COUNT(*) AS n FROM materials WHERE lower(trim(location)) = lower(trim(?))"
  ).get(site.name);
  const materialsList = db.prepare(
    "SELECT * FROM materials WHERE lower(trim(location)) = lower(trim(?)) ORDER BY type, name"
  ).all(site.name);
  const recent = db.prepare(`
    SELECT t.name AS tool_name, e.name AS employee_name, c.time_out, c.time_in
    FROM checkouts c
    JOIN tools t ON t.id = c.tool_id
    JOIN employees e ON e.id = c.employee_id
    WHERE c.site_id = ?
    ORDER BY c.time_out DESC LIMIT 8
  `).all(site.id);
  const categoryRows = db.prepare(`
    SELECT t.category AS category, COUNT(*) AS n
    FROM checkouts c
    JOIN tools t ON t.id = c.tool_id
    WHERE c.site_id = ? AND c.time_in IS NULL
    GROUP BY t.category
  `).all(site.id);
  const categoryCounts = {};
  categoryKeys().forEach((cat) => { categoryCounts[cat] = 0; });
  categoryRows.forEach((r) => { categoryCounts[r.category] = r.n; });
  const pieGradient = helpers.pieGradient(categoryCounts, categoryMaps().colors);
  const mapUrl = site.address
    ? 'https://maps.google.com/maps?q=' + encodeURIComponent(site.address) + '&z=15&output=embed'
    : null;
  res.render('manager/_site-report-fragment', {
    site, toolsOut, materials, materialsList, recent, categoryCounts, pieGradient, mapUrl,
  });
});

router.post('/sites', checkPermission('manager'), upload.single('photo'), uploadToCloud, (req, res) => {
  const data = readSiteForm(req);
  if (data.error) {
    return res.status(400).render('manager/site-form', { site: req.body, error: data.error });
  }
  db.prepare('INSERT INTO sites (name, address, active, photo) VALUES (?, ?, ?, ?)')
    .run(data.name, data.address, data.active, req.file ? req.file.filename : null);
  res.redirect('/manager/sites');
});

router.get('/sites/:id/edit', checkPermission('manager'), (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!site) return res.redirect('/manager/sites');
  res.render('manager/site-form', { site, error: null });
});

router.post('/sites/:id', checkPermission('manager'), upload.single('photo'), uploadToCloud, (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!site) return res.redirect('/manager/sites');
  const data = readSiteForm(req);
  if (data.error) {
    return res.status(400).render('manager/site-form', {
      site: { ...site, ...req.body }, error: data.error,
    });
  }
  db.prepare('UPDATE sites SET name = ?, address = ?, active = ?, photo = COALESCE(?, photo) WHERE id = ?')
    .run(data.name, data.address, data.active, req.file ? req.file.filename : null, site.id);
  res.redirect('/manager/sites');
});

router.post('/sites/:id/delete', checkPermission('manager'), (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE site_id = ?').get(id).n;
  if (used > 0) {
    return res.render('message', {
      title: 'Cannot delete',
      heading: 'Cannot delete this site',
      body: 'This site appears in checkout history. Edit it and switch it to "Inactive" instead so the history stays intact.',
      backUrl: '/manager/sites', backLabel: 'Back to sites',
    });
  }
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  res.redirect('/manager/sites');
});

function readSiteForm(req) {
  const name = (req.body.name || '').trim();
  if (!name) return { error: 'A site name is required.' };
  const address = (req.body.address || '').trim() || null;
  const active = req.body.active === '0' ? 0 : 1;
  return { name, address, active };
}

// --- Tool categories ---------------------------------------------------------

router.use('/categories', checkPermission('manager'));

router.get('/categories', (req, res) => {
  const categories = listCategories().map((c) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM tools WHERE category = ?').get(c.key).n;
    return { ...c, toolCount: n };
  });
  res.render('manager/categories', { categories });
});

router.get('/categories/new', (req, res) => {
  res.render('manager/category-form', { category: null, error: null });
});

router.post('/categories', (req, res) => {
  const data = readCategoryForm(req);
  if (data.error) {
    return res.status(400).render('manager/category-form', { category: req.body, error: data.error });
  }
  const exists = db.prepare('SELECT 1 FROM categories WHERE key = ?').get(data.key);
  if (exists) {
    return res.status(400).render('manager/category-form', {
      category: req.body, error: 'A category with that name already exists.',
    });
  }
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM categories').get().n;
  db.prepare('INSERT INTO categories (key, label, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(data.key, data.label, data.icon, data.color, next);
  res.redirect('/manager/categories');
});

router.get('/categories/:id/edit', (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
  if (!category) return res.redirect('/manager/categories');
  res.render('manager/category-form', { category, error: null });
});

router.post('/categories/:id', (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
  if (!category) return res.redirect('/manager/categories');
  const data = readCategoryForm(req);
  if (data.error) {
    return res.status(400).render('manager/category-form', {
      category: { ...category, ...req.body }, error: data.error,
    });
  }
  db.prepare('UPDATE categories SET label = ?, icon = ?, color = ? WHERE id = ?')
    .run(data.label, data.icon, data.color, category.id);
  res.redirect('/manager/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
  if (!category) return res.redirect('/manager/categories');
  const used = db.prepare('SELECT COUNT(*) AS n FROM tools WHERE category = ?').get(category.key).n;
  if (used > 0) {
    return res.render('message', {
      title: 'Cannot delete',
      heading: 'Cannot delete this category',
      body: `${used} tool(s) still use the "${category.label}" category. Move those tools to a different category first.`,
      backUrl: '/manager/categories', backLabel: 'Back to categories',
    });
  }
  if (listCategories().length <= 1) {
    return res.render('message', {
      title: 'Cannot delete',
      heading: 'Cannot delete this category',
      body: 'At least one tool category must remain.',
      backUrl: '/manager/categories', backLabel: 'Back to categories',
    });
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
  res.redirect('/manager/categories');
});

function readCategoryForm(req) {
  const label = (req.body.label || '').trim();
  if (!label) return { error: 'A category name is required.' };
  const key = categoryKey(label);
  if (!key) return { error: 'That name could not be turned into a valid category code.' };
  const icon = (req.body.icon || '').trim() || '🧰';
  const color = (req.body.color || '').trim() || '#a1a1aa';
  return { key, label, icon, color };
}

// ===========================================================================
// BEACONS — pair a sensed BLE tag to a tool
// ===========================================================================
router.get('/beacons', checkPermission('manager'), (req, res) => {
  const beacons = db.prepare(`
    SELECT
      bs.beacon_key, bs.last_rssi, bs.last_distance_m, bs.last_zone, bs.last_seen,
      b.uuid, b.major, b.minor, b.label AS beacon_label, b.tool_id,
      t.name AS tool_name, t.short_id AS tool_short_id,
      sc.scanner_key, sc.name AS scanner_name,
      s.id AS site_id, s.name AS site_name
    FROM beacon_state bs
    LEFT JOIN beacons  b  ON b.beacon_key = bs.beacon_key
    LEFT JOIN tools    t  ON t.id  = b.tool_id
    LEFT JOIN scanners sc ON sc.id = bs.last_scanner_id
    LEFT JOIN sites    s  ON s.id  = bs.last_site_id
    ORDER BY bs.last_seen DESC
  `).all();

  const locations = beacons.filter((b) => b.tool_id);

  const allScanners = db.prepare(`
    SELECT sc.id, sc.scanner_key, sc.name, sc.kind, sc.site_id, sc.last_seen, sc.active, s.name AS site_name
    FROM scanners sc
    LEFT JOIN sites s ON s.id = sc.site_id
    ORDER BY sc.last_seen DESC
  `).all();
  const scanners = allScanners.filter(s => s.active !== 0);
  const disabledScanners = allScanners.filter(s => s.active === 0);

  const tools = db.prepare('SELECT id, name, short_id FROM tools ORDER BY name').all();
  const sites = db.prepare('SELECT id, name FROM sites WHERE active = 1 ORDER BY name').all();

  res.render('manager/beacons', { beacons, locations, scanners, disabledScanners, tools, sites });
});

router.post('/beacons/:beaconKey/pair', checkPermission('manager'), (req, res) => {
  const beaconKey = req.params.beaconKey;
  const [uuid, majorStr, minorStr] = beaconKey.split('|');
  const major = majorStr ? Number(majorStr) : null;
  const minor = minorStr ? Number(minorStr) : null;
  const toolId = req.body.tool_id ? Number(req.body.tool_id) : null;
  const label = (req.body.label || '').trim() || null;

  db.prepare(`
    INSERT INTO beacons (beacon_key, uuid, major, minor, tool_id, label)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(beacon_key) DO UPDATE SET tool_id = excluded.tool_id, label = excluded.label
  `).run(beaconKey, uuid, major, minor, toolId, label);

  req.session.flash = { type: 'success', text: toolId ? '✓ Beacon paired' : '✓ Beacon unpaired' };
  res.redirect('/manager/beacons');
});

// --- Scanners: assign each gateway/scanner to a site -------------------------
router.post('/scanners/:id/site', checkPermission('manager'), (req, res) => {
  const id = Number(req.params.id);
  const siteId = req.body.site_id ? Number(req.body.site_id) : null;
  const name = (req.body.name || '').trim() || null;

  db.prepare('UPDATE scanners SET site_id = ?, name = ? WHERE id = ?').run(siteId, name, id);
  invalidateScannerCache(); // so the next sighting from this scanner uses the new site

  req.session.flash = { type: 'success', text: '✓ Gateway updated' };
  res.redirect('/manager/beacons');
});

router.post('/scanners/:id/disable', checkPermission('manager'), (req, res) => {
  db.prepare('UPDATE scanners SET active = 0 WHERE id = ?').run(Number(req.params.id));
  invalidateScannerCache();
  req.session.flash = { type: 'success', text: '✓ Gateway disabled' };
  res.redirect('/manager/beacons');
});

router.post('/scanners/:id/enable', checkPermission('manager'), (req, res) => {
  db.prepare('UPDATE scanners SET active = 1 WHERE id = ?').run(Number(req.params.id));
  invalidateScannerCache();
  req.session.flash = { type: 'success', text: '✓ Gateway enabled' };
  res.redirect('/manager/beacons');
});

module.exports = router;
