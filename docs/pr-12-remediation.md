# PR #12 — v1.5.1 remediation and re-review evidence

PR: https://github.com/Seofram/cgv-guro-gift-display/pull/12

This continues `fix/high-priority-audit-findings` from reviewed head
`bce43c80d9af8ca9479a4c17daf838d772633ac9`, against base
`1a0560396b7920360e9584afd1648c6a44259f4d`. The original Fable v1.5.0 audit
and the complete Codex blocking review were read. Existing uncommitted
remediation in this checkout was retained, corrected and verified.

The SQLite `BEGIN IMMEDIATE` compare-and-set and online backup implementation
are preserved. Version identifiers remain **1.5.1**. No merge, tag, GitHub
Release or production installation change is part of this work.

## Codex finding coverage

| Finding | Correction | Verification evidence |
| --- | --- | --- |
| P1 administrator state ownership / F-01, F-02, F-11 | Each window owns its snapshot and base revision. Storage events cannot replace inventory. Clean refreshes check that their original document is still current. Serialized acknowledgments cover the submitted snapshot; later edits stay pending. Per-window drafts survive reload. Conflicts preserve both versions and stop when recovery storage cannot accept a copy. | Edge overlapping-window test holds one POST while another window saves; both POSTs retain their original base and one receives 409. Real packaged-server/Edge test repeats the race and recovers the losing draft after reload. Delayed refresh, delayed acknowledgment, outage and retry-conflict regressions pass. |
| P1 display rollback / F-01 | Polls never overlap. Same-instance older revisions are rejected. Server restarts establish a new baseline for deliberate restoration; confirmed empty stores show no inventory. | Edge regression applies sold-out revision 12, refuses revision 11 and delayed revision 10, checks no overlapping request, then accepts a restored instance and clears gifts after reset. Existing gift/notice rotation tests pass. |
| P1 sample-reset undo / F-09 | Reset archives the old document. Its undo is valid only until the next edit or adopted document; the setter checks validity again. Row undo retains its existing narrow restoration. | Reset → edit regression removes stale undo and retains the edit and archived original. Existing row/notice undo, order and immediate reset undo tests pass. |
| P2 save status and unbounded requests / F-02 | Korean pending/saved/failed/conflict states follow acknowledgment. Data requests have an 8-second deadline; display polls 5 seconds and native window control 25 seconds. The kiosk-open button uses acknowledged persistence instead of sending a revisionless duplicate POST. | Clock-controlled timeout retains latest edits and retries. Real delayed acknowledgment preserves edits made while awaiting the reply. Kiosk-open regression issues no extra POST to `/data`. |
| P2 shallow validation / F-04 | Validate item fields, unique IDs, status values, dates as editable strings, weekday bounds, booleans, settings and numeric/text/list bounds before writing. Legacy `rotateNotices` remains optional. Reject duplicate security/concurrency headers and invalid JSON media types. | Actual PowerShell 5.1 server rejects 13 field mutations; the complete stored document and revision remain unchanged. Legacy schema, optional settings and existing origin/content checks pass. |
| P2 silent backup failure / unsafe reset / F-09 | Backup failures reach status, save response, Korean UI and log. First-save backup is created. Reset requires a new verified current snapshot and fails closed without deleting live files. Daily rotation excludes pre-reset snapshots. | Actual failure injection returns `backupOk: false`, exposes/logs the error, and clears it after a successful backup. Exclusive database lock causes reset refusal with byte-identical database. Successful reset snapshot restores the entire latest document through the real server. Existing WAL-only transaction backup and independent SQLite integrity checks pass. |
| P2 generic heartbeat / F-05 | Bind heartbeat to a random token given to the launched kiosk and retained across server restart. Report window, heartbeat, startup and revision freshness separately. Korean labels require physical visibility confirmation. | Actual runtime rejects generic and unrelated tokens, accepts the bound token and applied revision after restart, and expires freshness after 15 seconds. Preview/read-only browser tests and Korean health-label tests pass. |

## Verification

