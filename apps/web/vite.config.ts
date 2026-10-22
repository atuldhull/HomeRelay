import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const apiPort = env.API_PORT || "3000";
  const webPort = Number(env.WEB_PORT || 5173);
  return {
    plugins: [react()],
    server: { port: webPort, strictPort: true, proxy: { "/api": `http://127.0.0.1:${apiPort}` } },
    preview: { port: webPort, proxy: { "/api": `http://127.0.0.1:${apiPort}` } },
    resolve: { alias: { "@homerelay/shared": path.resolve(import.meta.dirname, "../../packages/shared/src/index.ts") } },
  };
});
