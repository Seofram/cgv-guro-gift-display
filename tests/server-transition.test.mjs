import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("uses one lightweight server without Tauri or a runtime Node install", async () => {
  const [packageSource, serverSource, launcher, workflow, html] =
    await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../server/src/main.rs", import.meta.url), "utf8"),
      readFile(new URL("../start-local.bat", import.meta.url), "utf8"),
      readFile(
        new URL("../.github/workflows/windows-desktop.yml", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../server-dist/index.html", import.meta.url), "utf8"),
    ]);

  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.version, "1.4.0");
  assert.equal(packageJson.dependencies["@tauri-apps/api"], undefined);
  assert.equal(packageJson.dependencies.next, undefined);
  assert.equal(packageJson.devDependencies["@tauri-apps/cli"], undefined);
  assert.equal(packageJson.devDependencies.vinext, undefined);
  assert.match(packageJson.scripts["server:check"], /tsconfig\.server\.json/);

  assert.match(serverSource, /TcpListener::bind\(\(HOST, PORT\)\)/);
  assert.match(serverSource, /CGVGiftDisplay/);
  assert.match(serverSource, /inventory\.db/);
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS app_state/);
  assert.match(serverSource, /install_dir\.join\("web"\)/);
  assert.doesNotMatch(serverSource, /Access-Control-Allow-Origin/);
  assert.match(launcher, /start-server\.ps1/i);
  assert.doesNotMatch(launcher, /node|npm|bootstrap/i);
  assert.doesNotMatch(launcher, /(?<!\r)\n/);

  assert.match(html, /<html lang="ko">/i);
  assert.match(workflow, /cargo build --locked --release/);
  assert.match(workflow, /\$limit = 25MB/);
  assert.match(workflow, /startupMs/);
  assert.match(workflow, /inventory\.db/);
  assert.match(workflow, /forbiddenRuntime/);

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
