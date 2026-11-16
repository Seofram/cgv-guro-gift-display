import { test, expect, type Page } from "@playwright/test";

const STORAGE_KEY = "cgv-guro-gift-display-v1";
test.beforeEach(async ({ page }) => {
  // Never depend on the public API in unrelated inventory/browser regressions.
  await page.route("https://api.github.com/**", (route) => route.abort());
});
const item = (id = "one", movie = "영화 A") => ({
  id, movie, format: "전체", gift: `경품 ${id}`, status: "available",
  startDate: "2026-09-01", endDate: "2026-09-30", days: [0,1,2,3,4,5,6], visible: true,
});
const fixture = (count = 1, rotateNotices = false, notices = ["공지 내용을 확인해 주세요."]) => ({
  items: Array.from({ length: count }, (_, index) => item(String(index), `영화 ${index}`)),
  settings: { location: "구로", title: "경품 안내", pageSeconds: 8, showSoldout: true, rotateNotices, notices },
  updatedAt: "2026-09-21T00:00:00.000Z",
});

async function boot(page: Page, data = fixture(), display = false) {
  await page.clock.install({ time: new Date("2026-09-21T12:00:00+09:00") });
  await page.clock.pauseAt(new Date("2026-09-21T12:00:01+09:00"));
  let revision = 1000;
  await page.route("**/data", async (route) => {
    if (route.request().method() === "POST") {
      data = route.request().postDataJSON();
      revision++;
    }
    await route.fulfill({ json: { ok: true, data, revision } });
  });
  await page.route("**/display/status", (route) => route.fulfill({ json: { running: false, expected: false, abnormal: false } }));
  await page.goto(display ? "/?view=display" : "/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  return () => data;
}

test("date drafts survive keyboard editing and Tab; range commits on leaving both fields", async ({ page }) => {
  const saved = await boot(page);
  const start = page.getByLabel("영화 0 시작일");
  const end = page.getByLabel("영화 0 종료일");
  await start.fill("2020-09-01");
  await start.press("ArrowUp");
  await start.fill("2020-09-01");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(saved().items[0].startDate).toBe("2026-09-01");
  // Native date controls expose several keyboard segments before leaving the input.
  for (let index = 0; index < 4 && !(await end.evaluate((el) => el === document.activeElement)); index++) await page.keyboard.press("Tab");
  await expect(end).toBeFocused();
  await end.fill("2020-09-08");
  expect(saved().items[0].endDate).toBe("2026-09-30");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("heading", { name: "경품 데이터" }).click();
  await expect(page.locator(".schedule-badge.expired")).toHaveText("만료 · 미노출");
  expect(saved().items[0].endDate).toBe("2020-09-08");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "만료 항목 정리 (1)" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "나중에" }).click();
  expect(saved().items).toHaveLength(1);
  await page.getByRole("button", { name: "만료 항목 정리 (1)" }).click();
  await page.getByRole("button", { name: "만료 항목 삭제", exact: true }).click();
  await expect(page.locator(".movie-input")).toHaveCount(0);
});

test("invalid dates remain editable, do not become expired, and stay off display", async ({ page }) => {
  const data = fixture();
  data.items[0].endDate = "2026-08-01";
  const saved = await boot(page, data);
  await expect(page.locator(".schedule-badge.invalid")).toHaveText("기간 오류");
  await expect(page.getByRole("button", { name: "만료 항목 정리 (0)" })).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("영화 0 종료일").fill("2026-09-30");
  await page.getByRole("heading", { name: "경품 데이터" }).click();
  await expect(page.locator(".schedule-badge.invalid")).toHaveCount(0);
  expect(saved().items).toHaveLength(1);
  data.items[0].endDate = "2026-08-01";
  await page.route("**/data", (route) => route.fulfill({ json: { ok: true, data } }));
  await page.goto("/?view=display");
  await expect(page.locator(".empty-display")).toBeVisible();
});

test("add focuses and reveals movie field; hydration and remote updates do not steal focus", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  const saved = await boot(page, fixture(12));
  await expect(page.locator(".movie-input:focus")).toHaveCount(0);
  await page.getByRole("button", { name: "+ 항목 추가", exact: true }).click();
  const movie = page.locator(".movie-input").last();
  await expect(movie).toBeFocused();
  await expect(movie).toBeInViewport();
  expect(saved().items.at(-1)?.startDate).toBe("2026-09-22");
  expect(saved().items.at(-1)?.endDate).toBe("2026-09-29");
  await page.getByLabel("지점명", { exact: true }).focus();
  await page.evaluate(({ key, remote }) => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(remote) }));
  }, { key: STORAGE_KEY, remote: { ...saved(), items: [...saved().items, item("remote")] } });
  await expect(page.getByLabel("지점명", { exact: true })).toBeFocused();
  await expect(page.locator(".movie-input")).toHaveCount(13);
});

