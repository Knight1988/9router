import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    createdBy: row.createdBy || null,
  };
}

export async function getApiKeys(filter) {
  const db = await getAdapter();
  if (filter?.userId) {
    const rows = db.all(`SELECT * FROM apiKeys WHERE createdBy = ? ORDER BY createdAt ASC`, [filter.userId]);
    return rows.map(rowToKey);
  }
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id, filter) {
  const db = await getAdapter();
  if (filter?.userId) {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ? AND createdBy = ?`, [id, filter.userId]);
    return rowToKey(row);
  }
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, createdBy) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || null,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, createdBy) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, apiKey.createdBy]
  );
  return apiKey;
}

export async function updateApiKey(id, data, filter) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = filter?.userId
      ? db.get(`SELECT * FROM apiKeys WHERE id = ? AND createdBy = ?`, [id, filter.userId])
      : db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id, filter) {
  const db = await getAdapter();
  if (filter?.userId) {
    const res = db.run(`DELETE FROM apiKeys WHERE id = ? AND createdBy = ?`, [id, filter.userId]);
    return (res?.changes ?? 0) > 0;
  }
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
