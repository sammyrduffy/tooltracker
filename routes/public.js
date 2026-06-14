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
const getActiveEmployees = db.prepare(
  'SELECT id, name, pin_hash FROM employees WHERE active = 1 ORDER BY name'
);
const getActiveSites = db.prepare(
  'SELECT id, name FROM sites WHERE active = 1 ORDER BY name'
);

// Loads the tool + its current holder (if any) and the picker lists.
function loadToolContext(shortId) {
  const tool = getToolByShortId.get(shortId);
  if (!tool) return null;
  const openCheckout = tool.status === 'signed_out' ? getOpenCheckout.get(tool.id) : null;
  return {
    tool,
    openCheckout,
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

  if (tool.status !== 'available') {
    return showToolError(res, shortId,
      `This tool can't be signed out right now (status: ${tool.status.replace('_', ' ')}).`);
  }

  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1')
    .get(Number(req.body.employee_id));
  if (!employee) return showToolError(res, shortId, 'Please choose your name and try again.');
  if (!verifyPin(req.body.pin, employee.pin_hash)) {
    return showToolError(res, shortId, 'That PIN was not correct. Please try again.');
  }

  const site = db.prepare('SELECT * FROM sites WHERE id = ? AND active = 1')
    .get(Number(req.body.site_id));
  if (!site) return showToolError(res, shortId, 'Please choose a job site and try again.');

  // Record the checkout and flip the tool's status — done as one atomic step.
  transaction(() => {
    db.prepare(
      'INSERT INTO checkouts (tool_id, employee_id, site_id) VALUES (?, ?, ?)'
    ).run(tool.id, employee.id, site.id);
    db.prepare("UPDATE tools SET status = 'signed_out' WHERE id = ?").run(tool.id);
  });

  req.session.flash = { type: 'success', text: `✓ Signed out — ${tool.name} to ${employee.name}` };
  res.redirect(`/t/${shortId}`);
});

// --- Handle "Check in" ------------------------------------------------------
router.post('/t/:shortId/checkin', (req, res) => {
  const shortId = req.params.shortId;
  const tool = getToolByShortId.get(shortId);
  if (!tool) return showToolError(res, shortId, 'That tool no longer exists.');

  if (tool.status !== 'signed_out') {
    return showToolError(res, shortId, 'This tool is not currently signed out.');
  }

  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1')
    .get(Number(req.body.employee_id));
  if (!employee) return showToolError(res, shortId, 'Please choose your name and try again.');
  if (!verifyPin(req.body.pin, employee.pin_hash)) {
    return showToolError(res, shortId, 'That PIN was not correct. Please try again.');
  }

  const open = getOpenCheckout.get(tool.id);
  transaction(() => {
    if (open) {
      db.prepare("UPDATE checkouts SET time_in = datetime('now') WHERE id = ?").run(open.id);
    }
    db.prepare("UPDATE tools SET status = 'available' WHERE id = ?").run(tool.id);
  });

  req.session.flash = { type: 'success', text: `✓ Checked in — ${tool.name} is back at the ${homeLocation()}` };
  res.redirect(`/t/${shortId}`);
});

module.exports = router;
