/**
 * React Hooks Exhaustive Dependencies Test
 * 
 * Catches missing dependencies in useMemo, useCallback, and useEffect hooks.
 * This test prevents bugs like the ModelSelectModal capFilter issue where
 * the filteredGroups useMemo used capFilter and getCaps in its body but
 * didn't list them in the dependency array, causing stale memoized values.
 */

import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import reactHooks from "eslint-plugin-react-hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");

describe("React Hooks - Exhaustive Dependencies", () => {
  it("should have no missing dependencies in useMemo/useCallback/useEffect", async () => {
    const eslint = new ESLint({
      cwd: projectRoot,
      overrideConfigFile: true,
      baseConfig: [
        {
          files: ["**/*.js", "**/*.jsx"],
          plugins: {
            "react-hooks": reactHooks,
          },
          rules: {
            "react-hooks/exhaustive-deps": "error",
          },
          languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            parserOptions: {
              ecmaFeatures: {
                jsx: true,
              },
            },
          },
        },
      ],
    });

    // Files to check - add more as needed
    const filesToCheck = [
      "src/shared/components/ModelSelectModal.js",
      // Add other component files that use hooks
    ];

    const results = await eslint.lintFiles(filesToCheck);
    
    // Filter to only react-hooks/exhaustive-deps violations
    const hookErrors = [];
    for (const result of results) {
      for (const message of result.messages) {
        if (message.ruleId === "react-hooks/exhaustive-deps") {
          hookErrors.push({
            file: result.filePath.replace(projectRoot + "/", ""),
            line: message.line,
            column: message.column,
            message: message.message,
            severity: message.severity === 2 ? "error" : "warning",
          });
        }
      }
    }

    if (hookErrors.length > 0) {
      const errorReport = hookErrors
        .map((err) => `  ${err.file}:${err.line}:${err.column} - ${err.message}`)
        .join("\n");
      
      throw new Error(
        `Found ${hookErrors.length} React hook dependency issue(s):\n\n${errorReport}\n\n` +
        "Fix by adding missing dependencies to the dependency array.\n" +
        "If a dependency is intentionally omitted, add an ESLint disable comment with explanation."
      );
    }

    expect(hookErrors).toHaveLength(0);
  }, 30000);

  it("ModelSelectModal should have capFilter and getCaps in filteredGroups dependencies", () => {
    const filePath = resolve(projectRoot, "src/shared/components/ModelSelectModal.js");
    const content = readFileSync(filePath, "utf-8");
    
    // Find the filteredGroups useMemo
    const filteredGroupsMatch = content.match(
      /const filteredGroups = useMemo\(\(\) => \{[\s\S]*?\}, \[(.*?)\]\);/
    );
    
    expect(filteredGroupsMatch, "Should find filteredGroups useMemo").toBeTruthy();
    
    if (filteredGroupsMatch) {
      const deps = filteredGroupsMatch[1];
      
      // Check that capFilter is in dependencies
      expect(
        deps.includes("capFilter"),
        "filteredGroups dependencies should include capFilter (used in line 540-542 for filtering)"
      ).toBe(true);
      
      // Check that getCaps is in dependencies
      expect(
        deps.includes("getCaps"),
        "filteredGroups dependencies should include getCaps (used in line 541 for capability filtering)"
      ).toBe(true);
    }
  });
});
