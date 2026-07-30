import { defineConfig, devices } from "@playwright/experimental-ct-react";
import react from "@vitejs/plugin-react";

export default defineConfig({
  testDir: "./tests/react",
  outputDir: "./tests/react/results",
  timeout: 10_000,
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "./tests/react/report", open: "never" }],
  ],
  use: {
    trace: "on-first-retry",
    ctTemplateDir: "tests/react/mount",
    ctViteConfig: {
      plugins: [react()],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
