# Beacon tracking subsystem

This folder lets Tool Tracker know **which tools are physically at which site**,
using small BLE beacon tags (you're testing with Feasycom FSC-BP103B; the goal
is the long-range Blue Charm BC04P). Nobody has to scan a QR code — the beacons
shout, scanners listen, and the app records where each tool was last heard.

## How it fits together

```
sources  →  ingestSighting()  →  in-memory queue  →  batched flush  →  SQLite
(mock /      (one front door)    (non-blocking)      (1×/sec, +        (4 tables)
 radio /                                              proximity engine)
 gateway)
```

Everything funnels through **one** function (`ingestSighting`), so the source of
the data — a simulator, a USB radio, or fixed gateways — can change without
touching how data is processed or stored.

| File | Job |
|------|-----|
| `proximity.js` | Pure maths: signal strength → distance → zone. No DB. |
| `schema.js` | Creates the four tables (safe to run every boot). |
| `normalize.js` | Accepts any gateway's JSON shape → one tidy "sighting". |
| `ingest.js` | The non-blocking queue + batched writer. The heart. |
| `sources/mock.js` | Fake beacons for testing without hardware. |
| `sources/noble.js` | Scan a real radio on this machine (optional library). |
| `index.js` | `initBle()` — wires it all up at start-up. |

## The tables

- **scanners** — the listeners. A *fixed* scanner is tied to a site, which is how
  a sighting becomes "this tool is at that site". New gateways auto-register on
  first contact so you can name them and assign a site afterwards.
- **beacons** — pairs a physical tag (`uuid|major|minor`) to one of your tools.
- **beacon_events** — the full raw history (high volume).
- **beacon_state** — one row per beacon: its latest sighting. Fast to read.

## Choosing a source (`BLE_SOURCE` env var)

| Value | Behaviour |
|-------|-----------|
| `none` *(default)* | Accept gateway POSTs only — no local scanning. |
| `mock` | Run the built-in simulator inside the server process. |
| `noble` | Scan a real BLE radio on this machine (needs the library below). |

The HTTP route is **always** on regardless of this setting — that's how fixed
gateways feed in.

## HTTP endpoints

- `POST /api/beacon-data` — gateways post sightings here. Returns `202` instantly.
  Accepts a single object, an array, or a `{ scanner, beacons: [...] }` batch.
- `GET /api/beacon-data/state` — latest position of every tracked tool (JSON).
- `GET /api/health` — `{ ok, queueDepth, dropped }`.

## Testing now, with no hardware

1. Start the app: `npm start`
2. In another terminal: `npm run ble:mock`

The mock script posts realistic batches every second. Watch new scanners appear,
then `GET /api/beacon-data/state` to see live readings. Pair a beacon to a tool by
inserting a row in `beacons` with a `tool_id` to see the tool name light up.

## When the hardware arrives (phase by phase)

1. **One tag, this computer.** `npm install @abandonware/noble`, then start with
   `BLE_SOURCE=noble`. Confirm real packets parse and land in `beacon_events`.
2. **Pair tags to tools.** Add `beacons` rows linking each `uuid|major|minor` to
   a `tool_id`. (A small manager screen for this is the natural next feature.)
3. **Fixed gateways.** Point each Blue Charm gateway at `POST /api/beacon-data`
   and set each gateway's `scanners.site_id`. You can now stop running `noble` —
   the gateway path replaces it, and nothing else changes.

## Tuning

- Distance/zone thresholds and the default TX power live at the top of
  `proximity.js`. Expect to calibrate these per site once real walls and steel
  are in the mix.
- Flush interval, batch size, and the memory safety cap live at the top of
  `ingest.js`.
