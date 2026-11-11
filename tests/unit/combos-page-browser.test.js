import { describe, it, expect } from "vitest";
import { chromium } from "playwright-core";

// Run against an isolated development server with dashboard login disabled.
const baseURL = process.env.COMBOS_TEST_URL;

describe.skipIf(!baseURL)("combos dashboard", () => {
  it("renders a smart combo whose router is not configured", async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/combos", (route) => route.fulfill({ json: { combos: [{ id: "test", name: "test-combo", kind: "llm", models: ["openai/gpt-4o"] }] } }));
      await page.route("**/api/providers", (route) => route.fulfill({ json: { connections: [] } }));
      await page.route("**/api/settings", (route) => route.fulfill({ json: { comboStrategies: { "test-combo": { fallbackStrategy: "smart", routerModel: "openai/gpt-4o" } } } }));
      await page.goto(`${baseURL}/dashboard/combos`);
      try {
        await page.getByText("test-combo", { exact: true }).waitFor({ timeout: 10000 });
      } catch (error) {
        throw new Error(`Combo page did not render: ${errors.join(", ")}`, { cause: error });
      }
      await expect(page.getByText("Not configured").count()).resolves.toBe(1);
      await expect(page.getByRole("link", { name: "Configure" }).count()).resolves.toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30000);
});
