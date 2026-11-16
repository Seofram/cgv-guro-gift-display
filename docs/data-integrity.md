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

- `GET /data` returns `{ ok, data, revision }`. An empty store returns 404 with
  `revision: 0`.
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
- The base revision and an "unsaved edits" flag are kept in the browser profile
  (`cgv-guro-gift-display-sync-v1`) and shared by all administrator windows of
  that profile. Edits from another window of the same profile are mirrored and
  are saved only by the window that made them.
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

## Backups

Before the first change of each day the server writes
`backups\inventory-YYYYMMDD.db` using the SQLite online backup API, so
transactions that are still only in the write-ahead log are included. The copy
is switched to rollback-journal mode (one self-contained file), checked with
`PRAGMA integrity_check`, and only then moved into place. Fourteen files are
kept. A backup problem never blocks saving.

`reset-data.bat` leaves `backups` in place; `clean-uninstall.bat` removes it.
The restore procedure is in `README_사용법.md`.

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
  the v1.5.0 schema by Node's built-in SQLite. It is run by the Windows workflow.

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
- Two administrator windows of the same profile that both edit within the same
  few milliseconds mirror each other; the later edit is the one saved.
- Revisions rely on the PC clock only for uniqueness across a reset or restore.
  Setting the clock back by more than the time since the last write, combined
  with a reset or restore, could reissue a revision number.
- The kiosk window is not reopened automatically, and nothing starts at Windows
  logon.
- The server handles one request at a time; opening the display blocks other
  requests for several seconds.
