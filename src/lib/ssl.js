import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function getUserDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const homeDir = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "9router");
  }
  return path.join(homeDir, ".9router");
}

const SSL_DIR = path.join(getUserDataDir(), "ssl");
const UPLOADED_CERT_PATH = path.join(SSL_DIR, "server.crt");
const UPLOADED_KEY_PATH = path.join(SSL_DIR, "server.key");

/**
 * Parse cert info using node:crypto X509Certificate.
 * Falls back gracefully if unavailable.
 */
function parseCertInfoSync(certPem) {
  try {
    // Dynamic require for Node crypto (available in all supported Node versions)
    // eslint-disable-next-line no-undef
    const crypto = require("node:crypto");
    const cert = new crypto.X509Certificate(certPem);
    return {
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      expired: new Date(cert.validTo) < new Date(),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve SSL cert and key from:
 * 1. Env vars SSL_CERT_PATH / SSL_KEY_PATH
 * 2. Uploaded files in DATA_DIR/ssl/
 *
 * Returns { cert, key } (Buffer) or null if not available.
 */
export function getSSLCerts() {
  // Priority 1: explicit env var paths
  const envCertPath = process.env.SSL_CERT_PATH;
  const envKeyPath = process.env.SSL_KEY_PATH;
  if (envCertPath && envKeyPath) {
    try {
      const cert = fs.readFileSync(envCertPath);
      const key = fs.readFileSync(envKeyPath);
      return { cert, key };
    } catch (e) {
      console.error(`[ssl] Failed to read certs from env paths: ${e.message}`);
    }
  }

  // Priority 2: uploaded certs
  if (fs.existsSync(UPLOADED_CERT_PATH) && fs.existsSync(UPLOADED_KEY_PATH)) {
    try {
      const cert = fs.readFileSync(UPLOADED_CERT_PATH);
      const key = fs.readFileSync(UPLOADED_KEY_PATH);
      return { cert, key };
    } catch (e) {
      console.error(`[ssl] Failed to read uploaded certs: ${e.message}`);
    }
  }

  return null;
}

/**
 * Save uploaded cert and key PEM strings to DATA_DIR/ssl/.
 * Validates that both are non-empty PEM strings before saving.
 * Returns { success, certInfo } or throws on validation error.
 */
export function saveUploadedCerts(certPem, keyPem) {
  if (!certPem || typeof certPem !== "string" || !certPem.includes("-----BEGIN")) {
    throw new Error("Invalid certificate: must be a PEM-encoded certificate");
  }
  if (!keyPem || typeof keyPem !== "string" || !keyPem.includes("-----BEGIN")) {
    throw new Error("Invalid private key: must be a PEM-encoded key");
  }

  // Validate cert is parseable
  const certInfo = parseCertInfoSync(certPem);
  if (certInfo === null) {
    // Not a hard failure — cert may still work even if we can't parse metadata
    console.warn("[ssl] Could not parse cert metadata, proceeding anyway");
  }

  if (!fs.existsSync(SSL_DIR)) {
    fs.mkdirSync(SSL_DIR, { recursive: true });
  }

  fs.writeFileSync(UPLOADED_CERT_PATH, certPem, { mode: 0o600 });
  fs.writeFileSync(UPLOADED_KEY_PATH, keyPem, { mode: 0o600 });

  return { success: true, certInfo };
}

/**
 * Remove uploaded certs from DATA_DIR/ssl/.
 */
export function deleteUploadedCerts() {
  let deleted = false;
  if (fs.existsSync(UPLOADED_CERT_PATH)) {
    fs.unlinkSync(UPLOADED_CERT_PATH);
    deleted = true;
  }
  if (fs.existsSync(UPLOADED_KEY_PATH)) {
    fs.unlinkSync(UPLOADED_KEY_PATH);
    deleted = true;
  }
  return { deleted };
}

/**
 * Get SSL status for the API response.
 * Returns whether HTTPS is enabled, whether a cert exists, and cert metadata.
 */
export function getSSLStatus() {
  const httpsEnabled = process.env.HTTPS_ENABLED === "true";

  // Determine cert source
  const hasEnvCerts = !!(process.env.SSL_CERT_PATH && process.env.SSL_KEY_PATH &&
    fs.existsSync(process.env.SSL_CERT_PATH) && fs.existsSync(process.env.SSL_KEY_PATH));
  const hasUploadedCerts = fs.existsSync(UPLOADED_CERT_PATH) && fs.existsSync(UPLOADED_KEY_PATH);
  const hasCert = hasEnvCerts || hasUploadedCerts;

  let certInfo = null;
  let certSource = null;

  if (hasEnvCerts) {
    certSource = "env";
    try {
      certInfo = parseCertInfoSync(fs.readFileSync(process.env.SSL_CERT_PATH, "utf8"));
    } catch { /* ignore */ }
  } else if (hasUploadedCerts) {
    certSource = "uploaded";
    try {
      certInfo = parseCertInfoSync(fs.readFileSync(UPLOADED_CERT_PATH, "utf8"));
    } catch { /* ignore */ }
  }

  return {
    httpsEnabled,
    hasCert,
    certSource,
    certInfo,
    httpsPort: process.env.HTTPS_PORT || process.env.PORT || "20128",
  };
}
