/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope;

// アプリシェルを完全にキャッシュする（配信元が落ちていても起動できる）
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));
// 起動時の設定は配信元が変えられるので、届くときは最新を使い、届かないときは前回の値で起動する
registerRoute(({ url }) => url.origin === self.location.origin && url.pathname === "/config.js", new NetworkFirst({ cacheName: "config", networkTimeoutSeconds: 3 }));

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// 通知には中身を含めない（サーバーは内容を知らない）
self.addEventListener("push", (event) => {
  const data = (event.data?.json() ?? {}) as { t?: string; g?: string };
  const text: Record<string, [string, string]> = {
    prompt: ["今の1本を撮ろう", "3秒だけ、いまを残そう。"],
    reaction: ["リアクションが届きました", "あなたのクリップへの反応です。"],
    reply: ["返信が届きました", "あなたのクリップへの返信です。"],
  };
  const [title, body] = text[data.t ?? ""] ?? ["新しい投稿があります", "グループに新しいクリップが届きました。"];
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window" });
      for (const c of clients) c.postMessage({ type: "sync" });
      await self.registration.showNotification(title, {
        body,
        tag: data.t === "prompt" ? "prompt" : `${data.t ?? "post"}-${data.g ?? ""}`,
        icon: "icon-192.png",
        data: { url: data.t === "prompt" ? "/#/capture" : `/#/g/${data.g ?? ""}` },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data as { url?: string })?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clients) {
        if ("focus" in c) {
          await (c as WindowClient).navigate(url).catch(() => undefined);
          return (c as WindowClient).focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
