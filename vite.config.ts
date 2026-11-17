import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: the Go server runs on :8686; /api is proxied so the page and API share an origin.
const api = process.env.MERCHANDISER_API ?? "http://127.0.0.1:8686";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 1420,
    proxy: { "/api": { target: api, changeOrigin: true } },
  },
});
