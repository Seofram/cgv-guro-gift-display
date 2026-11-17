import assert from "node:assert/strict";
import test from "node:test";
import { buildDisplayPages, paginateNotices, wrapNoticeParagraph } from "../src/display-pages.mjs";

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

test("notice lines break between words, never inside one or before punctuation", () => {
  // A stand-in for the measured width: 20 visible characters per line.
  const fits = (text) => Array.from(text.replace(/\s+$/, "")).length <= 20;
  const notice = "당일 CGV 구로 관람 티켓에 한해 수령 가능합니다. 경품 수령 후 교환은 불가합니다.";
  const lines = wrapNoticeParagraph(notice, fits);
  assert.equal(lines.join(""), notice);
  assert.ok(lines.length > 1);
  const words = new Set(notice.split(" "));
  for (const line of lines) {
    assert.ok(fits(line));
    assert.doesNotMatch(line, /^[\s.,)]/);
    for (const word of line.trim().split(" ")) assert.ok(words.has(word), `"${word}" is a whole word`);
  }
  assert.deepEqual(wrapNoticeParagraph("Lucky draw gifts are limited. Please show your ticket.", fits),
    ["Lucky draw gifts are ", "limited. Please show ", "your ticket."]);
});

test("a single word wider than a line is split, and nothing is lost", () => {
  const fits = (text) => Array.from(text.replace(/\s+$/, "")).length <= 5;
  assert.deepEqual(wrapNoticeParagraph("가나다라마바사아자차카타 끝", fits), ["가나다라마", "바사아자차", "카타 끝"]);
  assert.deepEqual(wrapNoticeParagraph("", fits), [""]);
  assert.deepEqual(wrapNoticeParagraph("   ", fits), ["   "]);
  // A measuring function that accepts nothing still terminates, one character per line.
  assert.deepEqual(wrapNoticeParagraph("가나 다", () => false), ["가", "나 ", "다"]);
  const pages = paginateNotices(["하나 둘 셋 넷 다섯 여섯 일곱"], fits);
  assert.equal(pages.flat().flatMap((entry) => entry.lines).join(""), "하나 둘 셋 넷 다섯 여섯 일곱");
});
