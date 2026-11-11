import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const excluded = ["devin-cli", "trae", "windsurf"];

describe("provider registry exclusions", () => {
  it.each(excluded)("keeps %s out of the runtime registry", (id) => {
    expect(REGISTRY.some(provider => provider.id === id)).toBe(false);
    expect(PROVIDERS[id]).toBeUndefined();
  });

  it("regenerates active entries without enabling deliberately excluded providers", () => {
    const root = mkdtempSync(join(tmpdir(), "9router-registry-"));
    try {
      mkdirSync(join(root, "scripts"));
      const registryDir = join(root, "open-sse/providers/registry");
      mkdirSync(registryDir, { recursive: true });
      copyFileSync(new URL("../../scripts/generate-registry.mjs", import.meta.url), join(root, "scripts/generate-registry.mjs"));
      for (const id of ["openai", "new-provider", ...excluded, "REGISTRY_TEMPLATE", "index"]) {
        writeFileSync(join(registryDir, `${id}.js`), "");
      }
      execFileSync(process.execPath, [join(root, "scripts/generate-registry.mjs")]);
      const generated = readFileSync(join(registryDir, "index.js"), "utf8");
      const imports = [...generated.matchAll(/^import .* from "\.\/(.+)\.js";/gm)].map(match => match[1]);
      expect(imports).toEqual(["new-provider", "openai"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
