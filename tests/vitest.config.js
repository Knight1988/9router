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
    ],
    // Suppress noisy console output from handlers under test
    silent: false,
    // DB-heavy tests (db-concurrent, db-sqlite-vs-lowdb) need extra time on CI
    // because better-sqlite3 may fall back to sql.js (slower native rebuild).
    hookTimeout: 60000,
  },
  resolve: {
    alias: {
      // Resolve open-sse/* imports to the actual local package
      "open-sse": resolve(__dirname, "../open-sse"),
      // Resolve @/* imports to src directory
      "@": resolve(__dirname, "../src"),
    },
  },
});
