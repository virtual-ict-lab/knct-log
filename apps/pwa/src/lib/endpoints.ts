import type { Endpoint } from "./db.ts";

/** ビルド時の既定値。VITE_ENDPOINTS="学内=https://campus.example,CF=https://cf.example"（優先順） */
export function defaultEndpoints(): Endpoint[] {
  const raw = (import.meta.env.VITE_ENDPOINTS as string | undefined) ?? "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf("=");
      return i > 0 ? { label: s.slice(0, i), url: s.slice(i + 1) } : { label: s, url: s };
    });
  return list.length ? list : [{ label: "local", url: "http://localhost:8787" }];
}

/**
 * 優先順に /v1/health を確認し、最初に応答したサーバーを返す。
 * 学内サーバーは学外からは届かないので、タイムアウトで次（CF）に切り替わる。
 */
export async function pickEndpoint(endpoints: Endpoint[], timeoutMs = 1500) {
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${ep.url.replace(/\/+$/, "")}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const { server_id } = (await res.json()) as { server_id: string };
      return { endpoint: ep, serverId: server_id };
    } catch {
      // 次の候補へ
    }
  }
  return null;
}
