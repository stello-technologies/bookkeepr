'use strict';
/* Offline shell. On install it saves the page and every file the page (and its stylesheets) uses, so the app opens with no network.
   After that: files come from the saved copy at once and are refreshed in the background. The API is never touched here.
   To ship a new version of the app, change VERSION. */
const VERSION = 'v2';
const CACHE = 'bookkeeper-' + VERSION;
const same = (url) => new URL(url, self.location.origin).origin === self.location.origin;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const page = await fetch('/', { cache: 'reload' });
    await cache.put('/', page.clone());
    const html = await page.text();
    const urls = new Set(['/config.json', '/manifest.webmanifest']);
    for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]+)/g)) urls.add(m[1]);
    for (const u of [...urls]) { // fonts and images named inside stylesheets
      try {
        const r = await fetch(u, { cache: 'reload' });
        if (!r.ok) continue;
        await cache.put(u, r.clone());
        if (u.endsWith('.css')) for (const f of (await r.text()).matchAll(/url\((['"]?)(\/[^)'"?#]+)\1\)/g)) urls.add(f[2]);
      } catch { /* a missing extra file must not stop the app being saved */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !same(req.url)) return;
  const path = new URL(req.url).pathname;
  if (path.startsWith('/api/') || path === '/sw.js' || path === '/health') return; // always live, never saved here
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? '/' : req; // any page address opens the one saved page
    const saved = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
    if (saved) { event.waitUntil(fresh); return saved; }
    return (await fresh) || new Response('Offline', { status: 503 });
  })());
});
