import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const controller = "http://127.0.0.1:3210";

export default defineConfig({
  plugins: [react()],
  server: {
    // The controller only accepts its own Host and Origin, so the development
    // proxy presents itself as the packaged application.
    proxy: Object.fromEntries(
      ["/data", "/display", "/health"].map((path) => [
        path,
        {
          target: controller,
          changeOrigin: true,
          headers: { origin: controller },
        },
      ]),
    ),
  },
  build: {
    outDir: "server-dist",
    emptyOutDir: true,
  },
});
