import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png", "icons/*.svg"],
      manifest: {
        name: "Uraiadal — உரையாடல்",
        short_name: "Uraiadal",
        description: "Private E2EE messenger. No phone. No email. Just your keypair.",
        theme_color: "#6C63FF",
        background_color: "#0A0A0F",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "/icons/icon-72.png",   sizes: "72x72",   type: "image/png" },
          { src: "/icons/icon-96.png",   sizes: "96x96",   type: "image/png" },
          { src: "/icons/icon-128.png",  sizes: "128x128", type: "image/png" },
          { src: "/icons/icon-144.png",  sizes: "144x144", type: "image/png" },
          { src: "/icons/icon-152.png",  sizes: "152x152", type: "image/png" },
          { src: "/icons/icon-192.png",  sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icons/icon-384.png",  sizes: "384x384", type: "image/png" },
          { src: "/icons/icon-512.png",  sizes: "512x512", type: "image/png", purpose: "any maskable" }
        ],
        shortcuts: [
          {
            name: "New Chat",
            short_name: "Chat",
            description: "Start a new encrypted chat",
            url: "/?action=new-chat",
            icons: [{ src: "/icons/icon-96.png", sizes: "96x96" }]
          }
        ],
        categories: ["communication", "privacy", "utilities"]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "CacheFirst",
            options: { cacheName: "google-fonts-cache", expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 } }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: { cacheName: "gstatic-fonts-cache", expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 } }
          }
        ]
      }
    })
  ],
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react:   ["react", "react-dom"],
          sodium:  ["libsodium-wrappers"],
          storage: ["dexie", "idb-keyval"]
        }
      }
    }
  },
  server: {
    port: 5173,
    host: true
  }
});
