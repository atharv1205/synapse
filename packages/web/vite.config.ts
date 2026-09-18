import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The port `synapse serve` listens on. */
const API_PORT = process.env.SYNAPSE_API_PORT ?? "4317";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    // Proxying in dev means the app talks to a same-origin /api in both dev and
    // production, so no CORS handling is needed on the server.
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
  },
});
