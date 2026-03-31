const tokenCache = new Map(); // installToken → { jwt, expiresAt }

/**
 * Fetch a short-lived JWT from the zunef Claude Code helper auth endpoint.
 * Caches by install token using the JWT's exp claim (or 5-min fallback).
 * @param {string} installToken - Zunef install token (from dashboard)
 * @returns {Promise<string>} JWT to use as x-api-key
 */
export async function getZunefToken(installToken) {
  const cached = tokenCache.get(installToken);
  if (cached && cached.expiresAt > Date.now()) return cached.jwt;

  const res = await fetch(
    `https://claude.zunef.com/api/claude-code/${encodeURIComponent(installToken)}/auth`,
    { headers: { Accept: "text/plain" } }
  );
  if (!res.ok) throw new Error(`Zunef auth failed: HTTP ${res.status}`);
  const jwt = (await res.text()).trim();

  // Decode JWT exp claim for cache TTL (fallback 5 min)
  let expiresAt = Date.now() + 5 * 60 * 1000;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    if (payload.exp) expiresAt = payload.exp * 1000 - 30_000; // 30s before expiry
  } catch {}

  tokenCache.set(installToken, { jwt, expiresAt });
  return jwt;
}
