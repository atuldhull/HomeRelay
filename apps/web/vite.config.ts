import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import path from "node:path";

export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "connect-src 'self'", "frame-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const apiPort = env.API_PORT || "3000";
  const webPort = Number(env.WEB_PORT || 5173);
  return {
    plugins: [react()],
    server: { port: webPort, strictPort: true, proxy: { "/api": `http://127.0.0.1:${apiPort}` } },
    // The built app (vite preview) gets a strict policy. The dev server is left without one because Vite's
    // hot-reload preamble is an inline script. Inline styles stay allowed: React sets CSS variables via style.
    preview: { port: webPort, proxy: { "/api": `http://127.0.0.1:${apiPort}` }, headers: SECURITY_HEADERS },
    resolve: { alias: { "@homerelay/shared": path.resolve(import.meta.dirname, "../../packages/shared/src/index.ts") } },
  };
});
