/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_ENDPOINTS?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  /** パスキーの RP ID。PWA の配信元と学内サーバーに共通の親ドメイン（例 knct-log.example） */
  readonly VITE_RP_ID?: string;
}
