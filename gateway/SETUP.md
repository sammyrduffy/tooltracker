# Tool Tracker Gateway — Pi Zero 2 W Setup

One Pi per site. Each one scans for beacons and posts sightings to the cloud app.

---

## What you need (per gateway)

- Raspberry Pi Zero 2 W (~$15)
- 16 GB microSD card (~$8)
- USB-C power adapter (phone charger works)
- USB-C cable
- [Raspberry Pi Imager](https://www.raspberrypi.com/software/) (free, on your PC)

---

## Step 1 — Flash the SD card

1. Open **Raspberry Pi Imager** on your PC.
2. Choose OS → **Raspberry Pi OS Lite (64-bit)** (no desktop needed).
3. Choose your SD card as the storage target.
4. Click the **gear icon** (⚙) before writing — this lets you pre-configure:
   - **Hostname**: e.g. `shop-gw` or `site-oakwood-gw`
   - **Enable SSH**: yes, use password authentication
   - **Username / Password**: `pi` / pick a password
   - **WiFi**: enter your site's WiFi network name and password
5. Write the card. When done, eject and insert into the Pi.

---

## Step 2 — First boot and SSH in

1. Power up the Pi (plug in USB-C). Wait ~60 seconds.
2. On your laptop, open a terminal and connect:
   ```
   ssh pi@shop-gw.local
   ```
   (replace `shop-gw` with whatever hostname you chose)
3. Accept the fingerprint prompt, enter your password.

---

## Step 3 — Install software

Run these commands on the Pi:

```bash
sudo apt update && sudo apt install -y python3-pip git
git clone https://github.com/sammyrduffy/tooltracker.git
pip3 install bleak requests
```

---

## Step 4 — Configure this gateway's site name

Each Pi needs a unique `SCANNER_KEY` so the app knows which site it's at.

```bash
sudo nano /etc/systemd/system/ble-gateway.service
```

Copy and paste the contents of `~/tooltracker/gateway/ble-gateway.service` into that file.  
Change the `SCANNER_KEY` line to match this site, e.g.:

```
Environment="SCANNER_KEY=site-oakwood"
```

Save with Ctrl+X → Y → Enter.

---

## Step 5 — Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable ble-gateway
sudo systemctl start ble-gateway
```

Check it's running:

```bash
sudo systemctl status ble-gateway
```

You should see **active (running)**. Live log:

```bash
sudo journalctl -u ble-gateway -f
```

---

## Step 6 — Link scanner to site in the app

1. Log into **https://tooltracker-hlrd.onrender.com** as a manager.
2. Go to **Beacons**.
3. Under **Scanners**, you'll see this Pi's key appear once it posts its first sighting.
4. Set its **Site** to the matching site in the app.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Can't SSH in | Give it another 60s; check WiFi credentials were entered correctly in Imager |
| `systemctl status` shows failed | Run `journalctl -u ble-gateway -n 50` to see the error |
| No sightings appearing in app | Make sure beacon is powered on and within ~10m of the Pi |
| Pi lost WiFi after reboot | Check `sudo raspi-config` → System → WiFi country is set correctly |
