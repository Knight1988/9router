import { createZstdDecompress, createBrotliDecompress, createGunzip, createInflate } from "zlib";
import zlib from "zlib";
import { dbg } from "./debugLog.js";

/**
 * Sniff the actual compression format from the first bytes of a buffer.
 * Providers sometimes lie about content-encoding (e.g. header says "br" but
 * body is actually zstd or plain JSON). Magic bytes tell the truth.
 *
 * @param {Buffer} buf
 * @returns {"zstd"|"gzip"|"deflate"|null}
 */
function sniffEncoding(buf) {
  if (buf.length >= 4 &&
      buf[0] === 0x28 && buf[1] === 0xB5 && buf[2] === 0x2F && buf[3] === 0xFD) {
    return "zstd";
  }
  if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) {
    return "gzip";
  }
  // zlib-wrapped deflate: CMF byte 0x78, FLG byte 0x01/0x9C/0xDA
  if (buf.length >= 2 && buf[0] === 0x78 &&
      (buf[1] === 0x01 || buf[1] === 0x9C || buf[1] === 0xDA)) {
    return "deflate";
  }
  return null; // unknown — likely brotli or plain text/JSON
}

/**
 * Try to decompress a Buffer using the named encoding.
 * Returns decompressed Buffer on success, null on failure.
 *
 * @param {Buffer} buf
 * @param {"zstd"|"gzip"|"deflate"|"deflate-raw"|"br"} encoding
 * @returns {Buffer|null}
 */
function tryDecode(buf, encoding) {
  try {
    switch (encoding) {
      case "zstd":        return zlib.zstdDecompressSync(buf);
      case "gzip":        return zlib.gunzipSync(buf);
      case "deflate":     return zlib.inflateSync(buf);
      case "deflate-raw": return zlib.inflateRawSync(buf);
      case "br":          return zlib.brotliDecompressSync(buf);
      default:            return null;
    }
  } catch {
    return null;
  }
}

/**
 * Decompress a Response body robustly.
 *
 * undici (Node's fetch) auto-decompresses gzip/deflate/br and strips their
 * content-encoding header. It does NOT decompress zstd. This function is
 * called AFTER fetching via undici.request() (raw mode, no auto-decompress),
 * so content-encoding is always preserved and bytes are always raw.
 *
 * Strategy for non-identity encodings:
 *  1. Buffer the entire body
 *  2. Sniff magic bytes → try that decoder first
 *  3. Try header-claimed decoder
 *  4. Try brotli (no reliable magic)
 *  5. Try raw deflate (for bare deflate streams without zlib header)
 *  6. Graceful fallback: use raw bytes as-is
 *     (handles mislabeled plain JSON — header says "br" but body is plain text)
 *
 * @param {Response} response - The fetch Response to potentially decompress
 * @returns {Promise<Response>} A new Response with decompressed body, or the original if no action needed
 */
export async function decompressResponse(response) {
  const encoding = (response.headers.get("content-encoding") || "").toLowerCase().trim();

  // No encoding or identity → no action needed
  if (!encoding || encoding === "identity") {
    return response;
  }

  const knownEncodings = new Set(["zstd", "br", "gzip", "deflate"]);
  if (!knownEncodings.has(encoding)) {
    dbg("DECOMPRESS", `unknown encoding "${encoding}", passthrough`);
    return response;
  }

  // Buffer the body — safe for non-streaming JSON responses
  let raw;
  try {
    raw = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    dbg("DECOMPRESS", `failed to read body: ${err.message}, passthrough`);
    return response;
  }

  // 1. Try sniffed encoding first (magic bytes don't lie)
  const sniffed = sniffEncoding(raw);
  if (sniffed && sniffed !== encoding) {
    dbg("DECOMPRESS", `header="${encoding}" but magic sniff="${sniffed}", trying sniffed first`);
  }

  const candidates = [];
  if (sniffed) candidates.push(sniffed);
  if (encoding !== sniffed) candidates.push(encoding);
  // Brotli has no reliable magic bytes — always try it as a fallback
  if (!candidates.includes("br")) candidates.push("br");
  // Raw deflate (no zlib wrapper) as last-resort before identity fallback
  if (!candidates.includes("deflate-raw")) candidates.push("deflate-raw");

  let decoded = null;
  let usedDecoder = null;
  for (const candidate of candidates) {
    decoded = tryDecode(raw, candidate);
    if (decoded !== null) {
      usedDecoder = candidate;
      break;
    }
  }

  if (decoded !== null) {
    dbg("DECOMPRESS", `decoded via "${usedDecoder}" (header="${encoding}", sniff="${sniffed || "none"}")`);
  } else {
    // Graceful fallback: treat raw bytes as-is (handles mislabeled plain JSON)
    decoded = raw;
    dbg("DECOMPRESS", `all decoders failed for "${encoding}", using raw bytes as-is`);
  }

  const newHeaders = new Headers(response.headers);
  newHeaders.delete("content-encoding");
  newHeaders.delete("content-length"); // no longer valid after decompression

  return new Response(decoded, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}
