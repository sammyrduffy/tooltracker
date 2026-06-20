# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```
npm start          # start on port 3000 (or $PORT)
npm run ble:mock   # run BLE beacon simulator (in a separate terminal)
npm run backup     # manual database backup
```

No build step. No lint. No tests. Restart the server to pick up any code change.

First-run default manager login: **name "Manager", PIN 1234**.

**Scratch instance for safe testing** (never test against the live DB):
```
cp tooltracker.db scratch.db
PORT=3999 TOOLTRACKER_DB="$(pwd)/scratch.db" node server.js
```
Kill the process and delete `scratch.db` when done.

## Deployment

Hosted on **Render** (auto-deploys on every push to `main`). Database is **Turso**. On Render, `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` env vars select the libsql driver, connecting **directly to Turso over the network for every query** — no local replica, no `.sync()`. Without those env vars the app uses `node:sqlite` against `tooltracker.db` locally.

(Earlier versions used libsql's "embedded replica" mode — a local copy that re-syncs from Turso on every boot. On a host with no persistent disk, that meant a *full* database re-download on every restart and every deploy, which burned through Turso's free-tier "Syncs" quota in days and locked the account. Direct remote queries bill against rows-read/rows-written instead, a much larger quota for an app this size — at the cost of each query being a network round-trip instead of a local disk read.)

Photos go to **Cloudinary** when `CLOUDINARY_URL` is set; otherwise saved to `public/uploads/`.

## Architecture

### Request flow

```
server.js  →  routes/public.js    (employee-facing: /t/:shortId, sign-out, check-in)
           →  routes/manager.js   (manager login + all CRUD: tools, people, sites, categories)
           →  routes/qr.js        (QR PNG generation)
           →  routes/api.js       (beacon ingestion + state reads)
```

`server.js` injects `res.locals.h` (all of `lib/helpers.js` plus `CATEGORY_LABELS/ICONS/COLORS` from the DB) into every template. Every template can call `h.formatDateTime()`, `h.STATUS_LABELS`, etc.

### Database (`db.js`)

Single file: all schema creation, migrations, and seeds run on every boot — idempotent.

**Historical note:** all `ALTER TABLE` migrations use `db.prepare(...).run()` rather than `db.exec()`. This dates from when the app used libsql's embedded-replica mode, where `db.exec()` only ran against the local copy and never reached Turso. Now that the cloud path connects directly to Turso (no replica), this distinction no longer matters — but the pattern is harmless and kept for consistency. New migrations can use either.

**Schema summary:**
- `tools` — `short_id` (QR URL key), `status` (available/signed_out/needs_repair/in_repair/missing), `quantity` (>1 = bulk), `billable_rate`
- `employees` — `pin_hash` (SHA-256 + random salt, format `salt:hash`), `role` (employee/manager), `active`
- `checkouts` — open while `time_in IS NULL`; `quantity` records units for bulk tools
- `categories` — manager-editable; `key` stored on `tools.category`; UNIQUE constraint exists locally but not in Turso (see `fixCategoryKeys` migration)
- `tool_issues` — field crew reports; resolved when manager marks tool in_repair or available
- `sites` — `is_home` marks the office; beacon sightings there auto-check tools back in
- BLE tables in `lib/ble/schema.js`: `scanners`, `beacons`, `beacon_state`, `beacon_site_sessions`

### Authentication

PIN verification: `db.verifyPin(employee, pin)` — SHA-256 with per-user salt stored as `salt:hash`. Manager pages use `checkPermission('manager')` or `checkPermission('manager', 'field_user')` middleware in `routes/manager.js`.

### Sign-out / check-in flow (mobile UX)

The field-facing tool page (`views/tool.ejs` + `public/app.js`) is a multi-step full-screen flow: pick name → PIN → (sign-out only) pick site → (bulk only) pick qty → confirm → POST. Steps are driven by `data-step` attributes; `app.js` shows/hides sections without page reloads. Bulk tools (`quantity > 1`) allow multiple simultaneous open checkouts (one per employee).

### BLE beacon subsystem (`lib/ble/`)

All sightings funnel through `ingestSighting()` → in-memory queue → batched flush (~1/sec). Writes are throttled to 1 per 5 min per beacon to stay within Turso free-tier limits. Auto-checkout fires when a beacon is seen at a gateway with a known site; auto-check-in fires when seen at the home site. Bulk tools are excluded from auto-checkout.

### Categories

Categories are stored in the DB (manager-editable). `lib/categories.js` reads them fresh each request. The `fixCategoryKeys()` migration in `db.js` runs on every boot to deduplicate rows — necessary because the UNIQUE constraint was never pushed to Turso.

### Labels / QR printing (`lib/labels.js`, `views/manager/labels.ejs`)

Sheet specs define `cols`, `rows`, `labelW/H` (inches), margins, gaps, `qrSize`, and font sizes. Print CSS injects these as EJS variables — always print at **100% / Actual size**. Labels show a category abbreviation + sequential number (e.g. PNEU 001) and a black name bar.

## Key conventions

- **Status values** live as plain strings in the DB; `h.STATUS_LABELS` maps them to display text; CSS class `badge--<status>` handles color.
- **New manager pages** surface as dashboard cards (see `views/manager/dashboard.ejs`), not new nav tabs — the mobile tab bar is full.
- **Flash messages** are stored in `req.session.flash` and displayed once by the head partial.
- **`short_id`** on tools is a 6-char alphanumeric generated by `generateUniqueShortId()` in `db.js`; used in QR URLs (`/t/<short_id>`).
- All dates stored as UTC text in SQLite format (`datetime('now')`); `h.formatDateTime()` converts to local time in templates.
