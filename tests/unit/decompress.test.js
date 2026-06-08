import { describe, it, expect } from "vitest";
import { decompressResponse } from "../../open-sse/utils/decompress.js";
import { Readable } from "stream";
import zlib from "zlib";

describe("decompressResponse", () => {
  const testPayload = { hello: "world", number: 42, nested: { key: "value" } };
  const testPayloadJson = JSON.stringify(testPayload);

  /**
   * Helper to create a Response with a compressed body
   */
  function createCompressedResponse(encoding, compressFn) {
    const compressed = compressFn(Buffer.from(testPayloadJson));
    const stream = Readable.toWeb(Readable.from([compressed]));
    const headers = new Headers({
      "content-type": "application/json",
      "content-encoding": encoding,
      "content-length": String(compressed.length)
    });
    return new Response(stream, { status: 200, statusText: "OK", headers });
  }

  it("decompresses zstd-encoded response", async () => {
    const response = createCompressedResponse("zstd", zlib.zstdCompressSync);
    const decompressed = await decompressResponse(response);

    // Verify content-encoding and content-length are removed
    expect(decompressed.headers.get("content-encoding")).toBeNull();
    expect(decompressed.headers.get("content-length")).toBeNull();

    // Verify content-type is preserved
    expect(decompressed.headers.get("content-type")).toBe("application/json");

    // Verify body is decompressed and parseable
    const parsed = await decompressed.json();
    expect(parsed).toEqual(testPayload);
  });

  it("decompresses br (brotli) encoded response", async () => {
    const response = createCompressedResponse("br", zlib.brotliCompressSync);
    const decompressed = await decompressResponse(response);

    expect(decompressed.headers.get("content-encoding")).toBeNull();
    const parsed = await decompressed.json();
    expect(parsed).toEqual(testPayload);
  });

  it("decompresses gzip-encoded response", async () => {
    const response = createCompressedResponse("gzip", zlib.gzipSync);
    const decompressed = await decompressResponse(response);

    expect(decompressed.headers.get("content-encoding")).toBeNull();
    const parsed = await decompressed.json();
    expect(parsed).toEqual(testPayload);
  });

  it("decompresses deflate-encoded response", async () => {
    const response = createCompressedResponse("deflate", zlib.deflateSync);
    const decompressed = await decompressResponse(response);

    expect(decompressed.headers.get("content-encoding")).toBeNull();
    const parsed = await decompressed.json();
    expect(parsed).toEqual(testPayload);
  });

  it("passes through identity-encoded response unchanged", async () => {
    const buffer = Buffer.from(testPayloadJson);
    const stream = Readable.toWeb(Readable.from([buffer]));
    const headers = new Headers({
      "content-type": "application/json",
      "content-encoding": "identity"
    });
    const response = new Response(stream, { status: 200, headers });

    const result = await decompressResponse(response);

    // Should return same response when encoding is identity
    expect(result.headers.get("content-encoding")).toBe("identity");
    const parsed = await result.json();
    expect(parsed).toEqual(testPayload);
  });

  it("passes through response with no content-encoding header", async () => {
    const buffer = Buffer.from(testPayloadJson);
    const stream = Readable.toWeb(Readable.from([buffer]));
    const headers = new Headers({ "content-type": "application/json" });
    const response = new Response(stream, { status: 200, headers });

    const result = await decompressResponse(response);

    // Should return same response when no encoding header
    expect(result.headers.get("content-encoding")).toBeNull();
    const parsed = await result.json();
    expect(parsed).toEqual(testPayload);
  });

  it("passes through response with unknown encoding", async () => {
    const buffer = Buffer.from(testPayloadJson);
    const stream = Readable.toWeb(Readable.from([buffer]));
    const headers = new Headers({
      "content-type": "application/json",
      "content-encoding": "unknown-encoding"
    });
    const response = new Response(stream, { status: 200, headers });

    const result = await decompressResponse(response);

    // Should pass through unchanged for unknown encoding
    expect(result.headers.get("content-encoding")).toBe("unknown-encoding");
    const parsed = await result.json();
    expect(parsed).toEqual(testPayload);
  });

  it("handles case-insensitive encoding headers", async () => {
    const response = createCompressedResponse("ZSTD", zlib.zstdCompressSync);
    const decompressed = await decompressResponse(response);

    expect(decompressed.headers.get("content-encoding")).toBeNull();
    const parsed = await decompressed.json();
    expect(parsed).toEqual(testPayload);
  });

  it("preserves response status and statusText", async () => {
    const compressed = zlib.zstdCompressSync(Buffer.from(testPayloadJson));
    const stream = Readable.toWeb(Readable.from([compressed]));
    const headers = new Headers({
      "content-type": "application/json",
      "content-encoding": "zstd"
    });
    const response = new Response(stream, { status: 201, statusText: "Created", headers });

    const decompressed = await decompressResponse(response);

    expect(decompressed.status).toBe(201);
    expect(decompressed.statusText).toBe("Created");
  });
});
