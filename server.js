// ---------------------------------------------------------------------------
// server.js  —  Main entry point for the Tool Tracker web app.
//
// Start it with:  npm start
// Then open the address it prints in your browser.
// ---------------------------------------------------------------------------

const express = require('express');
const session = require('express-session');
const path = require('path');
const os = require('os');
const fs = require('fs');

const crypto = require('crypto');
const { db, bootstrapDefaultManager, getSetting, setSetting } = require('./db');
const helpers = require('./lib/helpers');
const { categoryMaps } = require('./lib/categories');

const app = express();
const PORT = process.env.PORT || 3000;

// When running behind a tunnel/proxy (e.g. Cloudflare) that terminates HTTPS,
// trust its forwarded headers so secure cookies and req.protocol work.
app.set('trust proxy', 1);

// A stable, random secret for signing login cookies. Generated once and stored
// in the database so logins survive restarts without anyone managing env vars.
function sessionSecret() {
  let s = getSetting('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', s); }
  return s;
}

// --- Make sure the folder for uploaded tool photos exists -------------------
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- View engine (server-rendered HTML pages using EJS templates) -----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Built-in middleware ----------------------------------------------------
app.use(express.urlencoded({ extended: true })); // read submitted form fields
app.use(express.static(path.join(__dirname, 'public'))); // serve CSS, JS, photos

// --- Login sessions for managers (a small signed cookie) --------------------
app.use(session({
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8,  // managers stay logged in for 8 hours
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',              // secure cookie automatically when served over HTTPS
  },
}));

// --- Make helpers + current manager available inside every page -------------
app.use((req, res, next) => {
  const cat = categoryMaps();
  res.locals.h = Object.assign({}, helpers, {
    CATEGORY_LABELS: cat.labels, CATEGORY_ICONS: cat.icons, CATEGORY_COLORS: cat.colors,
  });                               // formatting helpers usable in templates
  res.locals.manager = req.session.manager || null; // who (if anyone) is logged in
  res.locals.photoSrc = require('./lib/photos').photoSrc; // local filename OR Cloudinary URL → <img src>
  res.locals.currentPath = req.path;
  // One-time "flash" message, shown as a toast on the next page then cleared.
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  next();
});

// --- Routes -----------------------------------------------------------------
app.use('/', require('./routes/public'));            // employee-facing tool pages
app.use('/qr', require('./routes/qr'));              // QR-code images for tools
app.use('/manager', require('./routes/manager'));    // manager login + management
app.use('/api', require('./routes/api'));            // JSON beacon ingestion + reads

// --- Friendly 404 -----------------------------------------------------------
app.use((req, res) => {
  res.status(404).render('message', {
    title: 'Page not found',
    heading: 'Hmm, nothing here',
    body: 'That page or tool code does not exist.',
    backUrl: '/',
    backLabel: 'Go to tools list',
  });
});

// --- Start-up: ensure there is a manager login, then listen -----------------
bootstrapDefaultManager();
require('./lib/ble').initBle();   // beacon tables + ingest queue (+ optional scanner)

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Tool Tracker is running!');
  console.log(`  On THIS computer:   http://localhost:${PORT}`);
  // Also show the address phones on the same Wi-Fi can use.
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  On the same Wi-Fi:  http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('\n  Press Ctrl+C in this window to stop the app.\n');
});
