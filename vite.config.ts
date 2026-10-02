import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Served from the site root; set VITE_BASE only to serve it under a sub-path.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  define: { global: "globalThis" },
  resolve: { alias: { buffer: "buffer/" } },
  optimizeDeps: { include: ["buffer"] },
  server: { port: 5173 },
});
