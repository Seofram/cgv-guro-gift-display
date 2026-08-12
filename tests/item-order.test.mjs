import assert from "node:assert/strict";
import test from "node:test";

import { stableGroupItemsByMovie } from "../src/item-order.mjs";

test("groups movies by first appearance without changing order inside groups", () => {
  const items = [
    { id: "a1", movie: "영화 A" },
    { id: "b1", movie: "영화 B" },
    { id: "a2", movie: "영화 A " },
    { id: "c1", movie: "영화 C" },
    { id: "b2", movie: "영화 B" },
  ];

  const sorted = stableGroupItemsByMovie(items);

  assert.deepEqual(
    sorted.map((item) => item.id),
    ["a1", "a2", "b1", "b2", "c1"],
  );
  assert.deepEqual(items.map((item) => item.id), ["a1", "b1", "a2", "c1", "b2"]);
});
