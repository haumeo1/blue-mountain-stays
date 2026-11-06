// Playwright browser regression suite for the owner portal + guest flow.
// Runs ONLY against the synthetic fixture (tests/browser/fixture-server.mjs) on 127.0.0.1:55004.
// Build first (npm run build); the fixture serves dist/. No real Supabase, Stripe, or email.
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:55004";

export default defineConfig({
  testDir: "tests/browser",
  testMatch: "**/*.spec.js",
  // The fixture keeps global in-memory state; tests reset it, so run strictly one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: ".context/playwright-results",
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    timezoneId: "America/Toronto",
    locale: "en-CA",
    serviceWorkers: "block"
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } } }
  ],
  webServer: {
    command: "node tests/browser/fixture-server.mjs",
    url: `${BASE_URL}/__fixture`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe"
  }
});
