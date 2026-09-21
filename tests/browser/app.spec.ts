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
  await page.route("**/data", async (route) => {
    if (route.request().method() === "POST") data = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, data } });
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
  await expect(page.locator(".movie-input")).toHaveCount(14);
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
  await page.route("**/data", (route) => route.fulfill({ json: { ok: true, data } }));
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
  await page.route("**/data", (route) => route.fulfill({ json: { ok: true, data: remote } }));
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
  await page.route("**/data", (route) => route.abort());
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
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY);
  expect(stored.items[0].startDate).toBe("2026-10-01");
  expect(stored.items[0].gift).toBe("원격 변경");
  await page.screenshot({ path: "test-results/admin.png", fullPage: true });
});

for (const [response, status] of [
  [{ tag_name: "v1.6.0" }, "업데이트 가능 · v1.6.0"],
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
    await expect(page.locator(".update-check")).toContainText("현재 버전 1.5.0");
    const retry = page.getByRole("button", { name: "업데이트 확인", exact: true });
    await expect(retry).toBeEnabled();
    expect(checks).toBe(1);
    if (status) await expect(page.locator(".update-check")).toContainText(status);
    else await expect(page.locator(".update-check")).toHaveText("현재 버전 1.5.0업데이트 확인");
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
  await expect(page.locator(".update-check")).toHaveText("현재 버전 1.5.0업데이트 확인");
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
  await expect(page.locator(".update-check")).toHaveText("현재 버전 1.5.0업데이트 확인");
});

test("display startup never checks releases", async ({ page }) => {
  let checks = 0;
  await page.route("https://api.github.com/**", (route) => { checks++; return route.abort(); });
  await boot(page, fixture(), true);
  await page.clock.fastForward(30000);
  await expect(page.locator(".display-table")).toBeVisible();
  expect(checks).toBe(0);
});
