// ---------------------------------------------------------------------------
// routes/public.js  —  Pages employees use from their phones.
//
//   GET  /                      A simple list of all tools (and a manager link)
//   GET  /t/:shortId            A single tool's page (scanned from its QR code)
//   POST /t/:shortId/signout    Handle the "Sign out" action
//   POST /t/:shortId/checkin    Handle the "Check in" action
// ---------------------------------------------------------------------------

const express = require('express');
const QRCode = require('qrcode');
const router = express.Router();
const { db, hashPin, verifyPin, transaction, getSetting } = require('../db');
const { resolveBaseUrl } = require('../lib/baseurl');
const { upload, uploadToCloud } = require('../lib/photos');

// Where tools live when they're not signed out. Defaults to "Office" but can be
// changed by saving a 'home_location' setting.
function homeLocation() {
  return getSetting('home_location') || 'Office';
}

// Prepared statements (compiled once, reused — fast and safe against injection).
const getToolByShortId = db.prepare('SELECT * FROM tools WHERE short_id = ?');
const getOpenCheckout = db.prepare(`
  SELECT c.*, e.name AS employee_name, s.name AS site_name
  FROM checkouts c
  JOIN employees e ON e.id = c.employee_id
  LEFT JOIN sites s ON s.id = c.site_id
  WHERE c.tool_id = ? AND c.time_in IS NULL
  ORDER BY c.id DESC LIMIT 1
`);
// Returns ALL open checkouts for a tool (used for bulk tools with multiple holders).
const getOpenCheckouts = db.prepare(`
  SELECT c.*, e.name AS employee_name, s.name AS site_name
  FROM checkouts c
  JOIN employees e ON e.id = c.employee_id
  LEFT JOIN sites s ON s.id = c.site_id
  WHERE c.tool_id = ? AND c.time_in IS NULL
  ORDER BY c.time_out DESC
`);
// Total units currently checked out for a bulk tool.
const getCheckedOutQty = db.prepare(
  "SELECT COALESCE(SUM(quantity),0) AS n FROM checkouts WHERE tool_id = ? AND time_in IS NULL"
);
// Finds a specific employee's open checkout for a bulk tool (used on check-in).
const getEmployeeCheckout = db.prepare(
  'SELECT * FROM checkouts WHERE tool_id = ? AND employee_id = ? AND time_in IS NULL ORDER BY id DESC LIMIT 1'
);
const getActiveEmployees = db.prepare(
  'SELECT id, name, pin_hash FROM employees WHERE active = 1 ORDER BY name'
);
const getActiveSites = db.prepare(
  'SELECT id, name FROM sites WHERE active = 1 ORDER BY name'
);
const getOpenIssueByTool = db.prepare(`
  SELECT i.note, i.created_at, e.name AS reporter_name
  FROM tool_issues i
  LEFT JOIN employees e ON e.id = i.reported_by
  WHERE i.tool_id = ? AND i.status = 'open'
  ORDER BY i.id DESC LIMIT 1
`);

// Loads the tool + its current holder(s) and the picker lists.
function loadToolContext(shortId) {
  const tool = getToolByShortId.get(shortId);
  if (!tool) return null;

  let checkedOut = 0;
  let openCheckouts = [];

  if (tool.quantity > 1) {
    // Bulk tool: compute how many units are currently out and who has them.
    checkedOut = getCheckedOutQty.get(tool.id).n;
    tool.available_qty = tool.quantity - checkedOut;
    if (checkedOut > 0) openCheckouts = getOpenCheckouts.all(tool.id);
  }

  // Single-item: existing behaviour. Bulk: first holder (or null) for backward-compat.
  const openCheckout = tool.quantity === 1 && tool.status === 'signed_out'
    ? getOpenCheckout.get(tool.id)
    : (openCheckouts[0] || null);

  return {
    tool,
    openCheckout,
    openCheckouts,
    checkedOut,
    openIssue: tool.status === 'needs_repair' ? (getOpenIssueByTool.get(tool.id) || null) : null,
    homeLocation: homeLocation(),
    employees: getActiveEmployees.all().map((e) => ({ id: e.id, name: e.name })),
    sites: getActiveSites.all(),
  };
}

// --- A simple all-tools list (handy if a QR sticker is missing) -------------
router.get('/', (req, res) => {
  const tools = db.prepare('SELECT * FROM tools ORDER BY name').all();
  res.render('home', { tools });
});

// --- In-app QR scanner (opens the phone camera, finds a tool) ---------------
router.get('/scan', (req, res) => {
  res.render('scan');
});

