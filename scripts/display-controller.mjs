import { execFile } from "node:child_process";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.CGV_CONTROLLER_PORT || 3210);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const windowScript = join(scriptDirectory, "display-window.ps1");
const runtimeDirectory = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "CGVGiftDisplay")
  : join(scriptDirectory, ".runtime");
const databaseFile = join(runtimeDirectory, "inventory.db");
const legacyDataFile = join(runtimeDirectory, "display-data.json");
const resetMarkerFile = join(runtimeDirectory, "reset-data.flag");
let actionInProgress = false;
let displayExpected = null;
let lastObservedRunning = null;
let displayIncident = null;
let lastSyncAt = null;
let resetRequested = false;

await mkdir(runtimeDirectory, { recursive: true });

const database = new DatabaseSync(databaseFile);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const readStateStatement = database.prepare(
  "SELECT payload, updated_at FROM app_state WHERE id = 1",
);
const writeStateStatement = database.prepare(`
  INSERT INTO app_state (id, payload, updated_at)
  VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    payload = excluded.payload,
    updated_at = excluded.updated_at
`);

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function runWindowAction(action) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        windowScript,
        "-Action",
        action,
      ],
      { windowsHide: true, timeout: 20000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function respond(response, status, payload) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readRequestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isAppData(value) {
  return (
    value &&
    typeof value === "object" &&
    Array.isArray(value.items) &&
    value.settings &&
    typeof value.settings === "object" &&
    typeof value.updatedAt === "string"
  );
}

function readStoredData() {
  const row = readStateStatement.get();
  if (!row) return null;
  const data = JSON.parse(row.payload);
  if (!isAppData(data)) throw new Error("invalid stored data");
  return data;
}

function writeStoredData(data) {
  writeStateStatement.run(JSON.stringify(data), data.updatedAt);
  lastSyncAt = new Date().toISOString();
}

async function initializeStorage() {
  resetRequested = await fileExists(resetMarkerFile);
  if (resetRequested || readStateStatement.get()) return;

  try {
    const legacyData = JSON.parse(await readFile(legacyDataFile, "utf8"));
    if (isAppData(legacyData)) writeStoredData(legacyData);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Legacy data migration failed:", error);
    }
  }
}

await initializeStorage();

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    respond(response, 204, {});
    return;
  }

  if (request.method === "GET" && request.url === "/data") {
    try {
      const storedData = readStoredData();
      if (!storedData) {
        respond(response, 404, {
          ok: false,
          message: "no data",
          reset: resetRequested,
        });
        return;
      }
      respond(response, 200, { ok: true, data: storedData });
    } catch (error) {
      respond(response, 500, { ok: false, message: "data read failed" });
    }
    return;
  }

  if (request.method === "POST" && request.url === "/data") {
    try {
      const nextData = await readRequestJson(request);
      if (!isAppData(nextData)) {
        respond(response, 400, { ok: false, message: "invalid data" });
        return;
      }
      writeStoredData(nextData);
      resetRequested = false;
      await unlink(resetMarkerFile).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      respond(response, 200, { ok: true });
    } catch (error) {
      respond(response, 400, {
        ok: false,
        message:
          error instanceof Error ? error.message : "data write failed",
      });
    }
    return;
  }

  if (request.method === "GET" && request.url === "/display/status") {
    if (actionInProgress) {
      respond(response, 200, {
        controller: true,
        running: Boolean(lastObservedRunning),
        expected: Boolean(displayExpected),
        abnormal: false,
        incidentId: null,
        incidentAt: null,
        lastSyncAt,
      });
      return;
    }

    try {
      const running = (await runWindowAction("Status")) === "running";

      if (displayExpected === null) displayExpected = running;
      if (displayExpected && lastObservedRunning && !running) {
        displayIncident ??= {
          id: String(Date.now()),
          at: new Date().toISOString(),
        };
      }
      if (running) displayIncident = null;
      lastObservedRunning = running;

      if (!lastSyncAt) {
        try {
          lastSyncAt = (await stat(databaseFile)).mtime.toISOString();
        } catch {
          lastSyncAt = null;
        }
      }

      respond(response, 200, {
        controller: true,
        running,
        expected: Boolean(displayExpected),
        abnormal: Boolean(displayExpected && !running && displayIncident),
        incidentId: displayIncident?.id ?? null,
        incidentAt: displayIncident?.at ?? null,
        lastSyncAt,
      });
    } catch (error) {
      respond(response, 500, {
        controller: true,
        running: false,
        expected: Boolean(displayExpected),
        abnormal: false,
        incidentId: null,
        incidentAt: null,
        lastSyncAt,
        message: error instanceof Error ? error.message : "status failed",
      });
    }
    return;
  }

  const match = request.url?.match(/^\/display\/(open|close)$/);
  if (request.method !== "POST" || !match) {
    respond(response, 404, { ok: false });
    return;
  }

  if (actionInProgress) {
    respond(response, 409, { ok: false, message: "busy" });
    return;
  }

  actionInProgress = true;
  try {
    const opening = match[1] === "open";
    const message = await runWindowAction(opening ? "Open" : "Close");
    displayExpected = opening;
    lastObservedRunning = opening;
    displayIncident = null;
    respond(response, 200, { ok: true, message });
  } catch (error) {
    respond(response, 500, {
      ok: false,
      message: error instanceof Error ? error.message : "unknown error",
    });
  } finally {
    actionInProgress = false;
  }
});

server.on("error", (error) => {
  if (error.code !== "EADDRINUSE") process.exitCode = 1;
});

server.listen(PORT, "127.0.0.1");
