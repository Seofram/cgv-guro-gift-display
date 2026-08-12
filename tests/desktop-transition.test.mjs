import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("configures the lightweight Tauri desktop shell", async () => {
  const [configSource, packageSource, capabilitySource, indexSource] =
    await Promise.all([
      readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(
        new URL("../src-tauri/capabilities/default.json", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../index.html", import.meta.url), "utf8"),
    ]);

  const config = JSON.parse(configSource);
  const packageJson = JSON.parse(packageSource);
  const capability = JSON.parse(capabilitySource);

  assert.equal(config.build.frontendDist, "../desktop-dist");
  assert.deepEqual(config.bundle.targets, ["nsis"]);
  assert.equal(config.bundle.windows.webviewInstallMode.type, "embedBootstrapper");
  assert.match(packageJson.scripts["desktop:build"], /vite build/);
  assert.match(packageJson.scripts.tauri, /tauri/);
  assert.deepEqual(capability.windows, ["main", "display", "monitor-preview"]);
  assert.match(indexSource, /src\/main\.tsx/);
});

test("keeps the legacy SQLite location and adds native display commands", async () => {
  const source = await readFile(
    new URL("../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );

  assert.match(source, /var_os\("LOCALAPPDATA"\)/);
  assert.match(source, /CGVGiftDisplay/);
  assert.match(source, /inventory\.db/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS app_state/);
  assert.match(source, /open_display_window/);
  assert.match(source, /inventory-updated/);
});

test("builds and size-checks the NSIS installer on a Windows runner", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/windows-desktop.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /push:\s*\n\s*branches:/);
  assert.match(workflow, /cargo check --locked/);
  assert.match(workflow, /tauri -- build --bundles nsis/);
  assert.match(workflow, /\$limit = 50MB/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});