// --- Welcome / invite page: install steps + self sign-up as a field user ----
router.get('/welcome', (req, res) => {
  res.render('welcome', { error: null, done: null, url: resolveBaseUrl(req) });
});

// QR code that points back at this welcome page, for sharing/printing.
router.get('/welcome/qr.png', (req, res) => {
  const url = `${resolveBaseUrl(req)}/welcome`;
  res.type('png');
  QRCode.toFileStream(res, url, { margin: 1, width: 400, errorCorrectionLevel: 'M' }, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

// --- Self sign-up: creates a new "field user" account ------------------------
router.post('/welcome', (req, res) => {
  const name = (req.body.name || '').trim();
  const pin = (req.body.pin || '').trim();
  const fail = (message) => res.status(400).render('welcome', { error: message, done: null, url: resolveBaseUrl(req) });

  if (!name) return fail('Please enter your name.');
  if (!/^\d{4}$/.test(pin)) return fail('Your PIN must be exactly 4 digits.');

  const existing = db.prepare('SELECT id FROM employees WHERE lower(name) = lower(?) AND active = 1').get(name);
  if (existing) return fail(`Someone named "${name}" already has an account. Pick a different name (e.g. add your last initial), or ask a manager for help.`);

  db.prepare("INSERT INTO employees (name, pin_hash, role, active) VALUES (?, ?, 'field_user', 1)")
    .run(name, hashPin(pin));

  res.render('welcome', { error: null, done: name, url: resolveBaseUrl(req) });
});

// --- A single tool's page ---------------------------------------------------
router.get('/t/:shortId', (req, res) => {
  const ctx = loadToolContext(req.params.shortId);
  if (!ctx) {
    return res.status(404).render('message', {
      title: 'Tool not found',
      heading: 'Tool not found',
      body: `No tool matches the code "${req.params.shortId}". The sticker may be damaged or the tool was deleted.`,
      backUrl: '/', backLabel: 'See all tools',
    });
  }
  res.render('tool', { ...ctx, error: null });
});

// Helper: re-show the tool page with an error message (e.g. wrong PIN).
function showToolError(res, shortId, message) {
  const ctx = loadToolContext(shortId);
  if (!ctx) {
    return res.status(404).render('message', {
      title: 'Tool not found', heading: 'Tool not found',
      body: 'That tool no longer exists.', backUrl: '/', backLabel: 'See all tools',
    });
  }
  res.status(400).render('tool', { ...ctx, error: message });
}

// --- Handle "Sign out" ------------------------------------------------------
router.post('/t/:shortId/signout', (req, res) => {
  const shortId = req.params.shortId;
  const tool = getToolByShortId.get(shortId);
  if (!tool) return showToolError(res, shortId, 'That tool no longer exists.');

  // For bulk tools check available units; for single items check status.
  let availableQty = 1;
  if (tool.quantity > 1) {
    const checkedOut = getCheckedOutQty.get(tool.id).n;
    availableQty = tool.quantity - checkedOut;
    if (availableQty <= 0) {
      return showToolError(res, shortId, 'All units of this tool are currently signed out.');
    }
  } else if (tool.status !== 'available') {
    return showToolError(res, shortId,
      `This tool can't be signed out right now (status: ${tool.status.replace('_', ' ')}).`);
  }

  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1')
    .get(Number(req.body.employee_id));
  if (!employee) return showToolError(res, shortId, 'Please choose your name and try again.');
  if (!verifyPin(req.body.pin, employee.pin_hash)) {
    return showToolError(res, shortId, 'That PIN was not correct. Please try again.');
  }

  // The job site is optional — a tool can be signed out to a person who keeps
  // it with no specific site. If one is given, it must be a real active site.
  let siteId = null;
  if ((req.body.site_id || '').trim() !== '') {
    const site = db.prepare('SELECT * FROM sites WHERE id = ? AND active = 1')
      .get(Number(req.body.site_id));
    if (!site) return showToolError(res, shortId, 'Please choose a job site and try again.');
    siteId = site.id;
  }

  // For bulk tools, read the requested quantity and clamp to what's available.
  const qty = tool.quantity > 1
    ? Math.max(1, Math.min(parseInt(req.body.quantity, 10) || 1, availableQty))
    : 1;

  // Record the checkout and update the tool's status — done as one atomic step.
  transaction(() => {
    db.prepare(
      'INSERT INTO checkouts (tool_id, employee_id, site_id, quantity) VALUES (?, ?, ?, ?)'
    ).run(tool.id, employee.id, siteId, qty);

    if (tool.quantity > 1) {
      // All units out → signed_out; still some free → keep available.
      const newAvail = availableQty - qty;
      db.prepare('UPDATE tools SET status = ? WHERE id = ?')
        .run(newAvail <= 0 ? 'signed_out' : 'available', tool.id);
    } else {
      db.prepare("UPDATE tools SET status = 'signed_out' WHERE id = ?").run(tool.id);
    }
  });

  const qtyLabel = qty > 1 ? ` ×${qty}` : '';
  req.session.flash = { type: 'success', text: `✓ Signed out — ${tool.name}${qtyLabel} to ${employee.name}` };
  res.redirect(`/t/${shortId}`);
});

// --- Handle "Check in" ------------------------------------------------------
router.post('/t/:shortId/checkin', (req, res) => {
  const shortId = req.params.shortId;
  const tool = getToolByShortId.get(shortId);
  if (!tool) return showToolError(res, shortId, 'That tool no longer exists.');

  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1')
    .get(Number(req.body.employee_id));
  if (!employee) return showToolError(res, shortId, 'Please choose your name and try again.');
  if (!verifyPin(req.body.pin, employee.pin_hash)) {
    return showToolError(res, shortId, 'That PIN was not correct. Please try again.');
  }

  if (tool.quantity > 1) {
    // Bulk tool: find this employee's specific open checkout.
    const empCheckout = getEmployeeCheckout.get(tool.id, employee.id);
    if (!empCheckout) {
      return showToolError(res, shortId, `${employee.name} doesn't have any ${tool.name} checked out.`);
    }
    transaction(() => {
      db.prepare("UPDATE checkouts SET time_in = datetime('now') WHERE id = ?").run(empCheckout.id);
      // Recalculate status: if any units still out, keep signed_out.
      const stillOut = getCheckedOutQty.get(tool.id).n;
      db.prepare('UPDATE tools SET status = ? WHERE id = ?')
        .run(stillOut > 0 ? 'signed_out' : 'available', tool.id);
    });
    const qty = empCheckout.quantity;
    const label = qty > 1 ? `${qty} ${tool.name}s` : tool.name;
    req.session.flash = { type: 'success', text: `✓ Checked in — ${label} returned` };
  } else {
    // Single item: existing behaviour.
    if (tool.status !== 'signed_out') {
      return showToolError(res, shortId, 'This tool is not currently signed out.');
    }
    const open = getOpenCheckout.get(tool.id);
    transaction(() => {
      if (open) {
        db.prepare("UPDATE checkouts SET time_in = datetime('now') WHERE id = ?").run(open.id);
      }
      db.prepare("UPDATE tools SET status = 'available' WHERE id = ?").run(tool.id);
    });
    req.session.flash = { type: 'success', text: `✓ Checked in — ${tool.name} is back at the ${homeLocation()}` };
  }

  res.redirect(`/t/${shortId}`);
});

// --- Handle "Report an issue" (field crew flags a tool as needing repair) ----
router.post('/t/:shortId/report-issue', upload.single('photo'), uploadToCloud, (req, res) => {
  const shortId = req.params.shortId;
  const tool = getToolByShortId.get(shortId);
  if (!tool) return showToolError(res, shortId, 'That tool no longer exists.');

  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1')
    .get(Number(req.body.employee_id));
  if (!employee) return showToolError(res, shortId, 'Please choose your name and try again.');
  if (!verifyPin(req.body.pin, employee.pin_hash)) {
    return showToolError(res, shortId, 'That PIN was not correct. Please try again.');
  }

  const note = (req.body.note || '').trim() || null;

  // Flag the tool as needing repair, close any open checkout (it's coming off
  // the job), and log the issue so a manager sees who reported what.
  transaction(() => {
    db.prepare("UPDATE checkouts SET time_in = datetime('now') WHERE tool_id = ? AND time_in IS NULL").run(tool.id);
    db.prepare("UPDATE tools SET status = 'needs_repair' WHERE id = ?").run(tool.id);
    db.prepare(
      'INSERT INTO tool_issues (tool_id, reported_by, note, photo) VALUES (?, ?, ?, ?)'
    ).run(tool.id, employee.id, note, req.file ? req.file.filename : null);
  });

  req.session.flash = { type: 'success', text: `✓ Reported — ${tool.name} flagged for repair. Thanks, ${employee.name}.` };
  res.redirect(`/t/${shortId}`);
});

module.exports = router;