test("manual ordering, stable trimmed grouping, cursor and responsive day-picker layout remain intact", async ({ page }) => {
  const data = fixture();
  data.items = [item("a", " A "), item("b", "B"), item("c", "A"), item("d", " B ")];
  const saved = await boot(page, data);
  await page.getByRole("button", { name: "B 위로 이동", exact: true }).first().click();
  expect(saved().items.map((value) => value.id)).toEqual(["b", "a", "c", "d"]);
  await page.getByRole("button", { name: "같은 영화 모아 정렬" }).click();
  expect(saved().items.map((value) => value.id)).toEqual(["b", "d", "a", "c"]);
  await page.setViewportSize({ width: 800, height: 700 });
  await page.getByRole("button", { name: "개별 설정" }).first().click();
  await expect(page.locator(".day-picker-row td")).toHaveAttribute("colspan", "9");
  const positions = await page.locator(".admin-table tbody tr").first().evaluate((row) => {
    const date = row.querySelector(".date-range")!.getBoundingClientRect();
    const day = row.querySelector(".day-mode-control")!.getBoundingClientRect();
    return { dateRight: date.right, dayLeft: day.left };
  });
  expect(positions.dateRight).toBeLessThanOrEqual(positions.dayLeft);
  await expect(page.locator(".movie-input").first()).toHaveCSS("cursor", "text");
  await expect(page.locator(".admin-table th").first()).toHaveCSS("cursor", "default");
});

for (const [count, notices, kinds] of [
  [1, ["공지 1"], ["gifts", "notices"]],
  [9, ["공지 1"], ["gifts", "gifts", "notices"]],
  [17, ["공지 1", "공지 2", "공지 3", "공지 4"], ["gifts", "gifts", "gifts", "notices", "notices"]],
] as const) {
  test(`shared page cadence with ${count} gifts and ${notices.length} notices`, async ({ page }) => {
    await boot(page, fixture(count, true, [...notices]), true);
    await expect(page.locator(".display-footer")).toHaveCount(0);
    await expect(page.locator(".page-indicator i")).toHaveCount(kinds.length);
    for (let index = 0; index < kinds.length; index++) {
      await expect(page.locator(".page-indicator i").nth(index)).toHaveClass("active");
      await expect(page.locator(kinds[index] === "gifts" ? ".display-table" : ".notice-page")).toBeVisible();
      await page.clock.fastForward(7999);
      await expect(page.locator(".page-indicator i").nth(index)).toHaveClass("active");
      await page.clock.fastForward(1);
    }
    await expect(page.locator(".page-indicator i").first()).toHaveClass("active");
  });
}

test("legacy data keeps footer behavior; empty notices add no rotation page", async ({ page }) => {
  const data = fixture();
  delete (data.settings as Partial<typeof data.settings>).rotateNotices;
  await boot(page, data, true);
  await expect(page.locator(".display-footer")).toContainText("공지 내용을 확인해 주세요.");
  await expect(page.locator(".notice-page")).toHaveCount(0);
  await page.route("**/data", (route) => route.fulfill({ json: { ok: true, data: fixture(1, true, []) } }));
  await page.reload();
  await expect(page.locator(".display-table")).toBeVisible();
  await expect(page.locator(".page-indicator i")).toHaveCount(0);
});

test("sold-out, hidden and scheduled items retain their visibility rules", async ({ page }) => {
  const data = fixture(5);
  data.items[1].status = "soldout";
  data.items[2].visible = false;
  data.items[3].startDate = "2026-09-22";
  data.items[4].days = [0];
  data.settings.showSoldout = false;
  await boot(page, data, true);
  await expect(page.locator(".display-table tbody tr")).toHaveCount(1);
  data.settings.showSoldout = true;
  data.updatedAt = "2026-09-21T01:00:00.000Z";
  await page.route("**/data", (route) => route.fulfill({ json: { ok: true, data, revision: 2000 } }));
  await page.clock.fastForward(1000);
  await expect(page.locator(".display-table tbody tr")).toHaveCount(2);
});

test("long notice pages fit the canvas and respect reduced motion", async ({ page }) => {
  await boot(page, fixture(1, true, ["긴 공지 내용입니다. ".repeat(80), "두 번째 공지", "세 번째 공지"]), true);
  await page.clock.fastForward(8000);
  await expect(page.locator(".notice-page")).toBeVisible();
  const overflow = await page.locator(".notice-page").evaluate((node) => {
    const box = node.getBoundingClientRect();
    return Array.from(node.querySelectorAll("p > span")).some((line) => {
      const rect = line.getBoundingClientRect();
      return rect.right > box.right || rect.bottom > box.bottom;
    });
  });
  expect(overflow).toBe(false);
  const indicator = await page.locator(".page-indicator").boundingBox();
  const content = await page.locator(".notice-page ul").boundingBox();
  expect(indicator!.y).toBeGreaterThan(content!.y + content!.height);
  await expect(page.locator(".notice-page")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".page-indicator i").first()).toHaveCSS("transition-duration", "0s");
  await page.screenshot({ path: "test-results/notice-page.png" });
});

