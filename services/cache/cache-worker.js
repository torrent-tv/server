import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statfsSync } from "node:fs";
import { join } from "node:path";

// Keep disk I/O and SQLite's synchronous operations off the signalling thread.
mkdirSync(workerData.directory, { recursive: true });
const db = new DatabaseSync(join(workerData.directory, "cache.sqlite"));
db.exec(`PRAGMA auto_vacuum = INCREMENTAL;
  PRAGMA cache_size = -2048;
  PRAGMA journal_mode = DELETE;
  CREATE TABLE IF NOT EXISTS entries (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL,
    expires INTEGER NOT NULL, accessed INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS entries_access ON entries(accessed);
  CREATE INDEX IF NOT EXISTS entries_expiry ON entries(expires);`);
const pageSize = db.prepare("PRAGMA page_size").get().page_size;
db.exec(`PRAGMA max_page_count = ${Math.floor(workerData.budgetBytes / pageSize)};`);
const read = db.prepare("SELECT value, expires FROM entries WHERE key = ?");
const touch = db.prepare("UPDATE entries SET accessed = ? WHERE key = ?");
const remove = db.prepare("DELETE FROM entries WHERE key = ?");
const size = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM entries");
const oldest = db.prepare("SELECT key, bytes FROM entries ORDER BY accessed, key LIMIT 1");
const insert = db.prepare("INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?, ?)");
const expire = db.prepare("DELETE FROM entries WHERE expires <= ?");

parentPort.on("message", ({ id, method, key, value, ttlMs, now }) => {
  try {
    let result;
    if (method === "get") {
      const row = read.get(key);
      if (row?.expires > now) {
        touch.run(now, key);
        result = JSON.parse(row.value);
      } else if (row) remove.run(key);
    } else if (method === "set") {
      const json = JSON.stringify(value);
      const bytes = Buffer.byteLength(json) + Buffer.byteLength(key);
      result = false;
      if (bytes <= workerData.maxEntryBytes && bytes <= workerData.budgetBytes && ttlMs > 0) {
        expire.run(now);
        remove.run(key);
        let used = size.get().bytes;
        while (used + bytes > workerData.budgetBytes * 0.9) {
          const row = oldest.get();
          if (!row) break;
          remove.run(row.key);
          used -= row.bytes;
        }
        db.exec("PRAGMA incremental_vacuum(256)");
        const fs = statfsSync(workerData.directory);
        if (fs.bavail * fs.bsize >= workerData.reserveBytes + bytes * 2) {
          for (;;) {
            try {
              insert.run(key, json, bytes, now + ttlMs, now);
              result = true;
              break;
            } catch (error) {
              // Page and index overhead can exhaust the physical ceiling
              // before the serialized-value budget. Evict by the same order.
              const row = error.errcode === 13 ? oldest.get() : null;
              if (!row) throw error;
              remove.run(row.key);
            }
          }
        }
      }
    } else if (method === "close") {
      db.close();
      parentPort.postMessage({ id, result: true });
      parentPort.close();
      return;
    }
    parentPort.postMessage({ id, result });
  } catch (error) {
    // Cache failure cannot turn a successful provider response into a refusal.
    parentPort.postMessage({ id, error: error.code ?? "cache-operation-failed" });
  }
});
