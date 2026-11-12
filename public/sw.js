// CapitUp LMS service worker: shows push notifications (renewal reminders,
// new assignments) and opens the right page when one is tapped. It does not
// cache pages or intercept requests; the LMS always loads fresh.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : "" };
  }
  const title = message.title || "CapitUp LMS";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: message.body || "",
      tag: message.tag || undefined,
      icon: "/capitup-logo.png",
      badge: "/capitup-logo.png",
      data: { url: message.url || "/my-day" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only our own pages: the URL comes from our server, but never leave the site.
  const target = new URL(event.notification.data?.url || "/my-day", self.location.origin);
  const url = target.origin === self.location.origin ? target.href : new URL("/my-day", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
