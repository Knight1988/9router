import { NextResponse } from "next/server";
import { jwtVerify, SignJWT } from "jose";
import { getSettings } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "9router-default-secret-change-me"
);

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

async function refreshAuthCookie(response, request) {
  try {
    const token = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .sign(SECRET);
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const useSecureCookie =
      process.env.AUTH_COOKIE_SECURE === "true" || forwardedProto === "https";
    response.cookies.set("auth_token", token, {
      httpOnly: true,
      secure: useSecureCookie,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  } catch {
  }
  return response;
}

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

async function hasValidCliToken(request) {
  const token = request.headers.get(CLI_TOKEN_HEADER);
  if (!token) return false;
  return token === await getCliToken();
}

const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
];

const PROTECTED_API_PATHS = [
  "/api/settings",
  "/api/keys",
  "/api/providers/client",
  "/api/provider-nodes/validate",
];

function isLocalRequest(request) {
  const host = request.headers.get("host") || "";
  const hostname = host.split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false) return true;
  return false;
}

export async function proxy(request) {
  const { pathname } = request.nextUrl;
  const isLocal = isLocalRequest(request);

  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if (isLocal || await hasValidCliToken(request)) return NextResponse.next();
    if (await hasValidToken(request)) return refreshAuthCookie(NextResponse.next(), request);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (PROTECTED_API_PATHS.some((p) => pathname.startsWith(p))) {
    if (pathname === "/api/settings/require-login") return NextResponse.next();
    if (isLocal || await hasValidCliToken(request)) return NextResponse.next();
    if (await hasValidToken(request)) return refreshAuthCookie(NextResponse.next(), request);
    if (await isAuthenticated(request)) return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = true;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
          const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
        }
      }
    } catch {
    }

    if (!requireLogin) return NextResponse.next();

    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      try {
        await jwtVerify(token, SECRET);
        return refreshAuthCookie(NextResponse.next(), request);
      } catch {
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/dashboard/:path*"],
};
