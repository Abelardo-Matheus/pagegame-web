// PageGame (app do celular): guarda os arquivos do app para abrir rápido e
// funcionar instalado. Artigos da Wikipédia e o Supabase sempre vêm da rede.
const CACHE = 'pagegame-v23';
const SHELL = [
  './', './index.html', './app.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  '../config.js', '../lib/supabase.js', '../platform.js', '../room.js', '../net.js',
  '../content.js', '../content.css', '../inventory.js', './apk.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// arquivos do próprio app: tenta a rede (versão nova) e cai no cache se estiver offline
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
