import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pipeline = readFileSync(new URL("../../azure-pipelines.yml", import.meta.url), "utf8");

describe("dashboard CI gate", () => {
  it("runs the browser smoke before Docker cleanup and image deployment", () => {
    const start = pipeline.indexOf("# Mandatory dashboard browser smoke");
    const browserTest = pipeline.indexOf("unit/dashboard-pages-browser.test.js", start);
    const cleanup = pipeline.indexOf("docker compose -f docker-compose.yml -f docker-compose.ci.yml down", browserTest);
    const buildStage = pipeline.indexOf("  - stage: Build");
    expect(start).toBeGreaterThan(-1);
    expect(browserTest).toBeGreaterThan(start);
    expect(cleanup).toBeGreaterThan(browserTest);
    expect(buildStage).toBeGreaterThan(cleanup);
    expect(pipeline.slice(start, browserTest)).toContain("DASHBOARD_SMOKE_URL=http://127.0.0.1:21128");
  });
});