test("sync clamps page count and changing cadence cleans up the old timer", async ({ page }) => {
  const data = fixture(17, true);
  await boot(page, data, true);
  for (let i = 0; i < 3; i++) await page.clock.fastForward(8000);
  await expect(page.locator(".notice-page")).toBeVisible();
  const remote = fixture(1, true);
  remote.updatedAt = "new-revision";
  remote.settings.pageSeconds = 3;
  await page.route("**/data", (route) => route.fulfill({ json: { ok: true, data: remote, revision: 2000 } }));
  await page.clock.fastForward(1000);
  await expect(page.locator(".page-indicator i")).toHaveCount(2);
  await expect(page.locator(".page-indicator i").nth(1)).toHaveClass("active");
  await page.clock.fastForward(2999);
  await expect(page.locator(".page-indicator i").nth(1)).toHaveClass("active");
  await page.clock.fastForward(1);
  await expect(page.locator(".display-table")).toBeVisible();
  await page.clock.fastForward(3000);
  await expect(page.locator(".notice-page")).toBeVisible();
});

test("legacy localStorage fallback and active drafts survive unrelated synchronization", async ({ page }) => {
  const data = fixture();
  delete (data.settings as Partial<typeof data.settings>).rotateNotices;
  await page.addInitScript(({ data, key }) => localStorage.setItem(key, JSON.stringify(data)), { data, key: STORAGE_KEY });
  // An empty store (404) is the only case where the local copy may seed SQLite;
  // an unreadable store is covered by the failed-read regression below.
  let stored: ReturnType<typeof fixture> | null = null;
  let revision = 0;
  await page.route("**/data", (route) => {
    if (route.request().method() === "POST") {
      stored = route.request().postDataJSON(); revision++;
      return route.fulfill({ json: { ok: true, revision } });
    }
    return stored ? route.fulfill({ json: { ok: true, data: stored, revision } })
      : route.fulfill({ status: 404, json: { ok: false, reset: false } });
  });
  await page.route("**/display/status", (route) => route.fulfill({ json: { running: false } }));
  await page.goto("/");
  await expect(page.getByRole("switch", { name: "공지 순환" })).toHaveAttribute("aria-checked", "false");
  const start = page.getByLabel("영화 0 시작일");
  await start.fill("2026-10-01");
  const remote = fixture();
  remote.items[0].gift = "원격 변경";
  await page.evaluate(({ key, remote }) => window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(remote) })), { key: STORAGE_KEY, remote });
  await expect(start).toBeFocused();
  await expect(start).toHaveValue("2026-10-01");
  await page.getByLabel("영화 0 종료일").fill("2026-10-08");
  await page.getByRole("heading", { name: "경품 데이터" }).click();
  await expect.poll(() => stored?.items[0].startDate).toBe("2026-10-01");
  expect(stored!.items[0].gift).toBe(data.items[0].gift);
  await page.screenshot({ path: "test-results/admin.png", fullPage: true });
});

for (const [response, status] of [
  [{ tag_name: "v1.6.0" }, "업데이트 가능 · v1.6.0"],
  [{ tag_name: "v1.5.1" }, "최신 버전입니다"],
  [{ tag_name: "v1.5.0" }, "최신 버전입니다"],
  [{}, null],
  [null, null],
] as const) {
  test(`release check ${status} leaves inventory functional (${JSON.stringify(response)})`, async ({ page }) => {
    let checks = 0;
    await page.route("https://api.github.com/**", (route) => {
      checks++;
      return response === null ? route.abort() : route.fulfill({ json: response });
    });
    await boot(page);
    await expect(page.locator(".update-check")).toContainText("현재 버전 1.5.1");
    const retry = page.getByRole("button", { name: "업데이트 확인", exact: true });
    await expect(retry).toBeEnabled();
    expect(checks).toBe(1);
    if (status) await expect(page.locator(".update-check")).toContainText(status);
    else await expect(page.locator(".update-check")).toHaveText("현재 버전 1.5.1업데이트 확인");
    await page.getByRole("button", { name: "+ 항목 추가", exact: true }).click();
    await expect(page.locator(".movie-input")).toHaveCount(2);
    expect(checks).toBe(1);
    await retry.click();
    await expect(retry).toBeEnabled();
    expect(checks).toBe(2);
  });
}

