import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: ["localhost", ".ngrok-free.app", ".ngrok.io"],
    proxy: {
      // Forwards /api/* to the Next.js relay (../relay).
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
