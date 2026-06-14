// ---------------------------------------------------------------------------
// routes/qr.js  —  Generates a QR-code PNG image for a tool.
//
//   GET /qr/:code             PNG QR code that opens that tool's page
//   GET /qr/:code?download=1  Same image, but offered as a file download
//
// The QR encodes the tool's public URL, e.g. http://192.168.2.79:3000/t/Q3YCJ8
// ---------------------------------------------------------------------------

const express = require('express');
const QRCode = require('qrcode');
const router = express.Router();
const { db } = require('../db');
const { resolveBaseUrl } = require('../lib/baseurl');

router.get('/:code', (req, res) => {
  const tool = db.prepare('SELECT short_id FROM tools WHERE short_id = ?').get(req.params.code);
  if (!tool) return res.status(404).end();

  const url = `${resolveBaseUrl(req)}/t/${tool.short_id}`;
  res.type('png');
  if (req.query.download) {
    res.setHeader('Content-Disposition', `attachment; filename="tool-${tool.short_id}.png"`);
  }
  // Stream the QR straight to the browser. 'M' error-correction survives a bit
  // of sticker wear; width 600 keeps it crisp when printed small.
  QRCode.toFileStream(res, url, { margin: 1, width: 600, errorCorrectionLevel: 'M' }, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

module.exports = router;
