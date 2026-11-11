import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Match dns.lookup({ all: true }) exactly: one array, not nested records.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";

// A complete 1x1 PNG, not only the format signature.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=", "base64");
const fetchMock = vi.fn();

function mockFetchOnce(bytes, ok = true) {
  const cancel = vi.fn(async () => {});
  const read = vi.fn()
    .mockResolvedValueOnce({ done: false, value: new Uint8Array(bytes) })
    .mockResolvedValue({ done: true });
  fetchMock.mockResolvedValueOnce({ ok, body: { getReader: () => ({ read, cancel }) } });
  return { read, cancel };
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("fetchImageAsBase64 hardening", () => {
  it("rejects non-http url before DNS or fetch", async () => {
    expect(await fetchImageAsBase64("ftp://x/y.png")).toBeNull();
    expect(await fetchImageAsBase64("data:image/png;base64,xx")).toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["private IPv4", "10.0.0.5", 4],
    ["cloud metadata", "169.254.169.254", 4],
    ["IPv6 loopback", "::1", 6],
  ])("SSRF: rejects %s without fetching", async (_name, address, family) => {
    lookupMock.mockResolvedValue([{ address, family }]);
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("https://internal.example/x.png")).toBeNull();
    expect(lookupMock).toHaveBeenCalledWith("internal.example", { all: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SSRF: rejects blocked hostname localhost before DNS or fetch", async () => {
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("http://localhost/x.png")).toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SSRF: rejects mixed public/private DNS answers without fetching", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("https://example.com/x.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts valid PNG from public host and disables redirects", async () => {
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("https://example.com/a.png")).toEqual({
      mimeType: "image/png",
      url: `data:image/png;base64,${PNG.toString("base64")}`,
    });
    expect(lookupMock).toHaveBeenCalledWith("example.com", { all: true });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://example.com/a.png", expect.objectContaining({
      redirect: "manual",
      signal: expect.any(AbortSignal),
      dispatcher: expect.anything(),
    }));
  });

  it("rejects disguised non-image payload after reading it", async () => {
    const { read } = mockFetchOnce(Buffer.from("<?php system($_GET[c]); ?>"));
    expect(await fetchImageAsBase64("https://example.com/evil.png")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects payload over size cap and cancels the reader", async () => {
    const { read, cancel } = mockFetchOnce(Buffer.alloc(1024));
    expect(await fetchImageAsBase64("https://example.com/big.png", { maxBytes: 100 })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns null when fetch not ok without reading the body", async () => {
    const { read } = mockFetchOnce(PNG, false);
    expect(await fetchImageAsBase64("https://example.com/404.png")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });
});
