// ---------------------------------------------------------------------------
// seed.js  —  Loads a clean set of SAMPLE data for testing/demoing.
//
//   node seed.js          (or:  npm run seed)
//
// WARNING: this WIPES all existing tools, people, sites, materials, and
// checkout history, then inserts the sample set below. Your saved QR web
// address (settings) is kept. Run this only when you want a fresh demo.
// ---------------------------------------------------------------------------

const { db, hashPin, generateUniqueShortId } = require('./db');

console.log('Clearing existing data…');
db.exec(`
  DELETE FROM checkouts;
  DELETE FROM materials;
  DELETE FROM tools;
  DELETE FROM employees;
  DELETE FROM sites;
  DELETE FROM sqlite_sequence;
`);

// --- People (2 managers + 3 employees) -------------------------------------
const people = [
  ['Dana Whitlock', '1234', 'manager'],
  ['Lena Park',     '4444', 'manager'],
  ['Marcus Reyes',  '1111', 'employee'],
  ['Priya Shah',    '2222', 'employee'],
  ['Tom Becker',    '3333', 'employee'],
];
const insPerson = db.prepare('INSERT INTO employees (name, pin_hash, role) VALUES (?, ?, ?)');
const empIds = {};
for (const [name, pin, role] of people) {
  const info = insPerson.run(name, hashPin(pin), role);
  empIds[name] = Number(info.lastInsertRowid);
}

// --- Sites -----------------------------------------------------------------
const sites = [
  ['Office', 'Main office / shop'],
  ['Riverside Renovation', '142 River Rd'],
  ['Oakwood New Build', '88 Oak Ave'],
  ['Downtown Office Fit-out', '5 King St W'],
];
const insSite = db.prepare('INSERT INTO sites (name, address) VALUES (?, ?)');
const siteIds = {};
for (const [name, addr] of sites) {
  siteIds[name] = Number(insSite.run(name, addr).lastInsertRowid);
}

// --- Tools (10) ------------------------------------------------------------
const tools = [
  ['DeWalt 20V Drill', 'drill', 199, 'Cordless, 2 batteries'],
  ['Makita Circular Saw', 'saw', 149, '7¼" blade'],
  ['Milwaukee Reciprocating Saw', 'saw', 179, 'Sawzall'],
  ['8 ft Fiberglass Step Ladder', 'ladder', 120, ''],
  ['24 ft Extension Ladder', 'ladder', 260, ''],
  ['Bosch Rotary Hammer', 'drill', 320, 'SDS-plus'],
  ['DeWalt Impact Driver', 'drill', 169, ''],
  ['Hilti Laser Level', 'other', 410, 'Self-leveling'],
  ['Ridgid Shop Vac', 'other', 99, '16 gallon'],
  ['Honda 3500W Generator', 'other', 899, 'Inverter'],
];
const insTool = db.prepare(`
  INSERT INTO tools (short_id, name, category, purchase_value, description, status)
  VALUES (?, ?, ?, ?, ?, 'available')
`);
const toolIds = {};
for (const [name, cat, val, desc] of tools) {
  const id = Number(insTool.run(generateUniqueShortId(), name, cat, val, desc || null).lastInsertRowid);
  toolIds[name] = id;
}

// --- Materials (a few across types and sites) ------------------------------
const materials = [
  ['2×4×8 Stud', 'Framing', 250, 'ea', 'Riverside Renovation'],
  ['½″ Drywall 4×8', 'Interior', 60, 'sheets', 'Oakwood New Build'],
  ['12-2 Romex', 'Electrical', 4, 'boxes', 'Shop / Warehouse'],
  ['3″ Deck Screws', 'Hardware & Fasteners', 12, 'boxes', 'Shop / Warehouse'],
  ['R-13 Insulation', 'Interior', 30, 'bags', 'Oakwood New Build'],
  ['Safety Glasses', 'Safety', 40, 'ea', 'Shop / Warehouse'],
];
const insMat = db.prepare('INSERT INTO materials (name, type, quantity, unit, location) VALUES (?, ?, ?, ?, ?)');
for (const m of materials) insMat.run(...m);

// --- Checkout history (so the dashboard & stats have content) --------------
// Closed (returned) checkouts in the past:
const closed = db.prepare(`
  INSERT INTO checkouts (tool_id, employee_id, site_id, time_out, time_in)
  VALUES (?, ?, ?, datetime('now', ?), datetime('now', ?))
`);
closed.run(toolIds['DeWalt 20V Drill'], empIds['Marcus Reyes'], siteIds['Riverside Renovation'], '-20 days', '-18 days');
closed.run(toolIds['DeWalt 20V Drill'], empIds['Priya Shah'], siteIds['Oakwood New Build'], '-12 days', '-11 days');
closed.run(toolIds['Makita Circular Saw'], empIds['Tom Becker'], siteIds['Riverside Renovation'], '-9 days', '-8 days');
closed.run(toolIds['DeWalt Impact Driver'], empIds['Marcus Reyes'], siteIds['Downtown Office Fit-out'], '-5 days', '-4 days');

// Currently out: one recent, one overdue (more than 7 days) to show the flag.
const openCk = db.prepare(`
  INSERT INTO checkouts (tool_id, employee_id, site_id, time_out)
  VALUES (?, ?, ?, datetime('now', ?))
`);
openCk.run(toolIds['Milwaukee Reciprocating Saw'], empIds['Tom Becker'], siteIds['Oakwood New Build'], '-2 days');
db.prepare("UPDATE tools SET status='signed_out' WHERE id=?").run(toolIds['Milwaukee Reciprocating Saw']);
openCk.run(toolIds['24 ft Extension Ladder'], empIds['Priya Shah'], siteIds['Riverside Renovation'], '-10 days');
db.prepare("UPDATE tools SET status='signed_out' WHERE id=?").run(toolIds['24 ft Extension Ladder']);

// One tool flagged for repair, to show that status.
db.prepare("UPDATE tools SET status='in_repair' WHERE id=?").run(toolIds['Ridgid Shop Vac']);

console.log('\nSample data loaded:');
console.log(`  ${people.length} people, ${sites.length} sites, ${tools.length} tools, ${materials.length} materials.`);
console.log('\nManager logins you can use:');
console.log('  Dana Whitlock — PIN 1234   (manager)');
console.log('  Lena Park     — PIN 4444   (manager)');
console.log('Employee PINs: Marcus 1111, Priya 2222, Tom 3333\n');