test("automatic failure is silent and manual refresh discovers a release", async ({ page }) => {
  let checks = 0;
  await page.route("https://api.github.com/**", (route) => {
    checks++;
    return checks === 1 ? route.fulfill({ status: 429, json: {} }) :
      route.fulfill({ json: { tag_name: "v1.6.0" } });
  });
  await boot(page);
  const retry = page.getByRole("button", { name: "업데이트 확인", exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.locator(".update-check")).toHaveText("현재 버전 1.5.1업데이트 확인");
  await retry.click();
  await expect(page.locator(".update-check")).toContainText("업데이트 가능 · v1.6.0");
  expect(checks).toBe(2);
});

test("pending startup check does not block inventory and times out silently", async ({ page }) => {
  await page.route("https://api.github.com/**", () => {});
  await boot(page);
  await expect(page.getByRole("button", { name: "업데이트 확인 중…" })).toBeDisabled();
  await page.getByRole("button", { name: "+ 항목 추가", exact: true }).click();
  await expect(page.locator(".movie-input")).toHaveCount(2);
  await page.clock.fastForward(3500);
  await expect(page.getByRole("button", { name: "업데이트 확인", exact: true })).toBeEnabled();
  await expect(page.locator(".update-check")).toHaveText("현재 버전 1.5.1업데이트 확인");
});

test("display startup never checks releases", async ({ page }) => {
  let checks = 0;
  await page.route("https://api.github.com/**", (route) => { checks++; return route.abort(); });
  await boot(page, fixture(), true);
  await page.clock.fastForward(30000);
  await expect(page.locator(".display-table")).toBeVisible();
  expect(checks).toBe(0);
});

async function installClock(page: Page) {
  await page.clock.install({ time: new Date("2026-09-21T12:00:00+09:00") });
  await page.clock.pauseAt(new Date("2026-09-21T12:00:01+09:00"));
  await page.route("**/display/status", (route) => route.fulfill({ json: { running: false, expected: false, abnormal: false } }));
}

test("a failed inventory read never saves fallback data and recovers on retry", async ({ page }) => {
  await installClock(page);
  let failing = true;
  let posts = 0;
  await page.route("**/data", (route) => {
    if (route.request().method() === "POST") { posts++; return route.fulfill({ json: { ok: true } }); }
    return failing
      ? route.fulfill({ status: 500, json: { ok: false, message: "database is locked" } })
      : route.fulfill({ json: { ok: true, data: fixture() } });
  });
  await page.goto("/");
  await expect(page.locator(".boot-screen")).toContainText("데이터를 불러오지 못했습니다");
  await expect(page.locator(".movie-input")).toHaveCount(0);
  expect(posts).toBe(0);
  failing = false;
  await page.clock.fastForward(2000);
  await expect(page.locator(".movie-input")).toHaveCount(1);
  await expect(page.locator(".movie-input")).toHaveValue("영화 0");
  // Freshly loaded inventory is not written back to the store.
  expect(posts).toBe(0);
});

test("save failures are visible, retried, and unsaved edits survive a restart", async ({ page }) => {
  await installClock(page);
  let online = true;
  let stored = fixture();
  let revision = 1000;
  await page.route("**/data", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { ok: true, data: stored, revision } });
    if (!online) return route.abort();
    stored = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, revision: ++revision } });
  });
  await page.goto("/");
  await expect(page.locator(".save-state")).toHaveText("자동 저장");
  online = false;
  await page.getByLabel("지점명", { exact: true }).fill("오프라인 수정");
  await expect(page.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  expect(stored.settings.location).toBe("구로");
  // The controller returns with its older copy: the unsaved edit wins and is stored.
  online = true;
  await page.reload();
  await expect(page.getByLabel("지점명", { exact: true })).toHaveValue("오프라인 수정");
  await expect.poll(() => stored.settings.location).toBe("오프라인 수정");
  await expect(page.locator(".save-state")).not.toHaveText("저장 실패 · 재시도 중");
  // Without a restart the same failure heals through the retry timer.
  online = false;
  await page.getByLabel("지점명", { exact: true }).fill("다시 수정");
  await expect(page.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  online = true;
  await page.clock.fastForward(3000);
  await expect.poll(() => stored.settings.location).toBe("다시 수정");
  await expect(page.locator(".save-state")).not.toHaveText("저장 실패 · 재시도 중");
});

test("display windows are read-only and only the real display sends a heartbeat", async ({ page }) => {
  const clients: (string | undefined)[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/data") clients.push(request.headers()["x-cgv-display"]);
  });
  await boot(page, fixture(), true);
  const token = "a".repeat(32);
  await page.goto(`/?view=display&kiosk=${token}`);
  await appReady(page);
  await expect(page).toHaveTitle("CGV 구로 경품 전시 화면");
  await page.clock.fastForward(1000);
  await expect.poll(() => clients.at(-1)).toBe(token);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  // A storage event (administrator edit in the same profile) must not change a display.
  await page.evaluate(({ key, remote }) => window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(remote) })), { key: STORAGE_KEY, remote: fixture(3) });
  await expect(page.locator(".display-table tbody tr")).toHaveCount(1);

  await page.goto("/?view=display&monitor=1");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await expect(page).toHaveTitle("CGV 구로 경품 모니터링");
  clients.length = 0;
  await page.clock.fastForward(1000);
  await expect.poll(() => clients.length).toBeGreaterThan(0);
  expect(clients.every((client) => client === undefined)).toBe(true);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
});

