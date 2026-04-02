/**
 * server-https.js — Custom HTTPS-aware entry point for 9Router.
 *
 * When HTTPS_ENABLED=true and a valid certificate is found, this starts
 * Next.js with HTTPS using a native https.createServer() + Next.js custom server.
 * Falls back to plain HTTP when HTTPS_ENABLED is not set or no cert is found.
 *
 * Certificate resolution order:
 *   1. SSL_CERT_PATH / SSL_KEY_PATH env vars (absolute paths)
 *   2. Uploaded certs in DATA_DIR/ssl/server.crt + server.key
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

// ── DATA_DIR resolution (matches src/lib/ssl.js logic) ──────────────────────
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "9router");
  }
  return path.join(home, ".9router");
}

const SSL_DIR = path.join(getDataDir(), "ssl");
const UPLOADED_CERT = path.join(SSL_DIR, "server.crt");
const UPLOADED_KEY = path.join(SSL_DIR, "server.key");

function resolveSSLCerts() {
  // Priority 1: explicit env var paths
  const envCert = process.env.SSL_CERT_PATH;
  const envKey = process.env.SSL_KEY_PATH;
  if (envCert && envKey) {
    if (fs.existsSync(envCert) && fs.existsSync(envKey)) {
      return { cert: envCert, key: envKey };
    }
    console.warn(`[https] SSL_CERT_PATH/SSL_KEY_PATH set but files not found — falling back`);
  }

  // Priority 2: uploaded certs
  if (fs.existsSync(UPLOADED_CERT) && fs.existsSync(UPLOADED_KEY)) {
    return { cert: UPLOADED_CERT, key: UPLOADED_KEY };
  }

  return null;
}

// ── Next.js standalone server config (copied from .next/standalone/server.js) ─
const dir = path.join(__dirname);
process.env.NODE_ENV = "production";
process.chdir(__dirname);

const currentPort = parseInt(process.env.PORT, 10) || 20128;
const httpsPort = parseInt(process.env.HTTPS_PORT, 10) || 20129;
const hostname = process.env.HOSTNAME || "0.0.0.0";

let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);
if (Number.isNaN(keepAliveTimeout) || !Number.isFinite(keepAliveTimeout) || keepAliveTimeout < 0) {
  keepAliveTimeout = undefined;
}

// Load nextConfig from the standalone server.js (it embeds the full config)
// We re-read it so we don't duplicate the huge config inline.
const standaloneServerPath = path.join(__dirname, "server.js");
let nextConfig;
try {
  // Extract the embedded config from the generated standalone server.js
  // Line format: const nextConfig = {...huge json object on one line...}
  const src = fs.readFileSync(standaloneServerPath, "utf8");
  const match = src.match(/^const nextConfig = (.+)$/m);
  if (match) {
    nextConfig = JSON.parse(match[1]);
  }
} catch {
  // Will be set via env var by the standalone server — fine to leave undefined
}

if (nextConfig) {
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);
}

const https = require("https");
const next = require("next");
const { startServer } = require("next/dist/server/lib/start-server");

const httpsEnabled = process.env.HTTPS_ENABLED === "true";

if (httpsEnabled) {
  const certs = resolveSSLCerts();
  if (certs) {
    console.log(`[https] Starting HTTPS server on port ${httpsPort}`);
    (async () => {
      try {
        const httpsServer = https.createServer({
          key: fs.readFileSync(certs.key),
          cert: fs.readFileSync(certs.cert),
        });

        const app = next({
          dev: false,
          dir,
          conf: nextConfig,
          hostname,
          port: httpsPort,
          httpServer: httpsServer,
        });
        await app.prepare();

        const handler = app.getRequestHandler();
        httpsServer.on("request", handler);

        if (keepAliveTimeout) {
          httpsServer.keepAliveTimeout = keepAliveTimeout;
        }

        httpsServer.listen(httpsPort, hostname, () => {
          console.log(`[https] Server ready on https://${hostname}:${httpsPort}`);

          // Start HTTP→HTTPS redirect server on PORT if different from HTTPS port
          if (httpsPort !== currentPort) {
            const http = require("http");
            const redirectServer = http.createServer((req, res) => {
              const host = (req.headers.host || hostname).replace(/:\d+$/, "");
              const target = `https://${host}:${httpsPort}${req.url}`;
              res.writeHead(301, { Location: target });
              res.end();
            });
            redirectServer.listen(currentPort, hostname, () => {
              console.log(`[https] HTTP→HTTPS redirect: http://${hostname}:${currentPort} → https port ${httpsPort}`);
            });
          }
        });
      } catch (err) {
        console.error("[https] Failed to start HTTPS server:", err);
        process.exit(1);
      }
    })();
  } else {
    // Auto-generate a self-signed cert so HTTPS port is always reachable
    console.warn("[https] HTTPS_ENABLED=true but no certificate found — generating self-signed cert");
    let autoKey, autoCert;
    try {
      const selfsigned = require("selfsigned");
      const attrs = [{ name: "commonName", value: hostname === "0.0.0.0" ? "localhost" : hostname }];
      const pems = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
      autoKey = pems.private;
      autoCert = pems.cert;
    } catch (err) {
      console.error("[https] Failed to generate self-signed cert:", err);
      process.exit(1);
    }

    (async () => {
      try {
        const httpsServer = https.createServer({ key: autoKey, cert: autoCert });
        const app = next({
          dev: false,
          dir,
          conf: nextConfig,
          hostname,
          port: httpsPort,
          httpServer: httpsServer,
        });
        await app.prepare();
        const handler = app.getRequestHandler();
        httpsServer.on("request", handler);
        if (keepAliveTimeout) httpsServer.keepAliveTimeout = keepAliveTimeout;
        httpsServer.listen(httpsPort, hostname, () => {
          console.log(`[https] Server ready on https://${hostname}:${httpsPort} (self-signed cert)`);
          if (httpsPort !== currentPort) {
            const http = require("http");
            const redirectServer = http.createServer((req, res) => {
              const host = (req.headers.host || hostname).replace(/:\d+$/, "");
              res.writeHead(301, { Location: `https://${host}:${httpsPort}${req.url}` });
              res.end();
            });
            redirectServer.listen(currentPort, hostname, () => {
              console.log(`[https] HTTP→HTTPS redirect: http://${hostname}:${currentPort} → https port ${httpsPort}`);
            });
          }
        });
      } catch (err) {
        console.error("[https] Failed to start HTTPS server:", err);
        process.exit(1);
      }
    })();
  }
} else {
  // Default: plain HTTP — same as original server.js behavior
  startServer({
    dir,
    isDev: false,
    config: nextConfig,
    hostname,
    port: currentPort,
    allowRetry: false,
    keepAliveTimeout,
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
