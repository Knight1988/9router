#!/usr/bin/env node
// Regenerate the static provider registry: node scripts/generate-registry.mjs
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const registryDir = fileURLToPath(new URL("../open-sse/providers/registry/", import.meta.url));
// Preserve intentional runtime exclusions when discovering new registry files.
const excludedFiles = new Set([
  "index.js",
  "REGISTRY_TEMPLATE.js",
  "devin-cli.js", // Spawns a local agent with shell/filesystem access.
  "trae.js", // SOLO agent has no tool-calling support.
  "windsurf.js", // gRPC executor skips ToolCallChunk.
]);
const files = readdirSync(registryDir)
  .filter(file => file.endsWith(".js") && !excludedFiles.has(file))
  .sort();

const imports = files.map((file, index) => `import p${index} from ${JSON.stringify(`./${file}`)};`);
const entries = files.map((_, index) => `  p${index},`);
const output = [
  "// Auto-generated: static imports for all registry entries",
  ...imports,
  "export default [",
  ...entries,
  "];",
  "",
].join("\n");

writeFileSync(join(registryDir, "index.js"), output, "utf8");
console.log(`Generated registry/index.js with ${files.length} providers`);
