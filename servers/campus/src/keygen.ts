// ピア鍵・VAPID 鍵・HMAC シークレットを生成して表示する
import { randomBytes, toB64u } from "@knct-log/core";
import { generatePeerKey } from "./peer-key.ts";

const peer = await generatePeerKey();
const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
const vapidPub = toB64u(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)));
const vapidJwk = await crypto.subtle.exportKey("jwk", vapid.privateKey);

console.log(`# 学内サーバー (.env)
SECRET=${toB64u(randomBytes(32))}
PEER_SIGNING_KEY=${peer.privatePkcs8}
# 学内サーバーのピア公開鍵（CF 側の PEER_KEYS に登録する）: ${peer.publicKey}

# VAPID（CF と学内の両方に同じ値を設定し、PWA のビルドにも公開鍵を渡す）
VAPID_PUBLIC_KEY=${vapidPub}
VAPID_PRIVATE_KEY=${vapidJwk.d}
VAPID_SUBJECT=mailto:admin@example.com
`);
