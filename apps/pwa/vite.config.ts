import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: { target: "es2022" },
  // スマホでの確認は `tailscale serve` の HTTPS（*.ts.net）経由で開く（README の「スマホで確認する」）
  server: { allowedHosts: [".ts.net"] },
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,woff2}"], maximumFileSizeToCacheInBytes: 5 * 1024 * 1024 },
      manifest: {
        name: "knct-log",
        short_name: "knct-log",
        description: "1時間に1回、3秒だけ。仲間とだけ共有する日常ログ。",
        lang: "ja",
        display: "standalone",
        start_url: "/",
        background_color: "#111418",
        theme_color: "#111418",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
});
