import { NextResponse } from "next/server";
import { getUserById, updateUser, updateUserPassword } from "@/lib/localDb";
import { requireAuth } from "@/lib/auth/requireRole";

export async function GET() {
  try {
    const session = await requireAuth();
    const user = await getUserById(session.userId);
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    return NextResponse.json({ user });
  } catch (e) {
    if (e instanceof NextResponse || e?.status) return e;
    return NextResponse.json({ error: "Failed to fetch profile" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const session = await requireAuth();
    const body = await request.json();
    const { displayName, password } = body;

    const updateData = {};
    if (displayName !== undefined) updateData.displayName = displayName;

    let updated = await updateUser(session.userId, updateData);

    if (password && password.length >= 4) {
      updated = await updateUserPassword(session.userId, password);
    }

    return NextResponse.json({ user: updated });
  } catch (e) {
    if (e instanceof NextResponse || e?.status) return e;
    return NextResponse.json({ error: e.message || "Failed to update profile" }, { status: 500 });
  }
}
