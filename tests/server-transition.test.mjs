import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("uses a PowerShell server without unsigned executables or Node", async () => {
  const [packageSource, serverSource, sqliteSource, launcher, workflow, html] =
    await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../scripts/local-server.ps1", import.meta.url), "utf8"),
      readFile(new URL("../scripts/sqlite-store.ps1", import.meta.url), "utf8"),
      readFile(new URL("../start-local.bat", import.meta.url), "utf8"),
      readFile(
        new URL("../.github/workflows/windows-desktop.yml", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../server-dist/index.html", import.meta.url), "utf8"),
    ]);

  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.version, "1.5.1");
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.version, packageJson.version);
  assert.equal(lock.packages[""].version, packageJson.version);
  assert.ok(serverSource.includes(`$script:Version = "${packageJson.version}"`));
  assert.equal(packageJson.dependencies["@tauri-apps/api"], undefined);
  assert.equal(packageJson.dependencies.next, undefined);
  assert.equal(packageJson.devDependencies["@tauri-apps/cli"], undefined);
  assert.equal(packageJson.devDependencies.vinext, undefined);
  assert.match(packageJson.scripts["server:check"], /tsconfig\.server\.json/);

  assert.match(serverSource, /Net\.Sockets\.TcpListener/);
  assert.match(serverSource, /CGVGiftDisplay/);
  assert.match(serverSource, /inventory\.db/);
  assert.match(serverSource, /runtime = "powershell"/);
  assert.match(sqliteSource, /winsqlite3\.dll/);
  assert.match(sqliteSource, /CREATE TABLE IF NOT EXISTS app_state/);
  assert.match(sqliteSource, /INSERT OR REPLACE INTO app_state/);
  // Writes are compare-and-set on a server-managed revision inside one
  // transaction; behaviour is verified by tests/windows/verify-runtime.ps1.
  assert.match(sqliteSource, /BEGIN IMMEDIATE;/);
  assert.match(sqliteSource, /ALTER TABLE app_state ADD COLUMN revision/);
  assert.match(sqliteSource, /sqlite3_backup_init/);
  assert.match(serverSource, /x-cgv-base-revision/);
  assert.match(workflow, /tests\\windows\\verify-runtime\.ps1/);
  assert.doesNotMatch(serverSource, /Access-Control-Allow-Origin/);
  // Request-origin checks and the display heartbeat are exercised against the
  // real server by the Windows workflow; this guards against their removal.
  assert.match(serverSource, /Get-RequestRejection -Request \$Request/);
  assert.match(serverSource, /x-cgv-client/);
  assert.match(sqliteSource, /PRAGMA busy_timeout/);
  // The tag job must publish whether or not the release already exists.
  assert.match(workflow, /gh release upload "\$TAG"/);
  assert.match(workflow, /gh release create "\$TAG"/);
  const [startScript, adminScript, displayScript, processScript] = await Promise.all(
    ["start-server", "open-admin", "display-window", "server-process"].map((name) =>
      readFile(new URL(`../scripts/${name}.ps1`, import.meta.url), "utf8")),
  );
  assert.match(startScript, /"-Supervise"/);
  assert.match(processScript, /-Supervise/);
  // Profile paths may contain spaces; PowerShell 5.1 does not quote arguments.
  assert.match(adminScript, /'--user-data-dir="' \+ \$browser\.AdminProfileDirectory \+ '"'/);
  assert.match(displayScript, /'--user-data-dir="' \+ \$browser\.DisplayProfileDirectory \+ '"'/);
  assert.match(launcher, /start-server\.ps1/i);
  assert.doesNotMatch(launcher, /node|npm|bootstrap/i);
  assert.doesNotMatch(launcher, /(?<!\r)\n/);

  assert.match(html, /<html lang="ko">/i);
  assert.doesNotMatch(workflow, /cargo build|cgv-gift-server\.exe/);
  assert.match(workflow, /\$limit = 10MB/);
  assert.match(workflow, /StartupMs/);
  assert.match(workflow, /forbiddenRuntime/);

  await assert.rejects(
    access(new URL("../server/Cargo.toml", import.meta.url)),
  );
  await assert.rejects(access(new URL("../src-tauri", import.meta.url)));
  await assert.rejects(
    access(new URL("../scripts/display-controller.mjs", import.meta.url)),
  );
});

test("supports Edge and Chrome through one editable settings file", async () => {
  const [settingsSource, browserScript, adminScript, displayScript] =
    await Promise.all([
      readFile(new URL("../browser-settings.json", import.meta.url), "utf8"),
      readFile(new URL("../scripts/browser.ps1", import.meta.url), "utf8"),
      readFile(new URL("../scripts/open-admin.ps1", import.meta.url), "utf8"),
      readFile(new URL("../scripts/display-window.ps1", import.meta.url), "utf8"),
    ]);

  assert.deepEqual(JSON.parse(settingsSource), {
    browser: "edge",
    executablePath: "",
  });
  assert.match(browserScript, /edge.*chrome|chrome.*edge/s);
  assert.match(browserScript, /Google\\Chrome\\Application\\chrome\.exe/);
  assert.match(browserScript, /Microsoft\\Edge\\Application\\msedge\.exe/);
  assert.match(browserScript, /executablePath/);
  assert.match(browserScript, /browser-profile-\$browserName-admin/);
  assert.match(browserScript, /browser-profile-\$browserName-display/);
  assert.match(adminScript, /Get-CgvBrowser/);
  assert.match(displayScript, /Get-CgvBrowser/);
  assert.match(displayScript, /\?view=display/);
  assert.match(displayScript, /--kiosk/);
});
