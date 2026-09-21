# Inventory dates, notice rotation, and release checks

## Inventory editing

New rows use local calendar arithmetic: tomorrow at local noon, then seven more
calendar days. Storage remains `YYYY-MM-DD`; UTC conversion is not used.

The date pair owns a draft while either input has focus. Moving between date
subfields or tabbing to the other date does not publish intermediate values.
Leaving the pair commits both dates together. A microtask checks settled focus
when native controls report a null `relatedTarget`; no elapsed-time debounce is
required. The patch contains only dates, so unrelated synchronized fields survive.
Closing the browser while still editing a date leaves the last committed range.

Reversed, incomplete, and malformed ranges receive `기간 오류` and are excluded
from display and expiry cleanup. Expired items remain in inventory with
`만료 · 미노출`. Cleanup opens only through `만료 항목 정리`; its confirmation is
the explicit deletion action. Nothing deletes automatically on expiry.

Only the add action sets a pending movie-field focus target. Hydration and remote
updates do not request focus. The row and field scroll into view without animation,
including inside the horizontally scrolling inventory table.

## Display sequence and compatibility

`rotateNotices` defaults to false at controller hydration, localStorage hydration,
storage-event, and display-poll boundaries. Existing SQLite JSON records need no
schema change or reset. The existing storage key and timestamp protocol are kept.

The display builds gift pages first and appends notice pages to the same array.
One interval uses the existing `pageSeconds` cadence (minimum three seconds) for
both page kinds. The interval is cleaned up when its duration or page count changes;
the index is clamped if synchronization removes pages. No separate notice timer
exists. Rotation off preserves the regular footer. Rotation on removes that footer
and uses the same fixed 1280 × 1024 canvas for both layouts.

Notice pages use 32px bold type with 48px line height. Each page holds at most three
entries and ten text lines. Lines conservatively wrap at 28 Unicode code points;
long entries continue on additional pages with their original number and `계속`.
Blank notices add no pages. Explicit line breaks are preserved. This conservative
wrapping can leave unused horizontal space and split words; it favors consistent
distance readability over dense typesetting. The bottom margin reserves space for
page indicators. Page changes have no entrance animation and indicator transitions
are disabled for reduced-motion preferences.

## Release checks and deferred installation

The admin footer displays the build's `package.json` version. `업데이트 확인`
makes a manual, unauthenticated request to the repository's latest stable GitHub
Release. Strict semantic-version comparison handles numeric prereleases and ignores
build metadata. Checks abort after 3.5 seconds or component unmount. Offline,
rate-limit, missing-release, malformed-response, and server errors only change the
local status text; they never block inventory, SQLite, or the display controller.

The GitHub REST API supports browser CORS, so this request stays out of the
single-threaded PowerShell TCP server. No browser token, download, installation,
startup check, or automatic update was introduced. Links stay within this repository's
Releases pages. See [GitHub's CORS documentation](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests).

The current ZIP launcher has no atomic replacement or rollback protocol. A future
installer should stage a verified release in a separate versioned directory, validate
checksums and package paths, stop only its own server/display processes, back up the
SQLite database consistently, switch a launcher pointer atomically, and health-check
the new version before marking it successful. A failed health check must restore
the previous pointer and restart that version. Data must remain outside versioned
program directories in `%LOCALAPPDATA%\CGVGiftDisplay`; any schema migration needs
an explicit backward/rollback strategy. Windows policy and process handling require
separate end-to-end validation before such installation is offered.

## Verification

Run `npm ci`, `npm run lint`, `npm run build`, and `npm test` on the development PC.
`npm test` includes Node unit/packaging tests and Playwright browser regressions.
The browser suite uses installed Microsoft Edge (`msedge` channel); the Windows CI
image includes it. Playwright is development-only and is not copied into releases.
The Windows package workflow also verifies legacy JSON, the added setting through
SQLite restart, Korean content, script BOM/parse, startup, and the 10 MiB size cap.

Physical dual-monitor positioning still needs an operating-PC check; browser tests
exercise controller integration through mocked endpoints rather than moving the
operator's windows.
