import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
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
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
