export const RELEASE_API_URL =
  "https://api.github.com/repos/Seofram/cgv-guro-gift-display/releases/latest";
export const RELEASES_URL =
  "https://github.com/Seofram/cgv-guro-gift-display/releases";

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(value) {
  const normalized = String(value ?? "").trim().replace(/^v/i, "");
  const match = VERSION_PATTERN.exec(normalized);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return {
    major: match[1], minor: match[2], patch: match[3], prerelease,
  };
}

function compareNumericStrings(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    const difference = compareNumericStrings(a[key], b[key]);
    if (difference) return difference;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericStrings(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function parseLatestRelease(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.draft === true || payload.prerelease === true) return null;
  const tag = typeof payload.tag_name === "string" ? payload.tag_name.trim() : "";
  const version = tag.replace(/^v/i, "");
  if (!parseVersion(version)) return null;
  const url = typeof payload.html_url === "string" && /^https:\/\/github\.com\/Seofram\/cgv-guro-gift-display\/releases\//.test(payload.html_url)
    ? payload.html_url
    : RELEASES_URL;
  return { tag, version, url };
}

/** @param {{currentVersion?: string, fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} options */
export async function checkLatestRelease({
  currentVersion,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 3500,
} = {}) {
  if (!parseVersion(currentVersion)) return { status: "invalid", release: null };
  if (typeof fetchImpl !== "function") return { status: "network-error", release: null };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) return { status: "network-error", release: null };
    signal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(RELEASE_API_URL, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (response.status === 404) return { status: "not-found", release: null };
    if (response.status === 403 || response.status === 429) return { status: "rate-limited", release: null };
    if (!response.ok) return { status: "network-error", release: null };
    const release = parseLatestRelease(await response.json());
    if (!release) return { status: "invalid", release: null };
    return {
      status: compareVersions(release.version, currentVersion) > 0 ? "update" : "current",
      release,
    };
  } catch {
    return { status: "network-error", release: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
