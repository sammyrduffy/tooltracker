# Tool Tracker

A simple mobile-first web app for tracking company tools (drills, saws, ladders, etc.)
as employees sign them out to job sites and check them back in. Each tool has a QR-code
sticker that opens its page in a phone browser.

## Tech stack (deliberately simple)

- **Node.js + Express** — server-rendered web app
- **EJS** — HTML templates
- **node:sqlite** — Node's built-in SQLite. The whole database is one file,
  `tooltracker.db`. No separate database service, no Docker, no native compiler needed.
- **express-session** — manager login
- **multer** — tool photo uploads (saved in `public/uploads/`)

## Running it locally

```
npm install      # one time, installs dependencies
npm start        # starts the app
```

Then open the address it prints (e.g. http://localhost:3000). Phones on the same
Wi-Fi can use the `http://192.168.x.x:3000` address it also prints.

To stop the app, press `Ctrl+C` in the window where it's running.

## Putting it online (for crew phones anywhere)

Double-click **`start-online.cmd`**. It starts the app and opens a free, secure
Cloudflare tunnel, then prints a public `https://…trycloudflare.com` address and
points the app's QR codes at it. Keep that window open while you need online access.

Note: the quick-tunnel address **changes each time it restarts**, so it's great for
testing but not for printing permanent QR stickers. For a stable address, set up a
named Cloudflare tunnel on your own domain (e.g. `tools.yourcompany.com`).

## Bulk-importing materials

Managers can load many materials at once: **Materials → Import CSV**. The file needs
a header row (`name,type,quantity,unit,location,notes`); only `name` is required.
A material with the same name at the same location adds to the existing quantity.
A template is available on that page.

## How logins work

There is no complex login system by design. Each person has a **name + 4-digit PIN**.
Managers have `role = manager` and use their PIN to reach the management screens.

On first run, if the database is empty, the app creates a starter manager:
**name "Manager", PIN 1234**. Change or delete it after creating your own manager.

## Project layout

```
server.js            App entry point + server setup
db.js                Database schema, PIN hashing, helpers
routes/public.js     Employee-facing tool pages + sign-out / check-in
routes/manager.js    Manager login + add/edit/delete tools, people, sites
lib/helpers.js       Small formatting helpers used in templates
views/               EJS page templates (views/partials are shared pieces)
public/              CSS, browser JavaScript, and uploaded photos
tooltracker.db       The SQLite database file (created on first run)
```

## Data model

- **tools** — name, description, serial number, category, purchase value, condition
  notes, photo, status (available / signed_out / in_repair / missing), and a unique
  `short_id` used in the QR-code URL (`/t/<short_id>`).
- **employees** — name, hashed PIN, role (employee / manager), active flag.
- **sites** — name, address, active flag.
- **checkouts** — which tool, which employee, which site, time out, time in
  (null while still out), notes.

## Backups

To back up everything, copy `tooltracker.db` (and the `public/uploads` folder for
photos). To start completely fresh, stop the app and delete `tooltracker.db`.

## Build phases

- **Phase 1 (done):** core records + sign-out / check-in flow.
- Phase 2: QR-code generation + printable label sheets.
- Phase 3: manager dashboard + history + stats.
- Phase 4: search/filter, repair/missing controls, CSV export, sample data.
