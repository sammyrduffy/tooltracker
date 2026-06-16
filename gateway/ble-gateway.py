#!/usr/bin/env python3
"""
ble-gateway.py — Tool Tracker BLE beacon gateway for Raspberry Pi.

Scans for iBeacon advertisements, posts sightings to the cloud API.
Runs continuously; auto-retries on WiFi or API drops.

Configuration (edit the three lines in CONFIG below, or set env vars):
  SCANNER_KEY  — unique name for this Pi, e.g. "shop-01" or "site-oakwood"
  API_URL      — your Tool Tracker cloud address
  BEACON_UUID  — the iBeacon UUID on your Feasycom beacons (all caps)

Requirements:
  pip3 install bleak requests
"""

import asyncio
import logging
import os
import struct
import time

import requests
from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

# ---------------------------------------------------------------------------
# CONFIG — edit these or override with environment variables
# ---------------------------------------------------------------------------
SCANNER_KEY = os.environ.get("SCANNER_KEY", "shop-01")
API_URL     = os.environ.get("API_URL",     "https://tooltracker-hlrd.onrender.com/api/beacon-data")
BEACON_UUID = os.environ.get("BEACON_UUID", "FDA50693-A4E2-4FB1-AFCF-C6EB07647825")
# ---------------------------------------------------------------------------

POST_INTERVAL   = 5      # seconds between POST batches
RETRY_DELAY     = 10     # seconds to wait after a failed POST before retrying
MAX_RETRIES     = 5      # give up on a batch after this many failures
SCAN_RESTART    = 30     # seconds to wait before restarting a crashed scanner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# Thread-safe queue: detection callback fills it, sender drains it.
sightings: list[dict] = []

APPLE_MFR_ID = 0x004C
IBEACON_TYPE = 0x0215


def parse_ibeacon(mfr_data: bytes) -> dict | None:
    """Return {uuid, major, minor, tx_power} if this is an iBeacon frame."""
    # Apple manufacturer data: 2-byte subtype+length + 16-byte UUID + major + minor + tx_power
    if len(mfr_data) < 23:
        return None
    subtype, length = mfr_data[0], mfr_data[1]
    if (subtype << 8 | length) != IBEACON_TYPE:
        return None
    uuid_bytes = mfr_data[2:18]
    major, minor, tx_power = struct.unpack(">HHb", mfr_data[18:23])
    uuid = "-".join([
        uuid_bytes[0:4].hex(),
        uuid_bytes[4:6].hex(),
        uuid_bytes[6:8].hex(),
        uuid_bytes[8:10].hex(),
        uuid_bytes[10:16].hex(),
    ]).upper()
    return {"uuid": uuid, "major": major, "minor": minor, "tx_power": tx_power}


def on_detection(device: BLEDevice, adv: AdvertisementData):
    """Called by BleakScanner for every advertisement received."""
    mfr = adv.manufacturer_data.get(APPLE_MFR_ID)
    if not mfr:
        return
    beacon = parse_ibeacon(mfr)
    if not beacon:
        return
    if beacon["uuid"] != BEACON_UUID:
        return
    sightings.append({
        "scanner_key": SCANNER_KEY,
        "uuid":        beacon["uuid"],
        "major":       beacon["major"],
        "minor":       beacon["minor"],
        "rssi":        adv.rssi,
        "tx_power":    beacon["tx_power"],
    })


async def scan_loop():
    """Runs BleakScanner forever, restarting it if it crashes."""
    while True:
        try:
            log.info("BLE scanner starting (scanner_key=%s)", SCANNER_KEY)
            async with BleakScanner(detection_callback=on_detection):
                while True:
                    await asyncio.sleep(1)
        except Exception as exc:
            log.warning("BLE scanner error: %s — restarting in %ds", exc, SCAN_RESTART)
            await asyncio.sleep(SCAN_RESTART)


async def post_loop():
    """Drains the sightings queue and POSTs to the API every POST_INTERVAL seconds."""
    session = requests.Session()
    while True:
        await asyncio.sleep(POST_INTERVAL)
        if not sightings:
            continue
        batch = sightings.copy()
        sightings.clear()

        payload = {"sightings": batch, "scanner_key": SCANNER_KEY}
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                r = session.post(API_URL, json=payload, timeout=15)
                r.raise_for_status()
                log.info("Posted %d sighting(s) → %s", len(batch), r.status_code)
                break
            except Exception as exc:
                log.warning("POST attempt %d/%d failed: %s", attempt, MAX_RETRIES, exc)
                if attempt < MAX_RETRIES:
                    await asyncio.sleep(RETRY_DELAY)
                else:
                    log.error("Giving up on batch of %d sighting(s)", len(batch))


async def main():
    log.info("Tool Tracker gateway starting — API: %s", API_URL)
    await asyncio.gather(scan_loop(), post_loop())


if __name__ == "__main__":
    asyncio.run(main())
