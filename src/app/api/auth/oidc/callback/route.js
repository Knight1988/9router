import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeOidcCode,
  fetchOidcDiscovery,
  getOidcRuntimeConfig,
  getPublicOrigin,
  pickOidcDisplayName,
  pickOidcEmail,
  verifyOidcIdToken,
} from "@/lib/auth/oidc";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { getUserByOidcSub, createUser, setLastLogin } from "@/lib/localDb";

function clearOidcCookies(cookieStore) {
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
}

// Derive a unique username from OIDC claims
function deriveUsername(email, sub) {
  if (email) {
    // Use email prefix, sanitized
    const prefix = email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 28);
    if (prefix.length >= 3) return prefix;
  }
  // Fallback to sub, sanitized
  const sanitized = (sub || "oidc-user").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 28);
  return sanitized.length >= 3 ? sanitized : `oidc-${sanitized}`;
}

export async function GET(request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, getPublicOrigin(request)));
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(new URL("/login?error=oidc_missing_code", getPublicOrigin(request)));
  }

  const cookieStore = await cookies();
  const storedState = cookieStore.get("oidc_state")?.value;
  const storedNonce = cookieStore.get("oidc_nonce")?.value;
  const codeVerifier = cookieStore.get("oidc_code_verifier")?.value;

  if (!storedState || !storedNonce || !codeVerifier || storedState !== state) {
    clearOidcCookies(cookieStore);
    return NextResponse.redirect(new URL("/login?error=oidc_invalid_state", getPublicOrigin(request)));
  }

  try {
    const config = await getOidcRuntimeConfig();
    if (!config) {
      clearOidcCookies(cookieStore);
      return NextResponse.redirect(new URL("/login?error=oidc_not_configured", getPublicOrigin(request)));
    }

    const discovery = await fetchOidcDiscovery(config.issuerUrl);
    const discoveredIssuer = discovery.issuer || config.issuerUrl;
    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;
    const tokenData = await exchangeOidcCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri,
      codeVerifier,
    });

    if (!tokenData.id_token) {
      throw new Error("OIDC provider did not return an id_token");
    }

    const payload = await verifyOidcIdToken({
      idToken: tokenData.id_token,
      issuer: discoveredIssuer,
      audience: config.clientId,
      jwksUri: discovery.jwks_uri,
      nonce: storedNonce,
    });

    clearOidcCookies(cookieStore);

    const oidcSub = payload.sub || null;
    const oidcEmail = pickOidcEmail(payload) || null;
    const oidcName = pickOidcDisplayName(payload);

    // Find or create user for this OIDC identity
    let user = oidcSub ? await getUserByOidcSub(oidcSub) : null;

    if (!user) {
      // Auto-create user with 'user' role (default for OIDC)
      const username = deriveUsername(oidcEmail, oidcSub);
      try {
        user = await createUser({
          username,
          role: "user",
          displayName: oidcName || null,
          oidcSub,
        });
      } catch (e) {
        // Username collision — append random suffix
        const fallback = `${username}-${Math.random().toString(36).slice(2, 6)}`;
        user = await createUser({
          username: fallback,
          role: "user",
          displayName: oidcName || null,
          oidcSub,
        });
      }
    }

    if (!user.isActive) {
      return NextResponse.redirect(new URL("/login?error=account_disabled", getPublicOrigin(request)));
    }

    await setLastLogin(user.id);
    await setDashboardAuthCookie(cookieStore, request, {
      userId: user.id,
      username: user.username,
      role: user.role,
      oidc: true,
      oidcSub,
      oidcEmail,
      oidcName,
    });

    return NextResponse.redirect(new URL("/dashboard", getPublicOrigin(request)));
  } catch (error) {
    clearOidcCookies(cookieStore);
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message || "oidc_callback_failed")}`, getPublicOrigin(request)));
  }
}
