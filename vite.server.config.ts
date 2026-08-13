import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/data": "http://127.0.0.1:3210",
      "/display": "http://127.0.0.1:3210",
      "/health": "http://127.0.0.1:3210",
    },
  },
  build: {
    outDir: "server-dist",
    emptyOutDir: true,
  },
});
