import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const controllerPath = fileURLToPath(
  new URL("../scripts/display-controller.mjs", import.meta.url),
);

async function waitForController(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/data`);
      if (response.status === 200 || response.status === 404) return;
    } catch {
      // The controller is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("controller did not start");
}

async function stopController(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
}

test("creates and reuses the local SQLite data store", async () => {
  const localAppData = await mkdtemp(join(tmpdir(), "cgv-storage-"));
  const port = 34000 + (process.pid % 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const data = {
    items: [],
    settings: {
      location: "구로",
      title: "경품 안내",
      notices: [],
      pageSeconds: 8,
      showSoldout: true,
    },
    updatedAt: "2026-07-31T00:00:00.000Z",
  };

  const startController = async () => {
    const child = spawn(process.execPath, ["--no-warnings", controllerPath], {
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        CGV_CONTROLLER_PORT: String(port),
      },
      stdio: "ignore",
    });
    await waitForController(baseUrl);
    return child;
  };

  let child;
  try {
    child = await startController();

    const emptyResponse = await fetch(`${baseUrl}/data`);
    assert.equal(emptyResponse.status, 404);

    const saveResponse = await fetch(`${baseUrl}/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    assert.equal(saveResponse.status, 200);

    const databasePath = join(
      localAppData,
      "CGVGiftDisplay",
      "inventory.db",
    );
    const header = await readFile(databasePath);
    assert.equal(header.subarray(0, 16).toString("utf8"), "SQLite format 3\0");

    await stopController(child);
    child = await startController();

    const storedResponse = await fetch(`${baseUrl}/data`);
    assert.equal(storedResponse.status, 200);
    const stored = await storedResponse.json();
    assert.deepEqual(stored.data, data);

    await stopController(child);
    child = undefined;

    const dataDirectory = join(localAppData, "CGVGiftDisplay");
    await Promise.all(
      ["inventory.db", "inventory.db-wal", "inventory.db-shm"].map((file) =>
        rm(join(dataDirectory, file), { force: true }),
      ),
    );
    const resetMarker = join(dataDirectory, "reset-data.flag");
    await writeFile(resetMarker, new Date().toISOString(), "utf8");

    child = await startController();
    const resetResponse = await fetch(`${baseUrl}/data`);
    assert.equal(resetResponse.status, 404);
    assert.equal((await resetResponse.json()).reset, true);

    const resetSaveResponse = await fetch(`${baseUrl}/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    assert.equal(resetSaveResponse.status, 200);
    await assert.rejects(access(resetMarker));
  } finally {
    if (child) await stopController(child);
    await rm(localAppData, { recursive: true, force: true });
  }
});
