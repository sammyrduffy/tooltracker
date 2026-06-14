// ---------------------------------------------------------------------------
// make-icons.js  —  Generates the app icons (run once: node make-icons.js)
//
// Draws a white checkmark on an iOS-blue rounded square. Outputs PNGs (used by
// iOS "Add to Home Screen" and Android install) plus an SVG (browser favicon).
// Re-run this if you want to change the icon design.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const BLUE = [10, 132, 255];
const OUT = path.join(__dirname, 'public');

// Checkmark in 0..1 space (y points down), drawn as two round-capped segments.
const A = [0.30, 0.53], B = [0.45, 0.68], C = [0.72, 0.34];
const STROKE = 0.11; // thickness in normalized units

function distToSegment(px, py, v, w) {
  const dx = w[0] - v[0], dy = w[1] - v[1];
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - v[0]) * dx + (py - v[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = v[0] + t * dx, cy = v[1] + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Coverage 0..1 for the checkmark at normalized point (with 2x2 supersampling).
function inkCoverage(nx, ny, n) {
  const half = STROKE / 2;
  const s = 1 / (n * 2); // half-pixel in normalized units
  let hits = 0;
  for (const ox of [-s, s]) for (const oy of [-s, s]) {
    const d = Math.min(distToSegment(nx + ox, ny + oy, A, B), distToSegment(nx + ox, ny + oy, B, C));
    if (d <= half) hits++;
  }
  return hits / 4;
}

function makePng(n) {
  const png = new PNG({ width: n, height: n });
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const nx = (x + 0.5) / n, ny = (y + 0.5) / n;
      const cov = inkCoverage(nx, ny, n);
      // Blend white checkmark over the solid blue background.
      const r = Math.round(BLUE[0] * (1 - cov) + 255 * cov);
      const g = Math.round(BLUE[1] * (1 - cov) + 255 * cov);
      const b = Math.round(BLUE[2] * (1 - cov) + 255 * cov);
      const idx = (y * n + x) * 4;
      png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = 255;
    }
  }
  fs.writeFileSync(path.join(OUT, `icon-${n}.png`), PNG.sync.write(png));
  console.log(`  wrote icon-${n}.png`);
}

[180, 192, 512].forEach(makePng);

// Matching SVG for the browser tab (rounded corners look nice in a tab).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="rgb(${BLUE.join(',')})"/>
  <path d="M ${A[0] * 512} ${A[1] * 512} L ${B[0] * 512} ${B[1] * 512} L ${C[0] * 512} ${C[1] * 512}"
        fill="none" stroke="#fff" stroke-width="${STROKE * 512}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
fs.writeFileSync(path.join(OUT, 'icon.svg'), svg);
console.log('  wrote icon.svg');
console.log('Done.');
