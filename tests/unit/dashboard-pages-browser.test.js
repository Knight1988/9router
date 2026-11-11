import { describe, it, expect } from "vitest";
import { chromium } from "playwright-core";

// Opt in only with a disposable, login-disabled local app. Never target production.
const baseURL = process.env.DASHBOARD_SMOKE_URL;
const pages = [
  ["/dashboard", "Endpoint"],
  ["/dashboard/providers", "Providers"],
  ["/dashboard/combos", "Combos"],
  ["/dashboard/usage", "Usage & Analytics"],
  ["/dashboard/endpoint", "Endpoint"],
  ["/dashboard/quota", "Quota Tracker"],
  ["/dashboard/token-saver", "Token Saver"],
  ["/dashboard/profile", "Settings"],
];

describe.skipIf(!baseURL)("dashboard browser smoke", () => {
  it("renders key pages and a populated smart combo without browser errors", async () => {
    const target = new URL(baseURL);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(target.hostname);
    expect(["http:", "https:"]).toContain(target.protocol);
    expect(target.username || target.password || target.pathname !== "/" || target.search || target.hash).toBeFalsy();

    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Never let a smoke test make mutations or contact third-party services.
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== target.origin || !["GET", "HEAD"].includes(request.method())) {
          return route.abort();
        }
        if (url.pathname === "/api/combos") {
          return route.fulfill({ json: { combos: [{ id: "smoke-combo", name: "smoke-combo", kind: "llm", models: ["openai/gpt-4o"] }] } });
        }
        if (url.pathname === "/api/providers") return route.fulfill({ json: { connections: [] } });
        if (url.pathname === "/api/settings" && new URL(page.url()).pathname === "/dashboard/combos") {
          return route.fulfill({ json: { comboStrategies: { "smoke-combo": { fallbackStrategy: "smart", routerModel: "openai/gpt-4o" } } } });
        }
        return route.continue();
      });
      for (const [path, label] of pages) {
        const response = await page.goto(`${target.origin}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
        expect(response?.status(), path).toBe(200);
        await page.locator("main").getByText(label, { exact: true }).first().waitFor({ timeout: 30000 });
        expect(new URL(page.url()).pathname, path).toBe(path === "/dashboard" ? "/dashboard" : path);
        if (path === "/dashboard/combos") {
          await page.getByText("smoke-combo", { exact: true }).waitFor({ timeout: 30000 });
          await page.getByText("Not configured", { exact: true }).waitFor({ timeout: 30000 });
          expect(await page.getByRole("link", { name: "Configure" }).count()).toBe(1);
        }
        // Allow client-side effects to run after the page marker appears.
        await page.waitForTimeout(500);
        expect(errors, `${path}: browser errors`).toEqual([]);
      }
    } finally {
      await browser.close();
    }
  }, 240000);
});
