import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "@knct-log/server-app";

export const MIGRATIONS_DIR = new URL("../../app/migrations/", import.meta.url).pathname;

export function openSqlite(path: string, migrationsDir = MIGRATIONS_DIR): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db, migrationsDir);
  const p = (params: unknown[]) => params as SQLInputValue[];
  return {
    db,
    async all<T>(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...p(params)) as T[];
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (db.prepare(sql).get(...p(params)) as T | undefined) ?? null;
    },
    async run(sql: string, ...params: unknown[]) {
      return { changes: Number(db.prepare(sql).run(...p(params)).changes) };
    },
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        for (const s of stmts) db.prepare(s.sql).run(...p(s.params));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/** D1 と同じマイグレーション SQL を順に適用する */
function migrate(db: DatabaseSync, dir: string) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    db.exec("BEGIN");
    db.exec(readFileSync(join(dir, name), "utf8"));
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    db.exec("COMMIT");
  }
}
