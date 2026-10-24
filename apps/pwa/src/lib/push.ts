import { config } from "./config.ts";
import type { Engine } from "./engine.ts";

const VAPID = config.vapidPublicKey;

export function pushSupported() {
  return !!VAPID && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** iOS では、ホーム画面に追加した PWA でしか Web Push を使えない */
export function needsHomeScreen() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone;
}

function urlB64(b64u: string) {
  const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** 通知を有効にして、接続中のサーバーに購読を登録する（購読はピア間で同期される） */
export async function enablePush(engine: Engine) {
  if (!pushSupported()) throw new Error("この環境では通知を使えません");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("通知が許可されませんでした");
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(VAPID) }));
  const conn = await engine.connect();
  if (!conn) throw new Error("サーバーに接続できません");
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await conn.api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys });
}

export async function disablePush(engine: Engine) {
  const sub = await currentSubscription();
  if (!sub) return;
  const conn = await engine.connect();
  await conn?.api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
