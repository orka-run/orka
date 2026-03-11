import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3773,
    host: "0.0.0.0",
    proxy: {
      "/ws": {
        target: "ws://localhost:7394",
        ws: true,
      },
    },
  },
});
