"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import Toggle from "@/shared/components/Toggle";
import Badge from "@/shared/components/Badge";
import Modal, { ConfirmModal } from "@/shared/components/Modal";
import { useNotificationStore } from "@/store/notificationStore";
import { useAuthStore } from "@/store/authStore";

const ROLE_OPTIONS = [
  { value: "user", label: "User" },
  { value: "admin", label: "Admin" },
];

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,32}$/;

export default function UsersPageClient() {
  const router = useRouter();
  const { role, userId } = useAuthStore();
  const { success, error: notifyError } = useNotificationStore();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ username: "", password: "", role: "user", displayName: "" });
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  // Edit modal
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({ password: "", role: "user", displayName: "", isActive: true });
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Guard: only admins
  useEffect(() => {
    if (role !== null && role !== "admin") {
      router.replace("/dashboard");
    }
  }, [role, router]);

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/users");
      if (!res.ok) throw new Error("Failed to fetch users");
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err) {
      notifyError(err.message);
    } finally {
      setLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    if (role === "admin") fetchUsers();
  }, [role, fetchUsers]);

  // Create user
  const handleCreate = async () => {
    setCreateError("");
    if (!USERNAME_REGEX.test(createForm.username)) {
      setCreateError("Username: 3-32 chars, letters/numbers/_./-");
      return;
    }
    if (!createForm.password || createForm.password.length < 4) {
      setCreateError("Password must be at least 4 characters");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create user");
      success(`User "${createForm.username}" created`);
      setShowCreate(false);
      setCreateForm({ username: "", password: "", role: "user", displayName: "" });
      fetchUsers();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  // Open edit modal
  const openEdit = (user) => {
    setEditUser(user);
    setEditForm({
      password: "",
      role: user.role,
      displayName: user.displayName || "",
      isActive: user.isActive,
    });
    setEditError("");
  };

  // Save edit
  const handleEdit = async () => {
    setEditError("");
    if (editForm.password && editForm.password.length < 4) {
      setEditError("Password must be at least 4 characters");
      return;
    }
    setSaving(true);
    try {
      const body = {
        role: editForm.role,
        displayName: editForm.displayName,
        isActive: editForm.isActive,
      };
      if (editForm.password) body.password = editForm.password;

      const res = await fetch(`/api/users/${editUser.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update user");
      success(`User "${editUser.username}" updated`);
      setEditUser(null);
      fetchUsers();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Delete user
  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/users/${deleteTarget.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete user");
      success(`User "${deleteTarget.username}" deleted`);
      setDeleteTarget(null);
      fetchUsers();
    } catch (err) {
      notifyError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  // Toggle active
  const handleToggleActive = async (user) => {
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update user");
      fetchUsers();
    } catch (err) {
      notifyError(err.message);
    }
  };

  if (role !== "admin") return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-sm text-text-muted mt-1">
            Manage dashboard users and their roles
          </p>
        </div>
        <Button icon="add" onClick={() => setShowCreate(true)}>
          Add User
        </Button>
      </div>

      {/* Users list */}
      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
              <tr>
                <th className="px-6 py-3">Username</th>
                <th className="px-6 py-3">Display Name</th>
                <th className="px-6 py-3">Role</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Created</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">
                        progress_activity
                      </span>
                      Loading…
                    </div>
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-text-muted">
                    No users found.
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id} className="hover:bg-bg-subtle/20 transition-colors">
                    <td className="px-6 py-3 font-medium">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[18px] text-text-muted">
                          person
                        </span>
                        {user.username}
                        {user.id === userId && (
                          <Badge variant="default" size="sm">you</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-text-muted">
                      {user.displayName || "—"}
                    </td>
                    <td className="px-6 py-3">
                      <Badge
                        variant={user.role === "admin" ? "warning" : "default"}
                        size="sm"
                      >
                        {user.role}
                      </Badge>
                    </td>
                    <td className="px-6 py-3">
                      <Toggle
                        size="sm"
                        checked={user.isActive}
                        onChange={() => handleToggleActive(user)}
                        disabled={user.id === userId}
                        title={user.id === userId ? "Cannot deactivate yourself" : user.isActive ? "Active" : "Inactive"}
                      />
                    </td>
                    <td className="px-6 py-3 text-text-muted text-xs">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(user)}
                          className="p-1.5 rounded-lg text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                          title="Edit user"
                        >
                          <span className="material-symbols-outlined text-[18px]">edit</span>
                        </button>
                        <button
                          onClick={() => setDeleteTarget(user)}
                          disabled={user.id === userId}
                          className="p-1.5 rounded-lg text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title={user.id === userId ? "Cannot delete yourself" : "Delete user"}
                        >
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Create Modal */}
      <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title="Create User">
        <div className="flex flex-col gap-3">
          <Input
            label="Username"
            value={createForm.username}
            onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
            placeholder="john.doe"
            autoFocus
          />
          <p className="text-[10px] text-text-muted -mt-2">
            3-32 chars: letters, numbers, _, ., -
          </p>
          <Input
            label="Password"
            type="password"
            value={createForm.password}
            onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
            placeholder="Enter password"
          />
          <Input
            label="Display Name"
            value={createForm.displayName}
            onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })}
            placeholder="John Doe (optional)"
          />
          <div>
            <label className="text-sm font-medium mb-1.5 block">Role</label>
            <Select
              value={createForm.role}
              onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
              options={ROLE_OPTIONS}
            />
          </div>
          {createError && <p className="text-xs text-red-500">{createError}</p>}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={() => setShowCreate(false)} variant="ghost" fullWidth size="sm">
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              fullWidth
              size="sm"
              loading={creating}
              disabled={!createForm.username || !createForm.password}
            >
              Create User
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Modal */}
      <Modal isOpen={!!editUser} onClose={() => setEditUser(null)} title={`Edit User: ${editUser?.username}`}>
        {editUser && (
          <div className="flex flex-col gap-3">
            <Input
              label="Display Name"
              value={editForm.displayName}
              onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })}
              placeholder="Display name (optional)"
              autoFocus
            />
            <Input
              label="New Password"
              type="password"
              value={editForm.password}
              onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
              placeholder="Leave blank to keep current"
            />
            <div>
              <label className="text-sm font-medium mb-1.5 block">Role</label>
              <Select
                value={editForm.role}
                onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                options={ROLE_OPTIONS}
              />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Active</label>
              <Toggle
                checked={editForm.isActive}
                onChange={(checked) => setEditForm({ ...editForm, isActive: checked })}
              />
            </div>
            {editError && <p className="text-xs text-red-500">{editError}</p>}
            <div className="flex flex-col gap-2 pt-1 sm:flex-row">
              <Button onClick={() => setEditUser(null)} variant="ghost" fullWidth size="sm">
                Cancel
              </Button>
              <Button onClick={handleEdit} fullWidth size="sm" loading={saving}>
                Save Changes
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete User"
        message={`Are you sure you want to delete user "${deleteTarget?.username}"? This action cannot be undone.`}
        confirmText={deleting ? "Deleting..." : "Delete"}
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
}
