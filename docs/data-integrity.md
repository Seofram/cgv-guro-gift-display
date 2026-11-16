# Data integrity, concurrency, and recovery (v1.5.1)

This document describes how inventory data is protected from loss and
overwrite. It replaces the timestamp-based assumptions of v1.5.0.

## Storage and revisions

`%LOCALAPPDATA%\CGVGiftDisplay\inventory.db` holds one row in `app_state`:

| Column | Meaning |
| --- | --- |
| `payload` | The inventory and settings as JSON, stored exactly as received. |
| `updated_at` | The edit timestamp from the administrator window (informational). |
| `revision` | A server-issued integer. Only the server changes it. |

Each successful write sets `revision = max(revision + 1, current Unix time in
milliseconds)`. A revision is therefore later than every revision issued before
it, including across `reset-data.bat` and a restored backup, as long as the PC
clock is not set far into the past.

## Write protocol

- `GET /data` returns `{ ok, data, revision, instance }`. `instance` identifies
  the server process. An empty store returns 404 with `revision: 0`, `instance`
  and a boolean `reset`. Other 404 bodies are failed reads, not empty stores.
- `POST /data` must carry `X-CGV-Base-Revision: <revision the edit was made from>`
  (`0` for an empty store). The body is the JSON document.
- The server compares the base revision with the stored one and writes inside a
  single `BEGIN IMMEDIATE` transaction. On a match it stores the document and
  answers `200 { ok, revision }`.
- On a mismatch nothing is written and the answer is
  `409 { ok: false, conflict: true, revision: <stored revision> }`.
- A request without the header is answered with `428` and nothing is written.
  v1.5.0 and earlier pages do not send it, so a page left open across an update
  can no longer overwrite data. (Such a page ignores the answer and gives no
  warning; see *Limitations*.)

Other status codes: `400` malformed document, `403` foreign `Host`, `Origin` or
`Sec-Fetch-Site`, `415` body is not `application/json`, `500` storage error. A
failed read is `500`, never "no data".

## Administrator window behaviour

- Saves are serialized: one request at a time, each based on the revision
  returned by the previous one. Fast typing produces an ordered chain, never a
  self-conflict.
- Every administrator document owns a data/base-revision pair and a separate
  profile draft (`cgv-guro-gift-display-draft-v1:<window id>`). A newer revision
  is attached only after adopting its matching server document or acknowledging
  that window's own submitted snapshot. Later edits remain pending until their
  own acknowledgment. The old shared `...-sync-v1` dirty document is recovered
  once when upgrading an earlier PR build.
- Storage events never replace inventory. Broadcast messages and controller
  status can request a refresh only in a clean window; the window must remain
  unchanged throughout that asynchronous read. Dirty windows retain their own
  snapshots and receive 409 when another writer wins.
- Web Locks identify live windows; a reload recovers an abandoned draft without
  taking another live window's work. Tabs receive independent IDs even when a
  browser duplicates session storage.
- While a save is unacknowledged the indicator says `저장 중…`. It says `저장됨`
  only after the current snapshot is acknowledged. Data requests time out after
  eight seconds (display polling: five); timed-out drafts remain pending for
  retry. Native window control has a separate 25-second bound.
- **Network failure or server down:** the indicator shows `저장 실패 · 재시도 중`
  and the latest state is retried every three seconds. Edits stay in the profile
  and survive closing the window.
- **Lost reply:** if a write was stored but its reply never arrived, the retry is
  answered with 409. The window reads the stored data, sees that it is identical
  to what it is trying to save, and continues without a conflict.
- **Real conflict (409 with different stored data):** the window does not retry,
  does not replace its state, and does not overwrite. It shows the conflict
  dialog with both versions and a list of differences. The operator chooses
  `이 창의 내용으로 저장`, `저장된 최신 내용 사용`, or `나중에 선택`. The version
  that is not chosen is first copied to **보관된 버전**
  (`cgv-guro-gift-display-recovery-v1`, most recent 20), from which it can be
  restored, downloaded as JSON, or deleted. Restoring a kept version keeps the
  version it replaces in turn.
- **Start-up:** if the profile holds unsaved edits and the stored revision is
  still the one they were based on, they are saved. If the stored revision has
  changed, the conflict dialog opens. If the store cannot be read, the window
  does not open for editing and retries.
- Display windows (the kiosk and the monitoring popup) never write.
- If a dirty window encounters a deliberately emptied database, it asks for
  conflict resolution rather than automatically resurrecting the old inventory.

## Display synchronization and health

