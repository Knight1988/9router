import { NextResponse } from "next/server";
import { getUsers, createUser } from "@/lib/localDb";
import { requireAdmin } from "@/lib/auth/requireRole";

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,32}$/;
const VALID_ROLES = ["admin", "user"];

export async function GET() {
  try {
    await requireAdmin();
    const users = await getUsers();
    return NextResponse.json({ users });
  } catch (e) {
    if (e instanceof NextResponse || e?.status) return e;
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    await requireAdmin();
    const body = await request.json();
    const { username, password, role = "user", displayName } = body;

    if (!username || !USERNAME_REGEX.test(username)) {
      return NextResponse.json({ error: "Username must be 3-32 chars: letters, numbers, _, ., -" }, { status: 400 });
    }
    if (!password || password.length < 4) {
      return NextResponse.json({ error: "Password must be at least 4 characters" }, { status: 400 });
    }
    if (!VALID_ROLES.includes(role)) {
      return NextResponse.json({ error: "Role must be 'admin' or 'user'" }, { status: 400 });
    }

    const user = await createUser({ username, password, role, displayName });
    return NextResponse.json({ user }, { status: 201 });
  } catch (e) {
    if (e instanceof NextResponse || e?.status) return e;
    if (e.message?.includes("UNIQUE constraint")) {
      return NextResponse.json({ error: "Username already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: e.message || "Failed to create user" }, { status: 500 });
  }
}
