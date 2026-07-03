// Migration: Add users table and key ownership (createdBy) column.
// Seeds an initial 'admin' user from legacy single-password settings.
import { v4 as uuidv4 } from "uuid";
import { buildCreateTableSql, TABLES } from "../schema.js";
import { parseJson } from "../helpers/jsonCol.js";

export default {
  version: 2,
  name: "users-and-key-ownership",
  up(db) {
    // 1. Create users table
    if (TABLES.users) {
      db.exec(buildCreateTableSql("users", TABLES.users));
      for (const idx of TABLES.users.indexes || []) {
        try { db.exec(idx); } catch { /* index may already exist */ }
      }
    }

    // 2. Add createdBy column to apiKeys (may already exist via auto-sync)
    try {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN createdBy TEXT`);
    } catch { /* column already exists */ }

    // 3. Create createdBy index
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ak_created_by ON apiKeys(createdBy)`);
    } catch { /* index may already exist */ }

    // 4. Seed initial admin user from legacy settings
    const existingUsers = db.get(`SELECT COUNT(*) as cnt FROM users`);
    if (existingUsers && existingUsers.cnt > 0) return; // already has users

    const now = new Date().toISOString();
    const adminId = uuidv4();

    // Read legacy password hash from settings
    let passwordHash = null;
    try {
      const settingsRow = db.get(`SELECT data FROM settings WHERE id = 1`);
      if (settingsRow) {
        const settings = parseJson(settingsRow.data, {});
        if (settings.password) {
          passwordHash = settings.password;
        }
      }
    } catch { /* no settings yet — fresh install */ }

    // Create admin user
    db.run(
      `INSERT INTO users(id, username, passwordHash, role, displayName, oidcSub, isActive, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId, "admin", passwordHash, "admin", "Administrator", null, 1, now, now]
    );

    // 5. Assign existing keys to the admin user
    db.run(`UPDATE apiKeys SET createdBy = ? WHERE createdBy IS NULL`, [adminId]);
  },
};
