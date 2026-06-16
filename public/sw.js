// Minimal service worker — just enough to make the app installable (PWA).
// No fetch interception: let the browser handle all requests normally.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
