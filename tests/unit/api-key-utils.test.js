/**
 * Unit tests for src/shared/utils/apiKey.js — pure helpers, no mocks needed.
 */

import { describe, it, expect } from "vitest";
import {
  generateApiKeyWithMachine,
  parseApiKey,
  verifyApiKeyCrc,
  isNewFormatKey,
} from "../../src/shared/utils/apiKey.js";

const machineId = "abcd1234efgh5678";

describe("apiKey utilities", () => {
  describe("generateApiKeyWithMachine", () => {
    it("returns key in sk-{machineId}-{keyId6}-{crc8} shape", () => {
      const { key } = generateApiKeyWithMachine(machineId);
      const parts = key.split("-");
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe("sk");
      expect(parts[1]).toBe(machineId);
      expect(parts[2]).toHaveLength(6);
      expect(parts[3]).toHaveLength(8);
    });

    it("generates unique keys on repeated calls", () => {
      const keys = new Set(
        Array.from({ length: 10 }, () => generateApiKeyWithMachine(machineId).key)
      );
      expect(keys.size).toBeGreaterThan(1);
    });

    it("returned keyId is 6 lowercase alnum chars", () => {
      const { keyId } = generateApiKeyWithMachine(machineId);
      expect(keyId).toMatch(/^[a-z0-9]{6}$/);
    });
  });

  describe("parseApiKey", () => {
    it("returns null for null input", () => {
      expect(parseApiKey(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseApiKey("")).toBeNull();
    });

    it("returns null for strings not starting with sk-", () => {
      expect(parseApiKey("Bearer token")).toBeNull();
      expect(parseApiKey("apikey-xyz")).toBeNull();
    });

    it("parses new-format keys and recovers machineId", () => {
      const { key } = generateApiKeyWithMachine(machineId);
      const parsed = parseApiKey(key);
      expect(parsed).not.toBeNull();
      expect(parsed.isNewFormat).toBe(true);
      expect(parsed.machineId).toBe(machineId);
      expect(parsed.keyId).toHaveLength(6);
    });

    it("parses legacy 2-part sk-XXXXXXXX keys", () => {
      const parsed = parseApiKey("sk-abc12345");
      expect(parsed).not.toBeNull();
      expect(parsed.isNewFormat).toBe(false);
      expect(parsed.machineId).toBeNull();
      expect(parsed.keyId).toBe("abc12345");
    });

    it("returns null for 4-part key with tampered CRC", () => {
      const { key } = generateApiKeyWithMachine(machineId);
      const parts = key.split("-");
      parts[3] = "00000000";
      expect(parseApiKey(parts.join("-"))).toBeNull();
    });

    it("returns null for 3-part key (unrecognized format)", () => {
      expect(parseApiKey("sk-part1-part2")).toBeNull();
    });
  });

  describe("verifyApiKeyCrc", () => {
    it("returns true for a freshly generated new-format key", () => {
      const { key } = generateApiKeyWithMachine(machineId);
      expect(verifyApiKeyCrc(key)).toBe(true);
    });

    it("returns true for legacy 2-part key", () => {
      expect(verifyApiKeyCrc("sk-legacyid")).toBe(true);
    });

    it("returns false for tampered CRC", () => {
      const { key } = generateApiKeyWithMachine(machineId);
      const parts = key.split("-");
      parts[3] = "deadbeef";
      expect(verifyApiKeyCrc(parts.join("-"))).toBe(false);
    });

    it("returns false for null", () => {
      expect(verifyApiKeyCrc(null)).toBe(false);
    });
  });

  describe("isNewFormatKey", () => {
    it("returns true for new-format keys", () => {
      const { key } = generateApiKeyWithMachine(machineId);
      expect(isNewFormatKey(key)).toBe(true);
    });

    it("returns false for legacy keys", () => {
      expect(isNewFormatKey("sk-oldformat")).toBe(false);
    });

    it("returns false for null/invalid input", () => {
      expect(isNewFormatKey(null)).toBe(false);
      expect(isNewFormatKey("not-a-key")).toBe(false);
    });
  });
});
