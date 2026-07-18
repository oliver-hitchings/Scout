const CACHE = 'scout-shell-beta-11-csp-hotfix-1';
const SHELL = [
  '/', '/app.js?v=beta-11-csp-hotfix-1', '/setup.js?v=beta-11-csp-hotfix-1',
  '/manifest.webmanifest', '/assets/scout-icon.png', '/assets/scout-idle.png',
  '/assets/scout-thinking.png', '/assets/scout-searching.png', '/assets/scout-warning.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const isShell = url.pathname === '/' || url.pathname === '/app.js' || url.pathname === '/setup.js'
    || url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/assets/');
  if (!isShell) return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});
