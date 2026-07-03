import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDashboardAuthPayload } from "./dashboardSession.js";

/**
 * Extract the authenticated user from the request cookies.
 * Returns { userId, username, role } or null.
 */
export async function getSessionUser() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;
    if (!token) return null;
    const payload = await getDashboardAuthPayload(token);
    if (!payload || !payload.authenticated) return null;
    return {
      userId: payload.userId || null,
      username: payload.username || null,
      role: payload.role || "admin", // legacy tokens without role default to admin
    };
  } catch {
    return null;
  }
}

/**
 * Require any authenticated user. Throws NextResponse 401 if not authenticated.
 * Returns { userId, username, role }.
 */
export async function requireAuth() {
  const user = await getSessionUser();
  if (!user) {
    throw NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return user;
}

/**
 * Require admin role. Throws NextResponse 401 if not authenticated, 403 if not admin.
 * Returns { userId, username, role }.
 */
export async function requireAdmin() {
  const user = await requireAuth();
  if (user.role !== "admin") {
    throw NextResponse.json({ error: "Forbidden: admin role required" }, { status: 403 });
  }
  return user;
}
