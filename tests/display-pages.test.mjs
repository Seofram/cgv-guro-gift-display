import assert from "node:assert/strict";
import test from "node:test";
import { buildDisplayPages, paginateNotices } from "../src/display-pages.mjs";

test("gift pages precede notice pages in one ordered sequence", () => {
  for (const count of [1, 2, 3]) {
    const gifts = Array.from({ length: count }, (_, index) => [index]);
    const pages = buildDisplayPages(gifts, ["공지"], true);
    assert.deepEqual(pages.map((page) => page.kind), [...gifts.map(() => "gifts"), "notices"]);
    gifts.forEach((gift, index) => assert.equal(pages[index].groups, gift));
  }
  assert.deepEqual(buildDisplayPages([[], []], ["가", "나", "다", "라"], true).map((p) => p.kind), ["gifts", "gifts", "notices", "notices"]);
});

test("off and empty notices do not add pages", () => {
  assert.equal(buildDisplayPages([[]], ["공지"], false).length, 1);
  assert.equal(buildDisplayPages([[]], [], true).length, 1);
  assert.equal(buildDisplayPages([[]], ["", "  \n"], true).length, 1);
});

test("long notices wrap and continue with bounded readable pages and no lost text", () => {
  const long = "긴 공지입니다. ".repeat(100);
  const pages = paginateNotices([long, "둘째\n공지"]);
  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.ok(page.length <= 3);
    assert.ok(page.reduce((total, entry) => total + entry.lines.length, 0) <= 10);
    page.forEach((entry) => entry.lines.forEach((line) => assert.ok(Array.from(line).length <= 28)));
  }
  assert.equal(pages.flat().filter((entry) => entry.number === 1).flatMap((entry) => entry.lines).join(""), long);
  assert.equal(pages[1][0].continued, true);
});
