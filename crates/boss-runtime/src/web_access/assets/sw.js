/* BOSS PWA service worker */
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
