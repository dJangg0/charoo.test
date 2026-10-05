import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "apps/web/test",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_EXECUTABLE,
      args: process.env.CHROMIUM_EXECUTABLE
        ? ["--no-sandbox", "--disable-dev-shm-usage"]
        : [],
    },
  },
  webServer: [
    {
      command: "node --import tsx apps/api/test/browser-server.ts",
      url: "http://localhost:3000/api/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm exec -w @charoo/web -- vite --host 127.0.0.1",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
