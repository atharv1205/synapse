import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Port `synapse serve` listens on. */
const API_PORT = process.env.SYNAPSE_API_PORT ?? "4317";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    // With the dev proxy the app talks to a same-origin /api in dev and production alike,
    // so the server doesn't need any CORS handling.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // By default Vite inlines small assets as data: URLs, and a few font subsets are
    // small enough for that. Our Content-Security-Policy only allows same-origin fonts,
    // so we keep every font a real file instead of loosening the policy.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
});
