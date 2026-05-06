const isBun = typeof globalThis.Bun !== "undefined";

function openDatabase(path, options = {}) {
  if (isBun) {
    return openBunSqlite(path, options);
  } else {
    return openBetterSqlite3(path, options);
  }
}

function openBunSqlite(path, options) {
  const { Database } = Function('return require("bun:sqlite")')();
  
  const bunDb = new Database(path, {
    readonly: options.readonly || false,
    create: options.fileMustExist ? false : true,
  });

  return {
    prepare(sql) {
      const stmt = bunDb.prepare(sql);
      return {
        run(params) {
          return stmt.run(params);
        },
        get(params) {
          return stmt.get(params);
        },
        all(params) {
          return stmt.all(params);
        },
      };
    },

    exec(sql) {
      bunDb.exec(sql);
    },

    pragma(expr) {
      if (expr.includes("=")) {
        bunDb.run(`PRAGMA ${expr}`);
        return undefined;
      } else {
        return bunDb.query(`PRAGMA ${expr}`).all();
      }
    },

    transaction(fn) {
      return bunDb.transaction(fn);
    },

    close() {
      bunDb.close();
    },
  };
}

function openBetterSqlite3(path, options) {
  const Database = Function('return require("better-sqlite3")')();
  const db = new Database(path, options);

  return {
    prepare(sql) {
      return db.prepare(sql);
    },

    exec(sql) {
      return db.exec(sql);
    },

    pragma(expr) {
      return db.pragma(expr);
    },

    transaction(fn) {
      return db.transaction(fn);
    },

    close() {
      return db.close();
    },
  };
}

export { openDatabase };
