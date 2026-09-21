import assert from "node:assert/strict";
import test from "node:test";
import { checkLatestRelease, compareVersions, parseLatestRelease, RELEASE_API_URL } from "../src/release-check.mjs";

test("compares strict semver, prereleases, and ignored build metadata", () => {
  assert.equal(compareVersions("1.2.3", "v1.2.3+build"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.4-rc.1"), -1);
  assert.equal(compareVersions("1.2.3-rc.2", "1.2.3-rc.10"), -1);
  assert.equal(compareVersions("1.2.3-rc.1", "1.2.3"), -1);
  assert.equal(compareVersions("01.2.3", "1.2.3"), null);
  assert.equal(compareVersions("1.2.3-rc.01", "1.2.3"), null);
  assert.equal(compareVersions("999999999999999999999.0.0", "10000000000000000000.0.0"), 1);
  assert.equal(compareVersions("1.0.0-999999999999999999999", "1.0.0-999999999999999999998"), 1);
});

test("accepts valid release tags and safe repository URLs", () => {
  assert.deepEqual(parseLatestRelease({ tag_name: "v1.5.0", html_url: "https://github.com/Seofram/cgv-guro-gift-display/releases/tag/v1.5.0" }), { tag: "v1.5.0", version: "1.5.0", url: "https://github.com/Seofram/cgv-guro-gift-display/releases/tag/v1.5.0" });
  assert.equal(parseLatestRelease({ tag_name: "latest", html_url: "https://evil.example/" }), null);
  assert.equal(parseLatestRelease({ tag_name: "v1.5.0", draft: true }), null);
  assert.equal(parseLatestRelease({ tag_name: "v1.5.0", prerelease: true }), null);
});

test("times out an unresponsive request", async () => {
  const result = await checkLatestRelease({
    currentVersion: "1.4.1",
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  assert.equal(result.status, "network-error");
});

function fakeFetch(status, payload) {
  return async (url) => { assert.equal(url, RELEASE_API_URL); return { ok: status >= 200 && status < 300, status, json: async () => payload }; };
}

test("reports update, current, and fail-safe HTTP statuses", async () => {
  assert.equal((await checkLatestRelease({ currentVersion: "1.4.1", fetchImpl: fakeFetch(200, { tag_name: "v1.5.0" }) })).status, "update");
  assert.equal((await checkLatestRelease({ currentVersion: "1.4.1", fetchImpl: fakeFetch(200, { tag_name: "v1.4.1" }) })).status, "current");
  assert.equal((await checkLatestRelease({ currentVersion: "1.4.1", fetchImpl: fakeFetch(404, {}) })).status, "not-found");
  assert.equal((await checkLatestRelease({ currentVersion: "1.4.1", fetchImpl: fakeFetch(403, {}) })).status, "rate-limited");
  assert.equal((await checkLatestRelease({ currentVersion: "1.4.1", fetchImpl: fakeFetch(429, {}) })).status, "rate-limited");
  assert.equal((await checkLatestRelease({ currentVersion: "1.4.1", fetchImpl: fakeFetch(500, {}) })).status, "network-error");
  for (const payload of [null, {}, [], { tag_name: 42 }, { tag_name: "latest" }]) {
    assert.equal((await checkLatestRelease({ currentVersion: "1.4.1", fetchImpl: fakeFetch(200, payload) })).status, "invalid");
  }
  assert.equal((await checkLatestRelease({ currentVersion: "1.4.1", fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } }) })).status, "network-error");
  assert.equal((await checkLatestRelease({ currentVersion: "1.4.1", fetchImpl: async () => { throw new Error("offline"); } })).status, "network-error");
});
