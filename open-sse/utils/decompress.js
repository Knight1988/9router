import { Readable } from "stream";
import { createZstdDecompress, createBrotliDecompress, createGunzip, createInflate } from "zlib";
import { dbg } from "./debugLog.js";

/**
 * Decompress a Response body if undici left it compressed.
 *
 * undici (Node's fetch) auto-decompresses gzip/deflate/br and strips their
 * content-encoding header. It does NOT decompress zstd — the body is passed
 * through with content-encoding: zstd intact. This helper detects any lingering
 * content-encoding header and decompresses the body via node:zlib.
 *
 * @param {Response} response - The fetch Response to potentially decompress
 * @returns {Promise<Response>} A new Response with decompressed body, or the original if no action needed
 */
export async function decompressResponse(response) {
  const encoding = (response.headers.get("content-encoding") || "").toLowerCase().trim();

  // No encoding or identity → undici already handled it, or no compression
  if (!encoding || encoding === "identity") {
    return response;
  }

  // Map encoding to zlib decompressor
  const decoders = {
    zstd: createZstdDecompress,
    br: createBrotliDecompress,
    gzip: createGunzip,
    deflate: createInflate
  };

  const createDecoder = decoders[encoding];
  if (!createDecoder) {
    dbg("DECOMPRESS", `unknown encoding "${encoding}", passthrough`);
    return response;
  }

  try {
    // Convert web ReadableStream → Node Readable → decompress → web ReadableStream
    const nodeReadable = Readable.fromWeb(response.body);
    const decoder = createDecoder();
    const decompressed = nodeReadable.pipe(decoder);
    const webStream = Readable.toWeb(decompressed);

    // Build new Response with decompressed body
    const newHeaders = new Headers(response.headers);
    newHeaders.delete("content-encoding");
    newHeaders.delete("content-length"); // Length is now wrong after decompression

    dbg("DECOMPRESS", `decoded ${encoding} stream`);
    return new Response(webStream, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  } catch (error) {
    // Decompress failed — return original response so behavior is no worse than before
    dbg("DECOMPRESS", `${encoding} decode failed: ${error.message}, passthrough original`);
    return response;
  }
}
