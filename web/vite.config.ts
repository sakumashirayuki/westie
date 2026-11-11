import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/v1": {
        target: "http://localhost:3000",
        // 保留浏览器的 Host，使后端的 Origin 校验能识别同源请求。
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "node",
  },
});