test("malformed stored rows are repaired on both screens instead of blanking them", async ({ page }) => {
  const damaged = { items: [null, 5, { id: "kept" }, item("ok", "정상 영화")], settings: {}, updatedAt: "damaged" } as unknown as ReturnType<typeof fixture>;
  await boot(page, damaged, true);
  await expect(page.locator(".display-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".display-table")).toContainText("정상 영화");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await expect(page.locator(".movie-input")).toHaveCount(2);
  await expect(page.locator(".schedule-badge.invalid")).toHaveText("기간 오류");
});

test("an open display window that stops fetching is reported as unresponsive", async ({ page }) => {
  await boot(page);
  const status = { controller: true, running: true, expected: true, abnormal: false, incidentId: null, incidentAt: null, lastSyncAt: null, responding: true, displaySeenAt: "2026-09-21T03:00:00.000Z" };
  await page.route("**/display/status", (route) => route.fulfill({ json: status }));
  await page.clock.fastForward(5000);
  await expect(page.locator(".monitor-health strong")).toHaveText("전시 창 응답 중");
  status.responding = false;
  await page.clock.fastForward(5000);
  await expect(page.locator(".monitor-health strong")).toHaveText("전시 응답 없음");
  await expect(page.locator(".monitor-health")).toHaveClass(/offline/);
});

test("deletions can be undone and the sample reset asks first", async ({ page }) => {
  const data = fixture(3, false, ["공지 1", "공지 2"]);
  const saved = await boot(page, data);
  const ids = () => saved().items.map((value) => value.id);
  const settled = async (expected: unknown, read: () => unknown) => expect.poll(read).toEqual(expected);

  await page.getByRole("button", { name: "영화 1 삭제", exact: true }).click();
  await settled(["0", "2"], ids);
  await expect(page.locator(".undo-toast")).toContainText("항목 1개를 삭제했습니다.");
  // An edit made before undoing is kept; the row returns to its old position.
  await page.getByLabel("지점명", { exact: true }).fill("신도림");
  await page.getByRole("button", { name: "되돌리기" }).click();
  await settled(["0", "1", "2"], ids);
  expect(saved().settings.location).toBe("신도림");
  await expect(page.locator(".undo-toast")).toHaveCount(0);

  await page.getByRole("button", { name: "주의사항 1 삭제" }).click();
  await settled(["공지 2"], () => saved().settings.notices);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await settled(["공지 1", "공지 2"], () => saved().settings.notices);

  await page.getByRole("button", { name: "예시 데이터로 초기화" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("경품 3개와 주의사항 2개");
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".movie-input")).toHaveCount(3);
  expect(ids()).toEqual(["0", "1", "2"]);
  await page.getByRole("button", { name: "예시 데이터로 초기화" }).click();
  await dialog.getByRole("button", { name: "예시 데이터로 바꾸기" }).click();
  await expect(page.locator(".movie-input")).toHaveCount(8);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await settled(["0", "1", "2"], ids);
  expect(saved().settings.location).toBe("신도림");

  // The toast disappears by itself and can be dismissed.
  await page.getByRole("button", { name: "영화 2 삭제", exact: true }).click();
  await page.clock.fastForward(15000);
  await expect(page.locator(".undo-toast")).toHaveCount(0);
  await settled(["0", "1"], ids);
});

// A stand-in for the controller that enforces the same optimistic-concurrency
// contract as the PowerShell server: every write names the revision it was
// made from and is refused with 409 when that is no longer the stored one.
async function controller(page: Page, initial = fixture()) {
  const state = {
    data: initial,
    revision: 1000,
    online: true,
    dropReplies: 0,
    delayMs: 0,
    posts: [] as { base: string | undefined; status: number }[],
    saveElsewhere(change: (data: ReturnType<typeof fixture>) => void) {
      const next = JSON.parse(JSON.stringify(state.data)) as ReturnType<typeof fixture>;
      change(next);
      next.updatedAt = `2026-09-21T02:00:${String(state.revision % 60).padStart(2, "0")}.000Z`;
      state.data = next;
      state.revision += 1;
    },
  };
  const context = page.context();
  await page.clock.install({ time: new Date("2026-09-21T12:00:00+09:00") });
  await page.clock.pauseAt(new Date("2026-09-21T12:00:01+09:00"));
  await context.route("**/display/status", (route) => route.fulfill({ json: { running: false, expected: false, abnormal: false } }));
  await context.route("**/data", async (route) => {
    const request = route.request();
    if (!state.online) return route.abort();
    if (request.method() !== "POST") return route.fulfill({ json: { ok: true, data: state.data, revision: state.revision } });
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const base = request.headers()["x-cgv-base-revision"];
    if (base === undefined) {
      state.posts.push({ base, status: 428 });
      return route.fulfill({ status: 428, json: { ok: false } });
    }
    if (Number(base) !== state.revision) {
      state.posts.push({ base, status: 409 });
      return route.fulfill({ status: 409, json: { ok: false, conflict: true, revision: state.revision } });
    }
    state.data = request.postDataJSON();
    state.revision += 1;
    state.posts.push({ base, status: 200 });
    if (state.dropReplies > 0) { state.dropReplies--; return route.abort(); }
    return route.fulfill({ json: { ok: true, revision: state.revision } });
  });
  return state;
}
const appReady = (page: Page) => expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
const location = (page: Page) => page.getByLabel("지점명", { exact: true });
const title = (page: Page) => page.getByLabel("화면 제목", { exact: true });

test("a save conflict keeps both versions and waits for the operator to choose", async ({ page }) => {
  const server = await controller(page);
  await page.goto("/");
  await appReady(page);
  server.saveElsewhere((data) => { data.settings.location = "다른 창"; data.items.push(item("x", "다른 창 영화")); });
  await location(page).fill("이 창");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("이 창의 수정 내용을 저장하지 않았습니다");
  await expect(dialog).toContainText("설정이 다름: 지점명");
  await expect(dialog).toContainText("저장된 내용에만 있음: 다른 창 영화");
  // Neither side was touched.
  expect(server.data.settings.location).toBe("다른 창");
  await expect(location(page)).toHaveValue("이 창");

  // Postponing keeps the edits local, keeps editing possible, and never retries the overwrite.
  await dialog.getByRole("button", { name: "나중에 선택" }).click();
  await expect(page.locator(".save-state")).toHaveText("저장 충돌 · 저장 보류");
  await title(page).fill("보류 중 수정");
  await page.clock.fastForward(10000);
  expect(server.data.settings.location).toBe("다른 창");
  expect(server.posts.filter((post) => post.status === 409)).toHaveLength(1);
  expect(server.posts.filter((post) => post.status === 200)).toHaveLength(0);

  // The pending conflict and the unsaved edits survive closing and reopening the window.
  await page.reload();
  await appReady(page);
  await expect(dialog).toBeVisible();
  await expect(location(page)).toHaveValue("이 창");
  await expect(title(page)).toHaveValue("보류 중 수정");
  expect(server.data.settings.location).toBe("다른 창");

  await dialog.getByRole("button", { name: "이 창의 내용으로 저장" }).click();
  await expect.poll(() => server.data.settings.location).toBe("이 창");
  expect(server.data.settings.title).toBe("보류 중 수정");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".save-state")).not.toHaveText("저장 충돌 · 저장 보류");
  const kept = page.locator(".recovery-list li");
  await expect(kept).toHaveCount(1);
  await expect(kept).toContainText("다른 창에서 저장했던 내용");

  // The version that was not chosen can be brought back; what it replaces is kept in turn.
  await kept.getByRole("button", { name: "이 버전으로 복원" }).click();
  await expect.poll(() => server.data.settings.location).toBe("다른 창");
  expect(server.data.items.some((value) => value.id === "x")).toBe(true);
  await expect(kept).toHaveCount(1);
  await expect(kept).toContainText("복원하기 전에 사용하던 내용");
  await kept.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.locator(".recovery-panel")).toHaveCount(0);
});