Display polls are serialized, including while a previous request is slow. Within
one server instance, only higher revisions are applied. Older responses cannot
restore sold-out inventory. A different server instance establishes a new baseline
because a stopped server's database may have been deliberately restored or
replaced. Confirmed empty stores show no inventory. A transient read failure keeps
the last display data; it never initializes or writes the store. Replacing the
database requires stopping the server first.

The controller gives each launched kiosk a random token in its URL and keeps the
token in `display-token.txt` across server restarts. Only that token's requests
update its heartbeat; previews and generic `X-CGV-Client` headers do not. Each poll
reports the last applied revision. Status separates window existence, heartbeat
freshness (15 seconds), startup grace, and applied-versus-stored revision. An
unchanged mismatch becomes a data-lag warning after ten seconds. The Korean badge
`전시 창 응답 중` describes application response, not physical visibility. The
operator must still inspect the secondary monitor.

## Backups

Before the first change of each day the server writes
`backups\inventory-YYYYMMDD.db` using the SQLite online backup API, so
transactions that are still only in the write-ahead log are included. The copy
is switched to rollback-journal mode (one self-contained file), checked with
`PRAGMA integrity_check`, and only then moved into place. Fourteen files are
kept. A new store also receives a verified backup after its first save. A daily
backup problem never blocks saving, but is returned as `backupOk: false`, exposed
through `/display/status`, logged in `backup-error.log`, and shown in Korean on
the administrator screen. A later successful backup clears the warning.

`reset-data.bat` stops the server and creates a separate current
`backups\pre-reset-<timestamp>.db` through the same online backup API. It verifies
both integrity and readability before deleting live files. Failure stops reset
and leaves the live database in place. Pre-reset snapshots are not rotated with
the fourteen daily backups. `clean-uninstall.bat` removes all backups.

The in-app sample reset also preserves the replaced document in **보관된 버전**.
Its 15-second undo is invalidated by any subsequent edit or adopted document.
Row deletion undo continues to restore only the removed rows and preserve other
edits. The restore procedure is in `README_사용법.md`.

## Migration and compatibility

- **v1.5.0 and earlier → v1.5.1:** on first start the server adds the `revision`
  column with `ALTER TABLE` and gives the existing row a revision. The payload
  is untouched; no reset is needed. `rotateNotices` and other missing fields
  keep their defaults.
- **v1.5.1 → v1.5.0 (downgrade):** the v1.5.0 statement names no revision
  column and still works; the row's revision becomes 0. On the next v1.5.1
  start it receives a fresh revision.
- **Browser profile:** the keys above are new. The inventory key
  (`cgv-guro-gift-display-v1`) is unchanged.
- `start-local.bat` replaces a running server whose version differs from the
  package it is started from.

## Verification

- `npm test`: type check, build, Node tests, and Edge browser tests. The browser
  tests use a stand-in controller that enforces the same revision contract
  (conflict dialog, postponing, restart with pending conflict, lost reply,
  outage retries, two windows).
- `tests/windows/verify-runtime.ps1`: runs the packaged server on Windows
  PowerShell 5.1 against an isolated data directory and a database created with
  the v1.5.0 schema by Node's built-in SQLite. It also invokes
  `verify-browser.mjs` for real Edge administrators, delayed acknowledgments,
  server process kill/restart and retry conflicts, and verifies fail-closed reset
  and restoration of its final backup. It is run by the Windows workflow.

      npm run build
      # assemble the package as the workflow does, then:
      powershell -ExecutionPolicy Bypass -File tests\windows\verify-runtime.ps1 `
        -PackageDirectory <package> -RuntimeRoot <empty temp folder>

## Limitations

- A v1.5.0 administrator page that stays open across the update is refused
  (428) but cannot show it; edits made there are not stored. Close
  administrator windows before updating.
- Conflict resolution is whole-document: the operator picks one version. There
  is no field-level merge. The other version stays in **보관된 버전**.
- Kept versions and unsaved edits live in the administrator browser profile.
  Clearing that profile, `clean-uninstall.bat`, or switching between Edge and
  Chrome removes access to them.
- If Web Locks are unavailable, another window's draft may also be offered as
  abandoned work; the original draft is retained in that window's memory and
  server CAS still prevents an unconditional overwrite. Supported Edge/Chrome
  loopback contexts provide Web Locks.
- Browser storage must be available for recovery after closing a dirty window.
  In-memory edits cannot survive a profile clear, full storage, or a browser
  crash if their local draft could not be written. Kept versions are capped at 20.
- Revisions rely on the PC clock only for uniqueness across a reset or restore.
  Setting the clock back by more than the time since the last write, combined
  with a reset or restore, could reissue a revision number.
- The kiosk window is not reopened automatically, and nothing starts at Windows
  logon.
- The server handles one request at a time; opening the display blocks other
  requests for several seconds.
