// splitty service worker — web push only (no fetch interception)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch { data = { body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'splitty', {
    body: data.body || '',
    tag: data.tag,               // one notification per chat — new ones replace old
    data: { url: data.url || '/' },
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (new URL(c.url).pathname === url && 'focus' in c) return c.focus();
    }
    return clients.openWindow(url);
  }));
});
