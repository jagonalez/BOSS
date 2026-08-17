/**
 * Progressive Web App assets for the phone client.
 *
 * These are served both by the loopback server (Tailscale path) and by any
 * static host that fronts the relay, so the same page installs to the home
 * screen either way. iOS runs a service worker and grants web push only for
 * an installed PWA, which is why the manifest matters here.
 */

export const WEB_MANIFEST = JSON.stringify({
  name: 'BOSS',
  short_name: 'BOSS',
  description: 'Review and steer your coding agents from your phone.',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0b0d10',
  theme_color: '#0b0d10',
  // Served from resources/icons by the /icon-<size>.png route.
  icons: [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
})

/**
 * Cache the shell so the app opens offline and shows its own "desktop
 * offline" state instead of the browser's error page. API and relay traffic
 * is never cached — a stale thread is worse than no thread.
 */
export const SERVICE_WORKER = `/* BOSS PWA service worker */
'use strict';
// Bump this whenever the page changes in a way a stale cache would hide.
// A fixed name meant a phone could keep serving an old page through every
// fix, which is indistinguishable from the fix not working.
var SHELL = 'boss-shell-v2';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL).then(function (cache) {
      return cache.addAll(['./', './manifest.webmanifest']);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) { return key !== SHELL; })
        .map(function (key) { return caches.delete(key); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  // Never cache live data: the API, the event stream, and the relay socket.
  if (url.pathname.indexOf('/api/') === 0) return;
  // Network-first for the shell, so an updated desktop ships an updated page.
  event.respondWith(
    fetch(request).then(function (response) {
      if (response && response.ok && url.origin === self.location.origin) {
        var copy = response.clone();
        caches.open(SHELL).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function () {
      return caches.match(request).then(function (hit) {
        return hit || caches.match('./');
      });
    })
  );
});

/**
 * Web push. iOS 16.4+ delivers these to an installed PWA. The payload is
 * written by the desktop, so it can carry a thread title without the relay
 * or the push service learning the chat content.
 */
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var title = data.title || 'BOSS';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'A thread needs your attention.',
    tag: data.tag || 'boss',
    data: { threadId: data.threadId || '' }
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var threadId = (event.notification.data && event.notification.data.threadId) || '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i += 1) {
        if ('focus' in list[i]) {
          list[i].postMessage({ type: 'open-thread', threadId: threadId });
          return list[i].focus();
        }
      }
      return self.clients.openWindow('./' + (threadId ? '#thread=' + threadId : ''));
    })
  );
});
`