test("choosing the stored version keeps the unsaved edits recoverable", async ({ page }) => {
  const server = await controller(page);
  await page.goto("/");
  await appReady(page);
  server.saveElsewhere((data) => { data.settings.location = "다른 창"; });
  await location(page).fill("이 창");
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "저장된 최신 내용 사용" }).click();
  await expect(location(page)).toHaveValue("다른 창");
  await expect(dialog).toHaveCount(0);
  expect(server.posts.filter((post) => post.status === 200)).toHaveLength(0);
  const kept = page.locator(".recovery-list li");
  await expect(kept).toContainText("이 PC에서 수정했지만 저장하지 않은 내용");
  await page.reload();
  await appReady(page);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(kept).toHaveCount(1);
  await kept.getByRole("button", { name: "이 버전으로 복원" }).click();
  await expect.poll(() => server.data.settings.location).toBe("이 창");
  // The next edit builds on the adopted revision and is accepted without a conflict.
  await title(page).fill("이어서 수정");
  await expect.poll(() => server.data.settings.title).toBe("이어서 수정");
  expect(server.posts.filter((post) => post.status === 409)).toHaveLength(1);
});

test("rapid edits are saved one at a time and never conflict with themselves", async ({ page }) => {
  const server = await controller(page);
  server.delayMs = 40;
  await page.goto("/");
  await appReady(page);
  await location(page).click();
  const text = "가나다라마바사아자차카타파하";
  for (const character of text) await page.keyboard.insertText(character);
  await expect.poll(() => server.data.settings.location).toBe(`구로${text}`);
  expect(server.posts.every((post) => post.status === 200)).toBe(true);
  // Each request was based on the revision produced by the one before it.
  server.posts.forEach((post, index) => expect(Number(post.base)).toBe(1000 + index));
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("outage edits are retried; a lost reply is not a conflict but a real change is", async ({ page }) => {
  const server = await controller(page);
  await page.goto("/");
  await appReady(page);
  const dialog = page.getByRole("alertdialog");

  // The write is stored but its reply never arrives.
  server.dropReplies = 1;
  await location(page).fill("응답 유실");
  await expect(page.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  expect(server.data.settings.location).toBe("응답 유실");
  await page.clock.fastForward(3000);
  await expect(page.locator(".save-state")).not.toHaveText("저장 실패 · 재시도 중");
  await expect(dialog).toHaveCount(0);
  expect(server.posts.map((post) => post.status)).toEqual([200, 409]);

  // Several edits during an outage arrive as the latest state once the controller returns.
  server.online = false;
  await location(page).fill("장애 중 1");
  await title(page).fill("장애 중 2");
  await expect(page.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  server.online = true;
  await page.clock.fastForward(3000);
  await expect.poll(() => server.data.settings.title).toBe("장애 중 2");
  expect(server.data.settings.location).toBe("장애 중 1");
  await expect(dialog).toHaveCount(0);

  // During another outage a different window saves: the retry must not overwrite it.
  server.online = false;
  await location(page).fill("장애 중 3");
  server.saveElsewhere((data) => { data.settings.location = "다른 창"; });
  server.online = true;
  await page.clock.fastForward(3000);
  await expect(dialog).toBeVisible();
  expect(server.data.settings.location).toBe("다른 창");
  await expect(location(page)).toHaveValue("장애 중 3");
});

test("edits made during an outage survive a restart, with or without a competing change", async ({ page }) => {
  const server = await controller(page);
  await page.goto("/");
  await appReady(page);
  server.online = false;
  await location(page).fill("재시작 전 수정");
  await expect(page.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  // The window is reopened while the controller is still down, then the controller returns.
  await page.reload();
  await expect(page.locator(".boot-screen")).toContainText("데이터를 불러오지 못했습니다");
  server.online = true;
  await page.clock.fastForward(2000);
  await appReady(page);
  await expect(location(page)).toHaveValue("재시작 전 수정");
  await expect.poll(() => server.data.settings.location).toBe("재시작 전 수정");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  // Same again, but another window saved in the meantime.
  server.online = false;
  await location(page).fill("두 번째 수정");
  await expect(page.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  server.saveElsewhere((data) => { data.settings.title = "다른 창 제목"; });
  server.online = true;
  await page.reload();
  await appReady(page);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(location(page)).toHaveValue("두 번째 수정");
  expect(server.data.settings.location).toBe("재시작 전 수정");
  expect(server.data.settings.title).toBe("다른 창 제목");
});

test("two administrator windows of one profile take turns without conflicts", async ({ page }) => {
  const server = await controller(page);
  const second = await page.context().newPage();
  await page.goto("/");
  await second.goto("/");
  await appReady(page);
  await appReady(second);
  await location(page).fill("첫 번째 창");
  await expect.poll(() => server.data.settings.location).toBe("첫 번째 창");
  await expect(location(second)).toHaveValue("첫 번째 창");
  await title(second).fill("두 번째 창");
  await expect.poll(() => server.data.settings.title).toBe("두 번째 창");
  await expect(title(page)).toHaveValue("두 번째 창");
  await location(page).fill("다시 첫 번째 창");
  await expect.poll(() => server.data.settings.location).toBe("다시 첫 번째 창");
  expect(server.data.settings.title).toBe("두 번째 창");
  expect(server.posts.every((post) => post.status === 200)).toBe(true);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(second.getByRole("alertdialog")).toHaveCount(0);
});

test("overlapping administrators keep independent snapshots and dirty storage events cannot replace edits", async ({ page }) => {
  const server = await controller(page);
  const second = await page.context().newPage();
  await page.goto("/"); await second.goto("/");
  await appReady(page); await appReady(second);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route("**/data", async (route) => {
    if (route.request().method() === "POST") { held = true; await gate; }
    await route.fallback();
  });
  await location(page).fill("첫 창의 미저장 내용");
  await expect.poll(() => held).toBe(true);
  await title(second).fill("둘째 창의 제목");
  await expect.poll(() => server.data.settings.title).toBe("둘째 창의 제목");
  await page.evaluate(({ key, remote }) => {
    localStorage.setItem(key, JSON.stringify(remote));
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(remote) }));
  }, { key: STORAGE_KEY, remote: server.data });
  await expect(location(page)).toHaveValue("첫 창의 미저장 내용");
  await expect(title(page)).toHaveValue("경품 안내");
  release();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(server.posts.map((post) => [post.base, post.status])).toEqual([["1000", 200], ["1000", 409]]);
  expect(server.data.settings.location).toBe("구로");
  await expect(location(page)).toHaveValue("첫 창의 미저장 내용");
  await page.reload(); await appReady(page);
  await expect(location(page)).toHaveValue("첫 창의 미저장 내용");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await second.close();
});

test("a clean refresh arriving after a local save cannot roll the administrator back", async ({ page }) => {
  const server = await controller(page);
  await page.goto("/"); await appReady(page);
  const old = JSON.parse(JSON.stringify(server.data));
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/data", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    held = true; await gate;
    await route.fulfill({ json: { ok: true, data: old, revision: 1000 } });
  });
  await page.evaluate(() => {
    const channel = new BroadcastChannel("cgv-guro-gift-display-admin");
    channel.postMessage({ type: "saved", from: "other-window" }); channel.close();
  });
  await expect.poll(() => held).toBe(true);
  await location(page).fill("읽기 대기 중 수정");
  await expect.poll(() => server.data.settings.location).toBe("읽기 대기 중 수정");
  await expect(page.locator(".save-state")).toHaveText("저장됨");
  release();
  await expect(location(page)).toHaveValue("읽기 대기 중 수정");
  await title(page).fill("후속 수정");
  await expect.poll(() => server.data.settings.title).toBe("후속 수정");
  expect(server.posts.every((post) => post.status === 200)).toBe(true);
});

test("save acknowledgments cover only the submitted snapshot and timeout keeps the latest draft", async ({ page }) => {
  const server = await controller(page);
  await page.goto("/"); await appReady(page);
  let held: import("@playwright/test").Route | null = null;
  let block = true;
  await page.route("**/data", (route) => {
    if (block && route.request().method() === "POST") { held = route; return; }
    return route.fallback();
  });
  await location(page).fill("전송 중");
  await expect.poll(() => held !== null).toBe(true);
  await title(page).fill("전송 뒤 수정");
  await expect(page.locator(".save-state")).toHaveText("저장 중…");
  expect(server.data.settings.location).toBe("구로");
  await page.clock.fastForward(8000);
  await expect(page.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  await expect(title(page)).toHaveValue("전송 뒤 수정");
  block = false;
  await page.clock.fastForward(3000);
  await expect.poll(() => server.data.settings.title).toBe("전송 뒤 수정");
  expect(server.data.settings.location).toBe("전송 중");
  await held!.abort().catch(() => undefined);
});

test("sample reset undo expires after a later edit while its old version stays recoverable", async ({ page }) => {
  const server = await controller(page);
  await page.goto("/"); await appReady(page);
  await page.getByRole("button", { name: "예시 데이터로 초기화" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "예시 데이터로 바꾸기" }).click();
  await expect(page.getByRole("button", { name: "되돌리기" })).toBeVisible();
  await location(page).fill("초기화 후 수정");
  await expect(page.getByRole("button", { name: "되돌리기" })).toHaveCount(0);
  await expect.poll(() => server.data.settings.location).toBe("초기화 후 수정");
  expect(server.data.items).toHaveLength(8);
  await expect(page.locator(".recovery-list")).toContainText("예시 데이터로 초기화하기 전의 내용");
});

test("display polling never overlaps and rejects stale sold-out inventory within one server instance", async ({ page }) => {
  await installClock(page);
  let revision = 10;
  let instance = "first";
  let data = fixture();
  let reads = 0;
  let held: import("@playwright/test").Route | null = null;
  let block = false;
  await page.route("**/data", (route) => {
    reads++;
    if (block) { held = route; return; }
    return route.fulfill({ json: { ok: true, data, revision, instance } });
  });
  await page.goto("/?view=display"); await appReady(page);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  revision = 12; data = fixture(); data.items[0].status = "soldout";
  await page.clock.fastForward(1000);
  await expect(page.locator(".display-table")).toContainText("재고 소진");
  revision = 11; data = fixture();
  await page.clock.fastForward(1000);
  await expect(page.locator(".display-table")).toContainText("재고 소진");
  block = true;
  await page.clock.fastForward(1000);
  await expect.poll(() => held !== null).toBe(true);
  const before = reads;
  await page.clock.fastForward(3000);
  expect(reads).toBe(before);
  await held!.fulfill({ json: { ok: true, data, revision: 10, instance } });
  await expect(page.locator(".display-table")).toContainText("재고 소진");
  // A new server process may deliberately serve a restored older backup.
  block = false; instance = "restored"; revision = 5;
  data.items[0].movie = "복원한 영화";
  await page.clock.fastForward(1000);
  await expect(page.locator(".display-table")).toContainText("복원한 영화");
  await page.route("**/data", (route) => route.fulfill({ status: 404,
    json: { ok: false, revision: 0, reset: true, instance: "reset" } }));
  await page.clock.fastForward(1000);
  await expect(page.locator(".empty-display")).toBeVisible();
});

test("opening the kiosk uses persisted data without a second revisionless write", async ({ page }) => {
  const server = await controller(page);
  let opens = 0;
  await page.route("**/display/open", (route) => {
    opens++; return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/"); await appReady(page);
  await page.getByRole("button", { name: /전시 화면 열기/ }).click();
  await expect.poll(() => opens).toBe(1);
  expect(server.posts).toHaveLength(0);
});

test("a full recovery store cannot silently discard local edits during conflict resolution", async ({ page }) => {
  const server = await controller(page);
  await page.goto("/"); await appReady(page);
  server.saveElsewhere((data) => { data.settings.location = "서버 내용"; });
  await location(page).fill("보관해야 할 로컬 내용");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.includes("-recovery-")) throw new DOMException("Full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "저장된 최신 내용 사용", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(location(page)).toHaveValue("보관해야 할 로컬 내용");
  expect(server.data.settings.location).toBe("서버 내용");
});

test("a database reset during retry requires a decision instead of resurrecting old inventory", async ({ page }) => {
  const server = await controller(page);
  await page.goto("/"); await appReady(page);
  server.online = false;
  await location(page).fill("초기화 전 미저장 수정");
  await expect(page.locator(".save-state")).toHaveText("저장 실패 · 재시도 중");
  let posts = 0;
  await page.context().route("**/data", (route) => {
    if (route.request().method() === "POST") {
      posts++; return route.fulfill({ status: 409, json: { ok: false, revision: 0 } });
    }
    return route.fulfill({ status: 404, json: { ok: false, revision: 0, reset: true, instance: "reset" } });
  });
  await page.clock.fastForward(3000);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(location(page)).toHaveValue("초기화 전 미저장 수정");
  await page.clock.fastForward(10000);
  expect(posts).toBe(1);
  await page.reload(); await appReady(page);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(location(page)).toHaveValue("초기화 전 미저장 수정");
});
