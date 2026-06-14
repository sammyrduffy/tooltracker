// ---------------------------------------------------------------------------
// baseurl.js  —  Works out the web address that QR codes should point to.
//
// QR stickers must encode an address the crew's PHONES can reach — e.g.
// http://192.168.2.79:3000 on a local network, or a real domain once online.
// We remember a chosen value in settings; otherwise we fall back to whatever
// address the manager is currently using to view the page.
// ---------------------------------------------------------------------------

const { getSetting } = require('../db');

function resolveBaseUrl(req) {
  const stored = getSetting('base_url');
  if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
  // Fall back to the current request's address (e.g. http://192.168.2.79:3000).
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = { resolveBaseUrl };
