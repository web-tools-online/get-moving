/**
 * Minimal service worker.
 *
 * Two jobs: route notification clicks back into the page (the only way to get
 * action buttons on a notification), and keep a small offline cache so a dropped
 * connection does not take the timer down with it.
 *
 * It deliberately does NOT try to schedule anything. A worker gets shut down
 * between events, and there is no push server behind GitHub Pages, so the page
 * itself owns the clock.
 */

const CACHE = 'get-moving-v1';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './js/app.js',
  './js/scheduler.js',
  './js/settings.js',
  './js/alarm.js',
  './js/notify.js',
  './js/attention.js',
  './js/marquee-worker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .catch(() => undefined) // a missing asset must not block activation
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network-first so a deploy is picked up straight away, with the cache as a fallback.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match('./index.html'))),
  );
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action || 'open';
  event.notification.close();

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const scope = new URL('./', self.location.href).href;
      const existing = clientList.find((client) => client.url.startsWith(scope));

      if (existing) {
        existing.postMessage({ type: 'notification-action', action });
        if ('focus' in existing) await existing.focus();
        return;
      }

      // Nothing open any more — reopen the page and let it pick up the action.
      const opened = await self.clients.openWindow(`./?action=${encodeURIComponent(action)}`);
      if (opened) opened.postMessage({ type: 'notification-action', action });
    })(),
  );
});
