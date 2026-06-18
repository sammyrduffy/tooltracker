// ---------------------------------------------------------------------------
// labels.js  —  Definitions for standard Avery label sheets (US Letter).
//
// All measurements are in INCHES. These match the published Avery templates so
// the printed grid lines up with the pre-cut stickers. Because a QR code plus a
// readable tool name is cramped on the tiny 5160 size, the default is 5163,
// which scans far more reliably. Always do one test print on plain paper first
// and print at "100% / Actual size" (no "fit to page").
//
// Optional per-spec properties:
//   gap     — vertical gap between QR, id text, and bar (default 0.02in)
//   barPad  — top/bottom padding inside the black name bar (default 0.02in)
// ---------------------------------------------------------------------------

const LABEL_SHEETS = {
  avery5160: {
    label: 'Avery 5160 — 30 per sheet (2⅝" × 1") — smallest',
    cols: 3, rows: 10,
    labelW: 2.625, labelH: 1.0,
    marginTop: 0.5, marginSide: 0.1875,
    colGap: 0.125, rowGap: 0,
    qrSize: 0.66, idFont: 9, barFont: 5.5,
  },
  avery5163: {
    label: 'Avery 5163 — 10 per sheet (4" × 2") — recommended',
    cols: 2, rows: 5,
    labelW: 4.0, labelH: 2.0,
    marginTop: 0.5, marginSide: 0.15625,
    colGap: 0.1875, rowGap: 0,
    qrSize: 1.38, idFont: 18, barFont: 9,
  },
  avery5164: {
    label: 'Avery 5164 — 6 per sheet (4" × 3⅓") — largest',
    cols: 2, rows: 3,
    labelW: 4.0, labelH: 3.33,
    marginTop: 0.5, marginSide: 0.15625,
    colGap: 0.1875, rowGap: 0,
    qrSize: 2.3, idFont: 26, barFont: 13,
  },
  dense: {
    label: 'Dense — 88 per sheet (1" × 0.9") — 8 across, plain paper',
    cols: 8, rows: 11,
    labelW: 1.0, labelH: 0.9,
    marginTop: 0.5, marginSide: 0.25,
    colGap: 0, rowGap: 0,
    qrSize: 0.72, idFont: 5.5, barFont: 4,
    gap: 0.01, barPad: 0.01,
  },
};

const DEFAULT_SHEET = 'avery5163';

module.exports = { LABEL_SHEETS, DEFAULT_SHEET };
