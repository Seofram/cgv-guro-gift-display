import assert from "node:assert/strict";
import test from "node:test";
import { DATA_LIMITS, validateAppData, validationReplyMessage } from "../src/data-validation.mjs";
import { normalizeAppData } from "../src/schedule.mjs";

const fixture = () => ({ items: [{ id: "a", movie: "영화", format: "전체", gift: "경품",
  status: "available", startDate: "2026-01-01", endDate: "2027-01-01", days: [0], visible: true }],
  settings: { location: "구로", title: "안내", notices: [], pageSeconds: 8, showSoldout: true },
  updatedAt: "2026-11-16T00:00:00.000Z" });

for (const [field, label] of [["movie", "영화명"], ["format", "관람 포맷"], ["gift", "경품명"]]) {
  test(`oversized ${field} is identified without changing the document`, () => {
    const data = fixture(); data.items[0][field] = "가".repeat(DATA_LIMITS.text + 1);
    const original = structuredClone(data);
    assert.match(validateAppData(data), new RegExp(`경품 1번.*${label}.*2000`));
    assert.deepEqual(data, original);
    data.items[0][field] = "수정";
    assert.equal(validateAppData(data), null); // Optional legacy rotateNotices stays valid.
  });
}

test("legacy values over new bounds are preserved for explicit correction", () => {
  const data = fixture();
  data.items = Array.from({ length: 501 }, (_, index) => ({ ...data.items[0], id: String(index) }));
  data.settings.notices = Array.from({ length: 21 }, (_, index) => `공지 ${index}`);
  data.settings.pageSeconds = 7200;
  const normalized = normalizeAppData(data);
  assert.equal(normalized.items.length, 501);
  assert.deepEqual(normalized.settings.notices, data.settings.notices);
  assert.equal(normalized.settings.pageSeconds, 7200);
  assert.match(validateAppData(normalized), /500/);
  normalized.items.pop();
  assert.match(validateAppData(normalized), /20개/);
  normalized.settings.notices.pop();
  assert.match(validateAppData(normalized), /3600/);
});

test("server validation replies map known fields without echoing arbitrary exception details", () => {
  assert.match(validationReplyMessage({ message: "items[2].movie 값이 올바르지 않습니다." }), /경품 3번.*영화명/);
  assert.match(validationReplyMessage({ message: "settings.notices 값이 올바르지 않습니다." }), /주의사항/);
  const internal = "SQLite exception C:\\private\\inventory.db <script>";
  assert.doesNotMatch(validationReplyMessage({ message: internal }), /SQLite|private|script/);
});
