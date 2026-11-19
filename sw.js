// Офлайн: один раз открыл с интернетом — дальше приложение грузится из кэша.
const VERSION = 'wfi-1.2.2';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.json', 'icon.svg', 'icon-180.png', 'icon-512.png',
  'js/app.js', 'js/boot.js', 'js/net.js', 'js/cloud.js', 'js/audio.js', 'js/stt.js', 'js/license.js', 'js/proc-worklet.js',
  'vendor/qrcode.js', 'vendor/jsQR.js', 'vendor/rnnoise.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// С интернетом — свежая версия из сети (ждём до 3 с), без него — кэш.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const net = fetch(e.request, { cache: 'no-cache' }).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    const fresh = await Promise.race([net.catch(() => null), new Promise((ok) => setTimeout(ok, 3000))]);
    return fresh || (await c.match(e.request, { ignoreSearch: true })) || net;
  }));
});
