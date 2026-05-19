/**
 * Unit tests for API key DB repo and route handlers.
 *
 * Covers:
 *  1. DB-backed repo in src/lib/db/repos/apiKeysRepo.js (mocked adapter)
 *  2. Route handlers in src/app/api/keys/route.js and [id]/route.js (mocked DB)
 *
 * Pure utility tests for src/shared/utils/apiKey.js are in api-key-utils.test.js.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted, declared before any imports
// ---------------------------------------------------------------------------

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  getApiKeyById: vi.fn(),
  updateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn().mockResolvedValue("machine-id-test"),
}));

// Mock only generateApiKeyWithMachine (used inside createApiKey repo method)
// and spread the real exports so the rest of the module is unaffected.
vi.mock("@/shared/utils/apiKey", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateApiKeyWithMachine: vi.fn().mockReturnValue({
      key: "sk-machineXXXXXXXX-keyid1-crc12345",
      keyId: "keyid1",
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getAdapter } from "../../src/lib/db/driver.js";
import {
  getApiKeys,
  getApiKeyById,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  validateApiKey,
} from "../../src/lib/db/repos/apiKeysRepo.js";

import * as localDb from "../../src/lib/localDb.js";
import { getConsistentMachineId } from "../../src/shared/utils/machineId.js";
import { GET as keysGET, POST as keysPOST } from "../../src/app/api/keys/route.js";
import {
  GET as keyByIdGET,
  PUT as keyByIdPUT,
  DELETE as keyByIdDELETE,
} from "../../src/app/api/keys/[id]/route.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides = {}) {
  return {
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    run: vi.fn().mockReturnValue({ changes: 1 }),
    transaction: vi.fn((fn) => fn()),
    ...overrides,
  };
}

function makeRequest(url, options = {}) {
  return new Request(url, options);
}

// ---------------------------------------------------------------------------
// 1. apiKeysRepo
// ---------------------------------------------------------------------------

describe("apiKeysRepo", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("getApiKeys", () => {
    it("returns empty array when no rows", async () => {
      getAdapter.mockResolvedValue(makeAdapter({ all: vi.fn().mockReturnValue([]) }));
      expect(await getApiKeys()).toEqual([]);
    });

    it("maps isActive integer 1 to boolean true", async () => {
      const row = { id: "id1", key: "sk-x", name: "test", machineId: "m", isActive: 1, createdAt: "2024-01-01T00:00:00.000Z" };
      getAdapter.mockResolvedValue(makeAdapter({ all: vi.fn().mockReturnValue([row]) }));
      const [key] = await getApiKeys();
      expect(key.isActive).toBe(true);
    });

    it("maps isActive integer 0 to boolean false", async () => {
      const row = { id: "id2", key: "sk-y", name: "disabled", machineId: "m", isActive: 0, createdAt: "2024-01-01T00:00:00.000Z" };
      getAdapter.mockResolvedValue(makeAdapter({ all: vi.fn().mockReturnValue([row]) }));
      const [key] = await getApiKeys();
      expect(key.isActive).toBe(false);
    });

    it("queries with ORDER BY createdAt ASC", async () => {
      const mockAll = vi.fn().mockReturnValue([]);
      getAdapter.mockResolvedValue(makeAdapter({ all: mockAll }));
      await getApiKeys();
      expect(mockAll).toHaveBeenCalledWith(expect.stringContaining("ORDER BY createdAt ASC"));
    });
  });

  describe("getApiKeyById", () => {
    it("returns null when row not found", async () => {
      getAdapter.mockResolvedValue(makeAdapter());
      expect(await getApiKeyById("missing-id")).toBeNull();
    });

    it("returns mapped row when found", async () => {
      const row = { id: "id3", key: "sk-z", name: "found", machineId: "m", isActive: 1, createdAt: "2024-01-01T00:00:00.000Z" };
      getAdapter.mockResolvedValue(makeAdapter({ get: vi.fn().mockReturnValue(row) }));
      const result = await getApiKeyById("id3");
      expect(result.id).toBe("id3");
      expect(result.isActive).toBe(true);
    });
  });

  describe("createApiKey", () => {
    it("throws when machineId is not provided", async () => {
      await expect(createApiKey("mykey", undefined)).rejects.toThrow("machineId is required");
    });

    it("inserts and returns created key object with mocked generator", async () => {
      const mockRun = vi.fn().mockReturnValue({ changes: 1 });
      getAdapter.mockResolvedValue(makeAdapter({ run: mockRun }));
      const result = await createApiKey("my-key", "machine123");
      expect(result.name).toBe("my-key");
      expect(result.machineId).toBe("machine123");
      expect(result.isActive).toBe(true);
      expect(result.key).toBe("sk-machineXXXXXXXX-keyid1-crc12345");
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(mockRun).toHaveBeenCalledOnce();
    });
  });

  describe("updateApiKey", () => {
    it("returns null when key not found", async () => {
      getAdapter.mockResolvedValue(makeAdapter());
      expect(await updateApiKey("missing-id", { name: "new" })).toBeNull();
    });

    it("merges and returns updated key", async () => {
      const existing = { id: "id4", key: "sk-k", name: "old", machineId: "m", isActive: 1, createdAt: "2024-01-01" };
      getAdapter.mockResolvedValue(makeAdapter({
        get: vi.fn().mockReturnValue(existing),
        run: vi.fn(),
      }));
      const result = await updateApiKey("id4", { name: "new", isActive: false });
      expect(result.name).toBe("new");
      expect(result.isActive).toBe(false);
    });

    it("persists isActive=false as 0 in SQL", async () => {
      const existing = { id: "id5", key: "sk-k", name: "name", machineId: "m", isActive: 1, createdAt: "2024-01-01" };
      const mockRun = vi.fn();
      getAdapter.mockResolvedValue(makeAdapter({
        get: vi.fn().mockReturnValue(existing),
        run: mockRun,
      }));
      await updateApiKey("id5", { isActive: false });
      const isActiveArg = mockRun.mock.calls[0][1][3];
      expect(isActiveArg).toBe(0);
    });
  });

  describe("deleteApiKey", () => {
    it("returns true when a row was deleted", async () => {
      getAdapter.mockResolvedValue(makeAdapter({ run: vi.fn().mockReturnValue({ changes: 1 }) }));
      expect(await deleteApiKey("id")).toBe(true);
    });

    it("returns false when no row matched", async () => {
      getAdapter.mockResolvedValue(makeAdapter({ run: vi.fn().mockReturnValue({ changes: 0 }) }));
      expect(await deleteApiKey("missing")).toBe(false);
    });
  });

  describe("validateApiKey", () => {
    it("returns false when key not in DB", async () => {
      getAdapter.mockResolvedValue(makeAdapter());
      expect(await validateApiKey("unknown")).toBe(false);
    });

    it("returns true when isActive=1", async () => {
      getAdapter.mockResolvedValue(makeAdapter({ get: vi.fn().mockReturnValue({ isActive: 1 }) }));
      expect(await validateApiKey("sk-active")).toBe(true);
    });

    it("returns false when isActive=0", async () => {
      getAdapter.mockResolvedValue(makeAdapter({ get: vi.fn().mockReturnValue({ isActive: 0 }) }));
      expect(await validateApiKey("sk-disabled")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. /api/keys route handlers
// ---------------------------------------------------------------------------

describe("/api/keys route handlers", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /api/keys", () => {
    it("returns { keys } on success", async () => {
      const fakeKeys = [{ id: "1", key: "sk-x", name: "k1", isActive: true }];
      localDb.getApiKeys.mockResolvedValue(fakeKeys);
      const res = await keysGET();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.keys).toEqual(fakeKeys);
    });

    it("returns 500 on DB error", async () => {
      localDb.getApiKeys.mockRejectedValue(new Error("db fail"));
      const res = await keysGET();
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBeDefined();
    });
  });

  describe("POST /api/keys", () => {
    it("returns 400 when name is missing", async () => {
      const req = makeRequest("http://x/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await keysPOST(req);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/name/i);
    });

    it("calls getConsistentMachineId and createApiKey, returns 201", async () => {
      const created = { id: "new-id", key: "sk-m-k-c", name: "mykey", machineId: "machine-id-test" };
      localDb.createApiKey.mockResolvedValue(created);
      const req = makeRequest("http://x/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "mykey" }),
      });
      const res = await keysPOST(req);
      expect(res.status).toBe(201);
      expect(getConsistentMachineId).toHaveBeenCalledOnce();
      expect(localDb.createApiKey).toHaveBeenCalledWith("mykey", "machine-id-test");
      const body = await res.json();
      expect(body.key).toBe(created.key);
      expect(body.name).toBe(created.name);
      expect(body.id).toBe(created.id);
      expect(body.machineId).toBe(created.machineId);
    });

    it("returns 500 on error", async () => {
      localDb.createApiKey.mockRejectedValue(new Error("fail"));
      const req = makeRequest("http://x/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "err" }),
      });
      expect((await keysPOST(req)).status).toBe(500);
    });
  });

  describe("GET /api/keys/[id]", () => {
    it("returns 404 when key not found", async () => {
      localDb.getApiKeyById.mockResolvedValue(null);
      const res = await keyByIdGET(makeRequest("http://x/api/keys/x"), { params: Promise.resolve({ id: "x" }) });
      expect(res.status).toBe(404);
    });

    it("returns 200 with key when found", async () => {
      const fakeKey = { id: "abc", key: "sk-abc", name: "k" };
      localDb.getApiKeyById.mockResolvedValue(fakeKey);
      const res = await keyByIdGET(makeRequest("http://x/api/keys/abc"), { params: Promise.resolve({ id: "abc" }) });
      expect(res.status).toBe(200);
      expect((await res.json()).key).toEqual(fakeKey);
    });

    it("returns 500 on DB error", async () => {
      localDb.getApiKeyById.mockRejectedValue(new Error("fail"));
      const res = await keyByIdGET(makeRequest("http://x/api/keys/err"), { params: Promise.resolve({ id: "err" }) });
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /api/keys/[id]", () => {
    function putReq(id, body) {
      return makeRequest(`http://x/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("returns 404 when key not found", async () => {
      localDb.getApiKeyById.mockResolvedValue(null);
      const res = await keyByIdPUT(putReq("x", { name: "new" }), { params: Promise.resolve({ id: "x" }) });
      expect(res.status).toBe(404);
    });

    it("returns 400 when name is whitespace only", async () => {
      localDb.getApiKeyById.mockResolvedValue({ id: "id", key: "sk-x", name: "old" });
      const res = await keyByIdPUT(putReq("id", { name: "   " }), { params: Promise.resolve({ id: "id" }) });
      expect(res.status).toBe(400);
    });

    it("trims name and calls updateApiKey", async () => {
      const existing = { id: "id", key: "sk-x", name: "old" };
      localDb.getApiKeyById.mockResolvedValue(existing);
      localDb.updateApiKey.mockResolvedValue({ ...existing, name: "trimmed" });
      const res = await keyByIdPUT(putReq("id", { name: "  trimmed  " }), { params: Promise.resolve({ id: "id" }) });
      expect(res.status).toBe(200);
      expect(localDb.updateApiKey).toHaveBeenCalledWith("id", { name: "trimmed" });
    });

    it("updates isActive without requiring name", async () => {
      const existing = { id: "id2", key: "sk-y", name: "k2", isActive: true };
      localDb.getApiKeyById.mockResolvedValue(existing);
      localDb.updateApiKey.mockResolvedValue({ ...existing, isActive: false });
      const res = await keyByIdPUT(putReq("id2", { isActive: false }), { params: Promise.resolve({ id: "id2" }) });
      expect(res.status).toBe(200);
      expect(localDb.updateApiKey).toHaveBeenCalledWith("id2", { isActive: false });
    });
  });

  describe("DELETE /api/keys/[id]", () => {
    it("returns 404 when key not found", async () => {
      localDb.deleteApiKey.mockResolvedValue(false);
      const res = await keyByIdDELETE(makeRequest("http://x/api/keys/x", { method: "DELETE" }), { params: Promise.resolve({ id: "x" }) });
      expect(res.status).toBe(404);
    });

    it("returns 200 with success message when deleted", async () => {
      localDb.deleteApiKey.mockResolvedValue(true);
      const res = await keyByIdDELETE(makeRequest("http://x/api/keys/y", { method: "DELETE" }), { params: Promise.resolve({ id: "y" }) });
      expect(res.status).toBe(200);
      expect((await res.json()).message).toBeDefined();
    });

    it("returns 500 on error", async () => {
      localDb.deleteApiKey.mockRejectedValue(new Error("fail"));
      const res = await keyByIdDELETE(makeRequest("http://x/api/keys/err", { method: "DELETE" }), { params: Promise.resolve({ id: "err" }) });
      expect(res.status).toBe(500);
    });
  });
});
