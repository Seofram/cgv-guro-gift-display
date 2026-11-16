// Real packaged PowerShell server + headless Microsoft Edge. The caller owns
// the supplied server PID and supplies a new isolated LOCALAPPDATA directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, expect } from "@playwright/test";

const [serverPid, serverScript] = process.argv.slice(2);
const api = "http://127.0.0.1:3210";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext();
await context.route("https://api.github.com/**", (route) => route.abort());
const first = await context.newPage();
const second = await context.newPage();
const location = (page) => page.getByLabel("지점명", { exact: true });
const title = (page) => page.getByLabel("화면 제목", { exact: true });
const ready = (page) => expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
const stored = async () => (await fetch(`${api}/data`)).json();
let restarted;
try {
  await first.goto(api); await second.goto(api);
  await ready(first); await ready(second);
  const baseline = await stored();
  let held;
  await first.route("**/data", (route) => {
    if (route.request().method() === "POST") { held = route; return; }
    return route.continue();
  });
  await location(first).fill("동시 수정 첫 창");
  await expect.poll(() => Boolean(held)).toBe(true);
  await title(second).fill("동시 수정 둘째 창");
  await expect.poll(async () => (await stored()).data.settings.title).toBe("동시 수정 둘째 창");
  await expect(location(first)).toHaveValue("동시 수정 첫 창");
  assert.equal(held.request().headers()["x-cgv-base-revision"], String(baseline.revision));
  await held.continue();
  await expect(first.getByRole("alertdialog")).toBeVisible();
  await expect(location(first)).toHaveValue("동시 수정 첫 창");
  assert.notEqual((await stored()).data.settings.location, "동시 수정 첫 창");
  await first.unroute("**/data");
  await first.reload(); await ready(first);
  await expect(first.getByRole("alertdialog")).toBeVisible();
  await expect(location(first)).toHaveValue("동시 수정 첫 창");
  await first.getByRole("button", { name: "저장된 최신 내용 사용", exact: true }).click();
  await expect(title(first)).toHaveValue("동시 수정 둘째 창");
  await expect(first.locator(".recovery-list")).toContainText("이 PC에서 수정했지만 저장하지 않은 내용");
  await second.close();
  console.log("  ok  actual CAS rejects overlapping Edge administrators and reload preserves the losing draft");

  // Delay a successful server acknowledgment, then edit again. The first
  // acknowledgment may advance only the submitted snapshot's descendants.
  let reply;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let delay = true;
  await first.route("**/data", async (route) => {
    if (!delay || route.request().method() !== "POST") return route.continue();
    delay = false;
    reply = await route.fetch();
    await gate;
    await route.fulfill({ response: reply });
  });
  await location(first).fill("응답 대기 수정");
  await expect.poll(() => Boolean(reply)).toBe(true);
  await title(first).fill("응답 전에 추가한 수정");
  await expect(first.locator(".save-state")).toHaveText("저장 중…");
  release();
  await expect.poll(async () => (await stored()).data.settings.title).toBe("응답 전에 추가한 수정");
  await expect(first.locator(".save-state")).not.toHaveText("저장 중…");
  await first.unroute("**/data");
  console.log("  ok  real delayed save acknowledgment preserves edits made while the reply is in flight");

  // Kill only the test server PID provided by the harness. Its replacement
  // inherits the same isolated data directory and is always cleaned up here.
  process.kill(Number(serverPid));
  await location(first).fill("서버 중단 중 수정");
  await expect(first.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  await title(first).fill("중단 중 추가 수정");
  restarted = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", serverScript, "-NoOpen"], { windowsHide: true, stdio: "ignore" });
  await expect.poll(async () => {
    try { return (await fetch(`${api}/health`)).ok; } catch { return false; }
  }).toBe(true);
  await expect.poll(async () => (await stored()).data.settings.title,
    { timeout: 10000 }).toBe("중단 중 추가 수정");
  assert.equal((await stored()).data.settings.location, "서버 중단 중 수정");
  console.log("  ok  edits made during a real server process outage persist after restart");

  // A second profile stores a different document while the first cannot save.
  let offline = true;
  await first.route("**/data", (route) => offline && route.request().method() === "POST"
    ? route.abort() : route.continue());
  await location(first).fill("재시도 충돌 로컬");
  await expect(first.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  const competing = await stored();
  competing.data.settings.title = "다른 관리자의 저장";
  const saved = await fetch(`${api}/data`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-CGV-Base-Revision": String(competing.revision),
  }, body: JSON.stringify(competing.data) });
  assert.equal(saved.status, 200);
  offline = false;
  await expect(first.getByRole("alertdialog")).toBeVisible({ timeout: 10000 });
  await expect(location(first)).toHaveValue("재시도 충돌 로컬");
  assert.equal((await stored()).data.settings.title, "다른 관리자의 저장");
  console.log("  ok  real HTTP 409 during outage retry keeps both versions for explicit resolution");
} finally {
  await browser.close();
  if (restarted && restarted.exitCode === null) {
    const exited = new Promise((resolve) => restarted.once("exit", resolve));
    restarted.kill();
    await exited;
  }
}
