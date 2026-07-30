import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the CGV gift display shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ko">/i);
  assert.match(html, /<title>CGV 구로 경품 안내<\/title>/i);
  assert.match(html, /화면을 준비하고 있습니다\./);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("keeps the Windows launcher and display controls in the package", async () => {
  const [page, layout, launcher, bootstrap, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../start-local.bat", import.meta.url), "utf8"),
    readFile(new URL("../scripts/bootstrap-node.ps1", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /title:\s*"CGV 구로 경품 안내"/);
  assert.match(page, /전시 화면 열기/);
  assert.match(page, /모니터링 열기/);
  assert.match(page, /전시 종료/);
  assert.match(launcher, /bootstrap-node\.ps1/i);
  assert.match(bootstrap, /\$nodeVersion = "22\.23\.2"/);
  assert.match(packageJson, /"name": "cgv-guro-gift-display"/);
  assert.match(packageJson, /"version": "1\.0\.0"/);
});
