import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import { getAdapter } from "../driver.js";

const BCRYPT_ROUNDS = 12;

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.displayName,
    oidcSub: row.oidcSub || null,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Internal: includes passwordHash for login verification
function rowToUserInternal(row) {
  if (!row) return null;
  return {
    ...rowToUser(row),
    passwordHash: row.passwordHash || null,
  };
}

export async function getUsers() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM users ORDER BY createdAt ASC`);
  return rows.map(rowToUser);
}

export async function getUserById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE id = ?`, [id]);
  return rowToUser(row);
}

export async function getUserByUsername(username) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE username = ?`, [username]);
  return rowToUserInternal(row);
}

export async function getUserByOidcSub(sub) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM users WHERE oidcSub = ?`, [sub]);
  return rowToUserInternal(row);
}

export async function countAdmins() {
  const db = await getAdapter();
  const row = db.get(`SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND isActive = 1`);
  return row?.cnt || 0;
}

export async function createUser({ username, password, role = "user", displayName, oidcSub }) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const id = uuidv4();
  const passwordHash = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;
  const trimmedName = (displayName || "").trim() || null;

  db.run(
    `INSERT INTO users(id, username, passwordHash, role, displayName, oidcSub, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, username, passwordHash, role, trimmedName, oidcSub || null, 1, now, now]
  );

  return { id, username, role, displayName: trimmedName, oidcSub: oidcSub || null, isActive: true, createdAt: now, updatedAt: now };
}

export async function updateUser(id, data) {
  const db = await getAdapter();
  let result = null;
  await (async () => {
    db.transaction(() => {
      const row = db.get(`SELECT * FROM users WHERE id = ?`, [id]);
      if (!row) return;

      const now = new Date().toISOString();
      const updates = { ...rowToUser(row), updatedAt: now };

      if (data.role !== undefined) updates.role = data.role;
      if (data.displayName !== undefined) updates.displayName = (data.displayName || "").trim() || null;
      if (data.isActive !== undefined) updates.isActive = data.isActive;
      if (data.oidcSub !== undefined) updates.oidcSub = data.oidcSub || null;

      // Password handled separately because it needs async bcrypt
      // For sync transaction, we pass pre-hashed password
      let passwordHash = row.passwordHash;
      if (data.passwordHash !== undefined) passwordHash = data.passwordHash;

      db.run(
        `UPDATE users SET username = ?, passwordHash = ?, role = ?, displayName = ?, oidcSub = ?, isActive = ?, updatedAt = ? WHERE id = ?`,
        [updates.username, passwordHash, updates.role, updates.displayName, updates.oidcSub, updates.isActive ? 1 : 0, updates.updatedAt, id]
      );
      result = { ...updates };
    });
  })();
  return result;
}

// Helper to hash password before calling updateUser (bcrypt is async)
export async function updateUserPassword(id, newPassword) {
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  return updateUser(id, { passwordHash });
}

export async function deleteUser(id) {
  const db = await getAdapter();

  // Check if this is the last admin
  const user = db.get(`SELECT role FROM users WHERE id = ?`, [id]);
  if (user?.role === "admin") {
    const adminCount = db.get(`SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND isActive = 1`);
    if (adminCount?.cnt <= 1) {
      throw new Error("Cannot delete the last admin user");
    }
  }

  const res = db.run(`DELETE FROM users WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function setLastLogin(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE users SET updatedAt = ? WHERE id = ?`, [now, id]);
}
