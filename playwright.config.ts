import { defineConfig } from "@playwright/test";

// E2E runs against its own isolated stack/database so it never touches your dev data.
const WEB = 5273, API = 3100, MCP = 3101;
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  reporter: "list",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://localhost:${WEB}`, channel: "chrome", screenshot: "off", trace: "off" },
  webServer: {
    command: "node scripts/e2e-clean.mjs && npm run dev",
    url: `http://localhost:${WEB}`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: { WEB_PORT: String(WEB), API_PORT: String(API), MCP_PORT: String(MCP), MCP_URL: `http://127.0.0.1:${MCP}/mcp`, WEB_ORIGIN: `http://localhost:${WEB}`, DATABASE_PATH: ".data/e2e.db", DOCUMENTS_DIR: ".data/e2e-documents" },
  },
});
