/* WheatField · WheatGuard — عامل الخدمة
   - يحفظ هيكل الصفحة والمكتبات ليعمل الكشف بلا إنترنت بعد أول تحميل.
   - النموذج يحفظه كود الصفحة نفسه في Cache Storage (لا يمسّه هذا الملف).
   - لا يحفظ أبداً: الخادم (health / drone / weather / proxy)، بلاطات الخريطة، Supabase. */
const VER = 'wf-shell-v1';   // غيّر الرقم عند تعديل هذا الملف
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const CDN = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const STATIC = /^\/(index\.html|manifest\.webmanifest|icon-\d+\.png)?$/;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('wf-shell-') && k !== VER) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === self.location.origin) {
    if (STATIC.test(u.pathname) || r.mode === 'navigate') e.respondWith(networkFirst(r));
    return;                                   // الباقي (النموذج، الواجهات) يمرّ مباشرة
  }
  if (CDN.includes(u.hostname)) e.respondWith(cacheFirst(r));
});

async function networkFirst(r) {
  const c = await caches.open(VER);
  try {
    const res = await fetch(r);
    if (res && res.status === 200) c.put(r, res.clone());
    return res;
  } catch (err) {
    const m = await c.match(r, { ignoreSearch: true });
    if (m) return m;
    if (r.mode === 'navigate') { const i = (await c.match('index.html')) || (await c.match('./')); if (i) return i; }
    throw err;
  }
}

async function cacheFirst(r) {
  const c = await caches.open(VER);
  const m = await c.match(r);
  if (m) return m;
  const res = await fetch(r);
  if (res && res.status === 200) c.put(r, res.clone());   // الاستجابات المبهمة (opaque) لا تُحفظ
  return res;
}
