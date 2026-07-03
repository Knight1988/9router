import { NextResponse } from "next/server";
import { getUserById, updateUser, updateUserPassword, deleteUser, countAdmins } from "@/lib/localDb";
import { requireAdmin } from "@/lib/auth/requireRole";

const VALID_ROLES = ["admin", "user"];

export async function GET(request, { params }) {
  try {
    await requireAdmin();
    const { id } = await params;
    const user = await getUserById(id);
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    return NextResponse.json({ user });
  } catch (e) {
    if (e instanceof NextResponse || e?.status) return e;
    return NextResponse.json({ error: "Failed to fetch user" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const session = await requireAdmin();
    const { id } = await params;
    const body = await request.json();
    const { role, displayName, isActive, password } = body;

    const existing = await getUserById(id);
    if (!existing) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // Protect last admin
    if (existing.role === "admin" && role === "user") {
      const admins = await countAdmins();
      if (admins <= 1) return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 400 });
    }
    if (existing.role === "admin" && isActive === false) {
      const admins = await countAdmins();
      if (admins <= 1) return NextResponse.json({ error: "Cannot deactivate the last admin" }, { status: 400 });
    }

    const updateData = {};
    if (role !== undefined && VALID_ROLES.includes(role)) updateData.role = role;
    if (displayName !== undefined) updateData.displayName = displayName;
    if (isActive !== undefined) updateData.isActive = isActive;

    let updated = await updateUser(id, updateData);

    // Handle password update separately (async bcrypt)
    if (password && password.length >= 4) {
      updated = await updateUserPassword(id, password);
    }

    return NextResponse.json({ user: updated });
  } catch (e) {
    if (e instanceof NextResponse || e?.status) return e;
    return NextResponse.json({ error: e.message || "Failed to update user" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const session = await requireAdmin();
    const { id } = await params;

    // Prevent self-delete
    if (session.userId === id) {
      return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
    }

    const deleted = await deleteUser(id);
    if (!deleted) return NextResponse.json({ error: "User not found" }, { status: 404 });
    return NextResponse.json({ message: "User deleted successfully" });
  } catch (e) {
    if (e instanceof NextResponse || e?.status) return e;
    return NextResponse.json({ error: e.message || "Failed to delete user" }, { status: 500 });
  }
}
