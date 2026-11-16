// SQLite fixtures and cross-checks for the Windows runtime verification.
// Uses Node's built-in SQLite so the PowerShell store is checked by an
// independent implementation.
//
//   node sqlite-fixtures.mjs legacy <db>
//   node sqlite-fixtures.mjs legacy-write <db>
//   node sqlite-fixtures.mjs wal-backup <db> <backup> <sqlite-store.ps1>
//   node sqlite-fixtures.mjs inspect <db>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [, , command, databasePath, ...rest] = process.argv;

// ASCII-only output: Windows PowerShell 5.1 reads child output in the console
// code page, so non-ASCII text is written as JSON unicode escapes.
const print = (value) => console.log(JSON.stringify(value).replace(
  /[^\x20-\x7e]/g,
  (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
));

const payload = (location, updatedAt, gift = "포스터") => JSON.stringify({
  items: [{
    id: "legacy-1", movie: "기존 영화", format: "전체", gift, status: "available",
    startDate: "2026-01-01", endDate: "2027-12-31", days: [0, 1, 2, 3, 4, 5, 6], visible: true,
  }],
  settings: { location, title: "경품 안내", notices: ["기존 공지"], pageSeconds: 8, showSoldout: true },
  updatedAt,
});

// The exact schema and statement used by v1.5.0 and earlier.
const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`;
const LEGACY_WRITE = "INSERT OR REPLACE INTO app_state (id, payload, updated_at) VALUES (1, ?, ?)";

function inspect(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = database.prepare("PRAGMA table_info(app_state)").all().map((column) => column.name);
    const row = database.prepare(
      `SELECT payload, updated_at${columns.includes("revision") ? ", revision" : ""} FROM app_state WHERE id = 1`,
    ).get();
    return {
      integrity: database.prepare("PRAGMA integrity_check").get().integrity_check,
      journalMode: database.prepare("PRAGMA journal_mode").get().journal_mode,
      columns,
      revision: row?.revision ?? null,
      updatedAt: row?.updated_at ?? null,
      data: row ? JSON.parse(row.payload) : null,
    };
  } finally {
    database.close();
  }
}

if (command === "legacy") {
  // A database exactly as v1.5.0 leaves it: WAL mode, no revision column.
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;" + LEGACY_SCHEMA);
  database.prepare(LEGACY_WRITE).run(payload("구로", "2026-08-01T00:00:00.000Z"), "2026-08-01T00:00:00.000Z");
  database.close();
  print(inspect(databasePath));
} else if (command === "legacy-write") {
  // What a v1.5.0 server does to a database that v1.5.1 has already migrated
  // (a downgrade): its statement names no revision column.
  const database = new DatabaseSync(databasePath);
  database.exec(LEGACY_SCHEMA);
  database.prepare(LEGACY_WRITE).run(payload("다운그레이드", "2026-08-20T00:00:00.000Z"), "2026-08-20T00:00:00.000Z");
  database.close();
  print(inspect(databasePath));
} else if (command === "wal-backup") {
  // Commits transactions that exist only in the write-ahead log (the reader
  // below keeps the log from being folded into the main file), then asks the
  // PowerShell store for a backup and checks that the backup has them.
  const [backupPath, storeScript] = rest;
  const writer = new DatabaseSync(databasePath);
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;" + LEGACY_SCHEMA);
  writer.prepare(LEGACY_WRITE).run(payload("체크포인트 이전", "2026-08-01T00:00:00.000Z"), "2026-08-01T00:00:00.000Z");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const mainSizeBefore = statSync(databasePath).size;
  for (let index = 1; index <= 25; index++) {
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare(LEGACY_WRITE).run(
      payload("WAL에만 있는 최신값", `2026-08-02T00:00:${String(index).padStart(2, "0")}.000Z`, `경품 ${index} ${"가".repeat(400)}`),
      `2026-08-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    );
    writer.exec("COMMIT");
  }
  const walSize = existsSync(databasePath + "-wal") ? statSync(databasePath + "-wal").size : 0;
  const mainSizeDuring = statSync(databasePath).size;
  // The newest row must not be in the main file yet: it exists only in the log.
  const mainFileLacksLatest = !readFileSync(databasePath).includes(Buffer.from("2026-08-02T00:00:25"));
  execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `$ErrorActionPreference = 'Stop'; . '${storeScript}'; Backup-CgvData -DatabasePath '${databasePath}' -Destination '${backupPath}'`,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  const walStillPending = existsSync(databasePath + "-wal") ? statSync(databasePath + "-wal").size : 0;
  writer.close();
  print({
    walBytesWhenBackedUp: walSize,
    mainFileUnchangedByWalWrites: mainSizeBefore === mainSizeDuring && mainFileLacksLatest,
    walStillPendingAfterBackup: walStillPending > 0,
    backupHasCompanionFiles: existsSync(backupPath + "-wal") || existsSync(backupPath + "-shm") || existsSync(backupPath + ".tmp"),
    backup: inspect(backupPath),
    source: inspect(databasePath),
  });
} else if (command === "inspect") {
  print(inspect(databasePath));
} else {
  console.error("unknown command");
  process.exit(2);
}
