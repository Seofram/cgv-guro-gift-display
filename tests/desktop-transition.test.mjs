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

  assert.equal(config.version, "1.2.2");
  assert.equal(packageJson.version, config.version);
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
  assert.match(source, /reads_and_updates_legacy_app_state_row/);
  assert.match(source, /mark_frontend_ready/);
  assert.match(source, /selects_a_non_primary_monitor_for_the_display_window/);
  assert.match(source, /should_open_display_on_startup/);
  assert.match(source, /--verify-display/);
});

test("builds and size-checks the NSIS installer on a Windows runner", async () => {
  const [workflow, verificationScript] = await Promise.all([
    readFile(
      new URL("../.github/workflows/windows-desktop.yml", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../scripts/verify-desktop-install.ps1", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /Parser.*ParseFile/s);
  assert.match(workflow, /push:\s*\n\s*branches:/);
  assert.match(workflow, /cargo test --locked/);
  assert.match(workflow, /tauri -- build --bundles nsis/);
  assert.match(workflow, /\$limit = 50MB/);
  assert.match(workflow, /NSIS installation failed/);
  assert.match(workflow, /forbiddenRuntime/);
  assert.match(workflow, /Installed footprint/);
  assert.match(workflow, /Measure-ReadyScreen/);
  assert.match(workflow, /Measure-ReadyScreen \$application 45000/);
  assert.match(workflow, /Measure-ReadyScreen \$application 15000/);
  assert.match(workflow, /MainWindowTitle -eq \$readyTitle/);
  assert.match(workflow, /Get-NetTCPConnection -State Listen/);
  assert.match(workflow, /CGVGiftDisplay\\inventory\.db/);
  assert.match(workflow, /\$warm\.StartupMs -gt 2000/);
  assert.match(workflow, /General hydrated restart:/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /Prepare operating PC verification kit/);
  assert.match(workflow, /verify-desktop-install\.ps1/);
  assert.match(workflow, /README_사용법\.md/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /SHA256SUMS\.txt.*-Encoding utf8/s);
  assert.match(verificationScript, /--verify-display/);
  assert.match(verificationScript, /inventory\.pre-desktop-verification/);
  assert.match(verificationScript, /\$databasePath-wal/);
  assert.match(verificationScript, /\$databasePath-shm/);
  assert.match(verificationScript, /FileShare\]::None/);
  assert.match(verificationScript, /DatabaseBackupFiles/);
  assert.match(verificationScript, /Windows\.Forms\.Screen.*AllScreens/s);
  assert.match(verificationScript, /DisplayFullscreen/);
  assert.match(verificationScript, /ExistingDataConfirmedByOperator/);
  assert.match(verificationScript, /WarmStartupMilliseconds/);
  assert.match(verificationScript, /Warm startup exceeded 2000 ms/);
  assert.match(verificationScript, /Get-NetTCPConnection -State Listen/);
  assert.match(verificationScript, /\$installedBytes -gt 50MB/);
});