- `npm run lint`: passed.
- `npm test`: passed; type check/build, **27 Node tests**, **49 Microsoft Edge browser tests**.
- Fresh packaged installation on **Windows PowerShell 5.1**:
  `tests/windows/verify-runtime.ps1` passed **76 runtime assertions**, including
  four real Edge/PowerShell scenarios: overlapping administrators, delayed
  acknowledgment, process kill/restart while editing, and HTTP 409 during retry.
- Packaged scripts parse with UTF-8 BOMs. Package is approximately **3.34 MiB**,
  below 10 MiB, with no bundled EXE/Node/Tauri runtime. Existing ZIP workflow is
  unchanged and runs the expanded Windows verification.
- All runtime tests use newly created isolated directories and refuse an
  already occupied controller port. Production inventory was not accessed.
- GitHub Actions result is available on this PR's checks tab for the pushed
  commit. Independent re-review is requested; this report is not merge approval.

## Original audit follow-ups and limits

F-03 failed-read protection remains in place; only a controller-shaped empty
response initializes a new store. F-06 server supervision, manual kiosk controls,
F-07 shorter idle-connection timeout, F-08 quoted profile paths, and F-10 existing
release upload support are preserved. The existing date editing, same-movie
grouping, inventory ordering, notice pagination/rotation and update checks pass.

Remaining limits are explicit:

- Physical secondary-monitor placement, visibility, renderer failure and native
  browser launches with unusual profile paths still need operating-PC checks.
  Headless Edge plus an HTTP heartbeat cannot establish visible pixels.
- The server remains single-threaded; native window actions can delay data
  requests. Requests time out safely and drafts retry. The kiosk does not reopen
  automatically and the app does not start at Windows logon.
- Conflict resolution selects a whole document, not individual fields. Browser
  profile recovery requires writable storage; clearing or switching profiles
  loses access to drafts. Recovery keeps at most 20 versions.
- Revision uniqueness across reset/restore still relies on the PC clock not
  moving far backward. Database replacement requires stopping the server.
- Release creation/upload behavior was source-reviewed only: publishing a
  release or tag is explicitly outside this task.

Protocol and recovery details: [data-integrity.md](data-integrity.md).
Korean operator instructions: [usage guide](../README_사용법.md).

## Final P2 follow-up after re-review of `2003d49`

The three previously corrected blockers are preserved. This follow-up addresses
only the remaining validation, draft durability and backup warning findings.

| Finding | Focused correction | Targeted evidence |
| --- | --- | --- |
| Unchanged HTTP 400 / invalid legacy content | Mirror server schema and payload bounds in the editor, stop retries for the rejected snapshot, retain content for explicit correction, and map only known server schema paths to Korean labels. Remove notice truncation and timing clamping on legacy reads. | Oversized movie/format/gift, 501-item legacy document, no hydration writes, HTTP 400 with no timer retries, subsequent correction and unrelated-edit preservation. Node checks preserve legacy notice/timing values and suppress arbitrary exception details. |
| Ignored failed local draft writes | Route all important draft attempts through one result-checking helper. Track the exact secured snapshot. Show an in-memory-only warning until the current version reaches browser storage, recovery, or SQLite. Qualify conflict/footer persistence claims. | Edge quota exhaustion and access denial during server outage, later local recovery, and an older acknowledgment followed by a pending conflict with storage still unavailable. |
| Backup warning lost on restart | Atomically persist unresolved failure / verified success in `backup-state.json`, restore it on startup, and use the existing error log as fallback. Unreadable/corrupt/missing failure metadata is conservative. SQLite online backup and retention remain unchanged. | Real PowerShell 5.1 failure → restart → warning retained → verified backup → restart → warning cleared. Inventory/revision checks and missing/corrupt/unreadable marker checks are included in the Windows suite. |

Compatibility: no database schema, CAS protocol, version, dependency, distribution
format, kiosk identity or polling changes. Existing v1.5.0 data is still read
without rewriting SQLite; values over the new write limits require explicit
correction before a later document can be saved. With an old backup-error log and
no state marker, the warning stays conservative until a new verified backup.
