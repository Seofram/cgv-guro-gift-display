import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { newItemDates, getScheduleState, normalizeAppData } from "../src/schedule.mjs";

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
  assert.equal(normalized.items, legacy.items);
  assert.equal(normalized.updatedAt, "old");
  assert.equal(legacy.settings.rotateNotices, undefined);
  assert.equal(normalizeAppData({ ...legacy, settings: { ...legacy.settings, rotateNotices: true } }).settings.rotateNotices, true);
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
