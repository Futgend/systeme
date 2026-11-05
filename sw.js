// Service worker : garde la structure de l'app sur l'appareil (ouverture immédiate, même sans réseau).
// VERSION change à chaque fabrication du site : la nouvelle structure est mise en cache d'un bloc,
// puis remplace l'ancienne à l'ouverture suivante. Les appels à l'API (POST) ne passent jamais par ici.
var VERSION = '6b639b43a9f8';
var STRUCTURE = ['./', 'index.html', 'relais.js', 'manifest.webmanifest', 'icone-192.png', 'icone-512.png', 'icone-180.png'];
var POLICES = 'systeme-polices';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open('systeme-' + VERSION).then(function (c) { return c.addAll(STRUCTURE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== 'systeme-' + VERSION && k !== POLICES; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  // La police Poppins : gardée après le premier chargement
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(POLICES).then(function (c) {
      return c.match(r).then(function (m) {
        var reseau = fetch(r).then(function (rep) { if (rep.ok || rep.type === 'opaque') c.put(r, rep.clone()); return rep; });
        return m || reseau;
      });
    }));
    return;
  }
  if (u.origin !== self.location.origin) return;
  // La structure de l'app : d'abord la copie de l'appareil
  e.respondWith(caches.open('systeme-' + VERSION).then(function (c) {
    return c.match(r, { ignoreSearch: true }).then(function (m) {
      if (m) return m;
      if (r.mode === 'navigate') return c.match('index.html').then(function (i) { return i || fetch(r); });
      return fetch(r);
    });
  }));
});
