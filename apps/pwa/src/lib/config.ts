/** 学内サーバーが起動時の環境変数から返す /config.js の値（servers/campus/src/main.ts） */
type RuntimeConfig = { endpoints?: string; vapidPublicKey?: string; rpId?: string };

const runtime = (globalThis as { __KNCT_LOG_CONFIG__?: RuntimeConfig }).__KNCT_LOG_CONFIG__ ?? {};

/** 起動時の値を優先し、無ければビルド時の VITE_* を使う（CF Pages と開発用） */
export const config = {
  endpoints: runtime.endpoints || import.meta.env.VITE_ENDPOINTS || "",
  vapidPublicKey: runtime.vapidPublicKey || import.meta.env.VITE_VAPID_PUBLIC_KEY || "",
  rpId: runtime.rpId || import.meta.env.VITE_RP_ID || "",
};
