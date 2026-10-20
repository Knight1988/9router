import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Render the real JSX picker in Node tests rather than asserting source strings.
  plugins: [{
    name: "test-component-jsx",
    async transform(code, id) {
      if (!id.includes("/src/shared/components/") || !id.endsWith(".js")) return null;
      const { transformAsync } = await import("@babel/core");
      return transformAsync(code, {
        filename: id, plugins: [["@babel/plugin-transform-react-jsx", { runtime: "automatic" }]],
        babelrc: false, configFile: false, sourceMaps: true,
      });
    },
  }],
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    exclude: [
      "**/node_modules/**",
      "**/embeddings.cloud.test.js",
      "**/.next/**",
      // Don't scan into git worktrees nested under .claude/ — they carry their
      // own copies of the test files but lack an installed node_modules (open-sse,
      // etc.), which makes provider imports fail during collection.
      "**/.claude/**",
      "**/dist/**",
      // These files use node:test (not vitest) — they're run separately by the
      // CI pipeline's node:test step and must be excluded from vitest collection.
      "**/kimchi.test.js",
      "**/kimchi-strip-reasoning.test.js",
    ],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
    // DB-heavy tests (db-concurrent, db-sqlite-vs-lowdb) need extra time on CI
    // because better-sqlite3 may fall back to sql.js (slower native rebuild).
    hookTimeout: 60000,
  },
  resolve: {
    dedupe: ["react"],
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
