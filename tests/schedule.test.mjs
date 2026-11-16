import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { newItemDates, getScheduleState, isAppDataLike, nextUpdatedAt, normalizeAppData } from "../src/schedule.mjs";

for (const [input, startDate, endDate] of [
  ["2026-09-21T23:45:00", "2026-09-22", "2026-09-29"],
  ["2026-01-31T01:00:00", "2026-02-01", "2026-02-08"],
  ["2026-12-31T23:59:59", "2027-01-01", "2027-01-08"],
  ["2024-02-28T00:01:00", "2024-02-29", "2024-03-07"],
  ["2025-02-28T00:01:00", "2025-03-01", "2025-03-08"],
  ["2026-03-07T23:00:00", "2026-03-08", "2026-03-15"],
]) {
  test(`local calendar defaults at ${input}`, () => {
    const now = new Date(input);
    const original = now.getTime();
    assert.deepEqual(newItemDates(now), { startDate, endDate });
    assert.equal(now.getTime(), original);
  });
}

test("range validation precedes expiry and excludes malformed or incomplete dates", () => {
  const now = new Date(2026, 8, 21, 12);
  const item = { startDate: "2026-09-22", endDate: "2026-09-01", days: [0,1,2,3,4,5,6] };
  for (const range of [item, { ...item, startDate: "" }, { ...item, startDate: "2026-02-30" }, { ...item, endDate: "2026-2-1" }]) {
    assert.deepEqual(getScheduleState(range, now), { active: false, reason: "invalid", label: "기간 오류" });
  }
  assert.equal(getScheduleState({ ...item, startDate: "2026-09-01" }, now).reason, "expired");
  assert.equal(getScheduleState({ ...item, endDate: "2026-09-29" }, now).reason, "upcoming");
  assert.equal(getScheduleState({ ...item, startDate: "2026-09-21", endDate: "2026-09-21" }, now).active, true);
  assert.equal(getScheduleState({ ...item, startDate: "2026-09-21", endDate: "2026-09-21", days: [] }, now).reason, "offday");
});

test("legacy settings normalize without mutating inventory or losing settings", () => {
  const legacy = { items: [{ id: "one" }], settings: { pageSeconds: 8, notices: ["공지"] }, updatedAt: "old" };
  const normalized = normalizeAppData(legacy);
  assert.equal(normalized.settings.rotateNotices, false);
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].id, "one");
  assert.deepEqual(legacy.items, [{ id: "one" }]);
  assert.deepEqual(normalized.settings.notices, ["공지"]);
  assert.equal(normalized.settings.pageSeconds, 8);
  assert.equal(normalized.updatedAt, "old");
  assert.equal(legacy.settings.rotateNotices, undefined);
  assert.equal(normalizeAppData({ ...legacy, settings: { ...legacy.settings, rotateNotices: true } }).settings.rotateNotices, true);
});

test("complete records pass through normalization unchanged", () => {
  const item = { id: "a", movie: "영화", format: "전체", gift: "포스터", status: "low", startDate: "2026-09-01", endDate: "2026-09-30", days: [0, 6], visible: false };
  const data = { items: [item], settings: { location: "구로", title: "경품 안내", notices: ["공지"], pageSeconds: 12, showSoldout: false, rotateNotices: true }, updatedAt: "2026-09-21T00:00:00.000Z" };
  assert.deepEqual(normalizeAppData(data), data);
});

test("malformed stored data is repaired instead of breaking the screens", () => {
  assert.equal(isAppDataLike(null), false);
  assert.equal(isAppDataLike({ items: [], settings: null }), false);
  assert.equal(isAppDataLike({ items: {}, settings: {} }), false);
  assert.equal(isAppDataLike({ items: [], settings: {} }), true);
  const repaired = normalizeAppData({
    items: [null, 7, "x", { id: "dup" }, { id: "dup", status: "bogus", days: "all", visible: "yes" }, { movie: 3, days: [1, 9, "2"] }],
    settings: { notices: "공지", pageSeconds: "8" },
  });
  assert.equal(repaired.items.length, 3);
  assert.equal(new Set(repaired.items.map((item) => item.id)).size, 3);
  for (const item of repaired.items) {
    assert.equal(typeof item.movie, "string");
    assert.equal(item.status, "ready");
    assert.ok(Array.isArray(item.days));
    // Missing dates are invalid, so a repaired row stays off the display.
    assert.equal(getScheduleState(item, new Date(2026, 8, 21, 12)).reason, "invalid");
  }
  assert.deepEqual(repaired.items[2].days, [1]);
  assert.deepEqual(repaired.settings.notices, []);
  assert.equal(repaired.settings.pageSeconds, 8);
  assert.equal(repaired.settings.showSoldout, true);
  assert.equal(repaired.updatedAt, "");
  assert.deepEqual(normalizeAppData(undefined).items, []);
});

test("calendar defaults respect local zones across DST transitions", () => {
  const moduleUrl = new URL("../src/schedule.mjs", import.meta.url).href;
  for (const zone of ["Asia/Seoul", "America/New_York", "Pacific/Auckland"]) {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { newItemDates } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify([
        newItemDates(new Date(2026, 2, 7, 23, 30)),
        newItemDates(new Date(2026, 9, 31, 23, 30))
      ]));
    `], { env: { ...process.env, TZ: zone }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), [
      { startDate: "2026-03-08", endDate: "2026-03-15" },
      { startDate: "2026-11-01", endDate: "2026-11-08" },
    ], zone);
  }
});

test("revisions always move forward, even within one millisecond or after a clock rollback", () => {
  const now = new Date("2026-09-21T03:00:00.000Z");
  assert.equal(nextUpdatedAt("2026-09-20T00:00:00.000Z", now), "2026-09-21T03:00:00.000Z");
  assert.equal(nextUpdatedAt("2026-09-21T03:00:00.000Z", now), "2026-09-21T03:00:00.001Z");
  assert.equal(nextUpdatedAt("2026-09-22T10:00:00.999Z", now), "2026-09-22T10:00:01.000Z");
  assert.equal(nextUpdatedAt(undefined, now), "2026-09-21T03:00:00.000Z");
  assert.equal(nextUpdatedAt("", now), "2026-09-21T03:00:00.000Z");
  let revision = "2026-09-21T03:00:00.000Z";
  for (let index = 0; index < 5; index++) {
    const next = nextUpdatedAt(revision, now);
    assert.ok(next > revision);
    revision = next;
  }
});
