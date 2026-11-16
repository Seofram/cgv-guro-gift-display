param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [string]$Node = "node"
)

# End-to-end verification of the packaged Windows PowerShell 5.1 runtime
# against an isolated data directory. Used by the Windows workflow and
# runnable by hand. This file is ASCII-only so that it parses without a BOM.
#
# Covers: v1.5.0 database migration, optimistic concurrency (base revision,
# 409, legacy clients), request-origin checks, SQLite snapshot backups
# (including write-ahead-log content), restore, restart and downgrade.

$ErrorActionPreference = "Stop"
$fixtures = Join-Path $PSScriptRoot "sqlite-fixtures.mjs"
$serverScript = Join-Path $PackageDirectory "scripts\local-server.ps1"
$storeScript = Join-Path $PackageDirectory "scripts\sqlite-store.ps1"
$dataDirectory = Join-Path $RuntimeRoot "CGVGiftDisplay"
$database = Join-Path $dataDirectory "inventory.db"
$api = "http://127.0.0.1:3210"
$guro = [string][char]0xAD6C + [char]0xB85C
$checks = New-Object Collections.Generic.List[string]

# Never run an API check against a pre-existing controller (production or
# another test). Every server used below belongs to this harness.
$probe = New-Object Net.Sockets.TcpClient
try { $probe.Connect("127.0.0.1", 3210); $occupied = $true }
catch { $occupied = $false }
finally { $probe.Close() }
if ($occupied) { throw "Port 3210 is occupied; refusing to touch an existing controller." }
if (Test-Path -LiteralPath $RuntimeRoot) {
  throw "RuntimeRoot must be a new isolated directory; existing data is never removed."
}
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$env:LOCALAPPDATA = $RuntimeRoot
# Node prints an ExperimentalWarning for node:sqlite on stderr.
$env:NODE_NO_WARNINGS = "1"

function Assert-That {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "FAILED: $Message" }
  $checks.Add($Message)
  Write-Host "  ok  $Message"
}

function Invoke-Fixture {
  param([string[]]$Arguments)
  $output = & $Node $fixtures @Arguments
  if ($LASTEXITCODE -ne 0) { throw "sqlite-fixtures $($Arguments[0]) failed" }
  return ($output | Select-Object -Last 1) | ConvertFrom-Json
}

function Start-TestServer {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process powershell.exe -ArgumentList @(
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $serverScript + '"'), "-NoOpen"
  ) -WindowStyle Hidden -PassThru
  $health = $null
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    Start-Sleep -Milliseconds 50
    if ($process.HasExited) {
      $log = Join-Path $dataDirectory "server-error.log"
      $detail = if (Test-Path $log) { Get-Content -Raw $log } else { "no log" }
      throw "PowerShell server exited: $detail"
    }
    try {
      $health = Invoke-RestMethod "$api/health" -TimeoutSec 1
      if ($health.ok) { break }
    } catch {}
  }
  $timer.Stop()
  if (-not $health.ok) { throw "Server was not ready in time." }
  if ($health.runtime -ne "powershell") { throw "Unexpected runtime." }
  return @{
    Process = $process
    ReadyMs = $timer.ElapsedMilliseconds
    StartupMs = $health.startupMs
    Version = $health.version
  }
}

function Stop-TestServer {
  param($Server)
  Stop-Process -Id $Server.Process.Id -Force -ErrorAction SilentlyContinue
  $Server.Process.WaitForExit()
  Start-Sleep -Milliseconds 300
}

# Returns the HTTP status and parsed JSON body, for failures as well.
function Invoke-Api {
  param(
    [string]$Path,
    [string]$Method = "Get",
    [string]$Json = $null,
    [hashtable]$Headers = @{},
    [string]$ContentType = "application/json; charset=utf-8"
  )
  $arguments = @{
    Uri = "$api$Path"; Method = $Method; Headers = $Headers; UseBasicParsing = $true
  }
  if ($null -ne $Json -and $Json -ne "") {
    $arguments.Body = [Text.Encoding]::UTF8.GetBytes($Json)
    $arguments.ContentType = $ContentType
  }
  try {
    $response = Invoke-WebRequest @arguments
    $text = $response.Content
    if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
    return @{ Status = [int]$response.StatusCode; Body = ($text | ConvertFrom-Json) }
  } catch {
    $failure = $_.Exception.Response
    if ($null -eq $failure) { throw }
    $stream = $failure.GetResponseStream()
    # Windows PowerShell has already read the error body once.
    if ($stream.CanSeek) { $stream.Position = 0 }
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
    $body = $null
    try { $body = $text | ConvertFrom-Json } catch {}
    return @{ Status = [int]$failure.StatusCode; Body = $body }
  }
}

function New-Payload {
  param([string]$UpdatedAt, [string]$Location, [bool]$RotateNotices = $false)
  return (@{
    items = @()
    settings = @{
      location = $Location; title = "Gift display"; notices = @()
      pageSeconds = 8; showSoldout = $true; rotateNotices = $RotateNotices
    }
    updatedAt = $UpdatedAt
  } | ConvertTo-Json -Depth 6)
}

function Save-Data {
  param([string]$Json, $BaseRevision, [hashtable]$Headers = @{}, [string]$ContentType = "application/json; charset=utf-8")
  $all = @{} + $Headers
  if ($null -ne $BaseRevision) { $all["X-CGV-Base-Revision"] = [string]$BaseRevision }
  return Invoke-Api -Path "/data" -Method "Post" -Json $Json -Headers $all -ContentType $ContentType
}

Write-Host "== v1.5.0 database is migrated in place =="
$legacy = Invoke-Fixture @("legacy", $database)
Assert-That ($legacy.columns -notcontains "revision") "fixture is a v1.5.0 database without a revision column"
$boundToken = "b" * 32
[IO.File]::WriteAllText((Join-Path $dataDirectory "display-token.txt"), $boundToken)
$first = Start-TestServer
$result = @{ FirstReadyMs = $first.ReadyMs }
try {
  $html = Invoke-WebRequest "$api/" -UseBasicParsing
  Assert-That ($html.Content -match "html lang=") "static frontend is served"
  $read = Invoke-Api -Path "/data"
  Assert-That ($read.Status -eq 200 -and $read.Body.data.settings.location -eq $guro) "legacy inventory and Korean text are readable after migration"
  Assert-That ($read.Body.data.items.Count -eq 1 -and $read.Body.data.items[0].id -eq "legacy-1") "legacy inventory rows are intact"
  $revision = [long]$read.Body.revision
  Assert-That ($revision -gt 0) "the migrated row received a server revision"

  Write-Host "== optimistic concurrency =="
  $next = New-Payload "2026-08-13T00:00:00.000Z" $guro
  $legacyClient = Save-Data $next $null
  Assert-That ($legacyClient.Status -eq 428) "a write without a base revision (v1.5.0 client) is refused with 428"
  $wrongBase = Save-Data $next ($revision - 1)
  Assert-That ($wrongBase.Status -eq 409 -and [long]$wrongBase.Body.revision -eq $revision) "a write from another revision is refused with 409 and reports the stored revision"
  $emptyBase = Save-Data $next 0
  Assert-That ($emptyBase.Status -eq 409) "a write that assumes an empty store is refused with 409"
  $unchanged = Invoke-Api -Path "/data"
  Assert-That ([long]$unchanged.Body.revision -eq $revision -and $unchanged.Body.data.updatedAt -eq "2026-08-01T00:00:00.000Z") "refused writes changed nothing"

  $saved = Save-Data $next $revision
  Assert-That ($saved.Status -eq 200 -and [long]$saved.Body.revision -gt $revision) "a write from the stored revision succeeds and returns a later revision"
  $replay = Save-Data (New-Payload "2026-08-13T00:00:01.000Z" "stale") $revision
  Assert-That ($replay.Status -eq 409) "reusing the previous revision is refused with 409"
  $revision = [long]$saved.Body.revision
  $rotated = Save-Data (New-Payload "2026-08-13T00:00:00.000Z" $guro $true) $revision
  Assert-That ($rotated.Status -eq 200) "a second write from the returned revision succeeds"
  $revision = [long]$rotated.Body.revision
  $stored = Invoke-Api -Path "/data"
  Assert-That ($stored.Body.data.settings.location -eq $guro -and $stored.Body.data.settings.rotateNotices -eq $true -and [long]$stored.Body.revision -eq $revision) "Korean text and settings round-trip with the revision"

  Write-Host "== request-origin checks =="
  $body = New-Payload "2026-08-14T00:00:00.000Z" "attacker"
  Assert-That ((Save-Data $body $revision @{ Origin = "https://attacker.example" }).Status -eq 403) "a foreign Origin cannot write"
  Assert-That ((Save-Data $body $revision @{ "Sec-Fetch-Site" = "cross-site" }).Status -eq 403) "a cross-site request cannot write"
  Assert-That ((Save-Data $body $revision @{} "text/plain").Status -eq 415) "a non-JSON body cannot write"
  Assert-That ((Save-Data '{"items":[null],"settings":{},"updatedAt":"bad"}' $revision).Status -eq 400) "a malformed inventory row is refused"
  Assert-That ((Invoke-Api -Path "/display/close" -Method "Post" -Headers @{ Origin = "https://attacker.example" }).Status -eq 403) "a foreign Origin cannot control the display"
  $stored = Invoke-Api -Path "/data"
  Assert-That ([long]$stored.Body.revision -eq $revision -and $stored.Body.data.settings.location -eq $guro) "rejected requests changed nothing"

  Write-Host "== deep schema rejection leaves data intact =="
  $validJson = $legacy.data | ConvertTo-Json -Depth 10
  foreach ($mutation in @(
    { param($v) $v.items[0].PSObject.Properties.Remove("movie") },
    { param($v) $v.items[0].id = "" },
    { param($v) $v.items = @($v.items[0], $v.items[0]) },
    { param($v) $v.items[0].movie = 123 },
    { param($v) $v.items[0].status = "AVAILABLE" },
    { param($v) $v.items[0].days = @(7) },
    { param($v) $v.items[0].visible = "true" },
    { param($v) $v.settings.pageSeconds = -1 },
    { param($v) $v.settings.pageSeconds = 3601 },
    { param($v) $v.settings.notices = @($null) },
    { param($v) $v.settings.showSoldout = 1 },
    { param($v) $v.settings | Add-Member rotateNotices "true" },
    { param($v) $v.items[0].startDate = 123 }
  )) {
    $bad = $validJson | ConvertFrom-Json
    & $mutation $bad
    $rejected = Save-Data ($bad | ConvertTo-Json -Depth 10) $revision
    Assert-That ($rejected.Status -eq 400) "invalid field mutation $($checks.Count) is rejected"
  }
  $afterBad = Invoke-Api -Path "/data"
  Assert-That ([long]$afterBad.Body.revision -eq $revision -and
    ($afterBad.Body.data | ConvertTo-Json -Depth 10 -Compress) -eq
    ($stored.Body.data | ConvertTo-Json -Depth 10 -Compress)) "schema rejection leaves the entire stored document and revision unchanged"

  Write-Host "== display heartbeat =="
  $status = Invoke-RestMethod "$api/display/status"
  Assert-That ($null -eq $status.displaySeenAt) "a plain read is not a display heartbeat"
  Invoke-RestMethod "$api/data" -Headers @{ "X-CGV-Client" = "display" } | Out-Null
  $status = Invoke-RestMethod "$api/display/status"
  Assert-That ($null -eq $status.displaySeenAt) "a generic display header cannot establish kiosk health"
  Invoke-RestMethod "$api/data" -Headers @{ "X-CGV-Display" = ("a" * 32) } | Out-Null
  $status = Invoke-RestMethod "$api/display/status"
  Assert-That ($null -eq $status.displaySeenAt) "an unrelated kiosk token cannot establish kiosk health"
  Invoke-RestMethod "$api/data" -Headers @{
    "X-CGV-Display" = $boundToken; "X-CGV-Display-Revision" = [string]$revision
  } | Out-Null
  $status = Invoke-RestMethod "$api/display/status"
  Assert-That ($status.heartbeat.fresh -and $status.data.current) "only the bound kiosk reporting the applied revision establishes freshness"
  Assert-That (-not $status.running -and -not $status.responding) "a heartbeat without a display window is not a working display"

  Write-Host "== daily backup is a valid SQLite snapshot =="
  $backups = @(Get-ChildItem (Join-Path $dataDirectory "backups") -Filter "inventory-*.db")
  Assert-That ($backups.Count -eq 1) "exactly one backup exists for today"
  $backupPath = $backups[0].FullName
  Assert-That (-not (Test-Path "$backupPath-wal") -and -not (Test-Path "$backupPath-shm") -and -not (Test-Path "$backupPath.tmp")) "the backup is a single file with no companion files"
  $snapshot = Invoke-Fixture @("inspect", $backupPath)
  Assert-That ($snapshot.integrity -eq "ok") "the backup passes SQLite integrity_check (checked by Node's SQLite)"
  Assert-That ($snapshot.journalMode -eq "delete") "the backup does not depend on a write-ahead log"
  Assert-That ($snapshot.data.settings.location -eq $guro -and $snapshot.data.items[0].id -eq "legacy-1" -and $snapshot.updatedAt -eq "2026-08-01T00:00:00.000Z") "the backup holds the inventory and settings from before today's first change"
} finally {
  Stop-TestServer $first
}

Write-Host "== restart =="
$second = Start-TestServer
$result.RestartReadyMs = $second.ReadyMs
$result.StartupMs = $second.StartupMs
$result.Version = $second.Version
try {
  $stored = Invoke-Api -Path "/data"
  Assert-That ($stored.Body.data.updatedAt -eq "2026-08-13T00:00:00.000Z" -and $stored.Body.data.settings.rotateNotices -eq $true) "data survives a restart"
  Assert-That ([long]$stored.Body.revision -eq $revision) "the revision survives a restart"
  $bytes = [IO.File]::ReadAllBytes($database)
  Assert-That ([Text.Encoding]::ASCII.GetString($bytes, 0, 15) -eq "SQLite format 3") "the store is a SQLite file"

  Write-Host "== backup failures are visible and recover =="
  $dailyPath = $backupPath
  $backupPath = Join-Path $RuntimeRoot "original-backup.db"
  Copy-Item -LiteralPath $dailyPath -Destination $backupPath
  Remove-Item -LiteralPath $dailyPath -Force
  New-Item -ItemType Directory -Path $dailyPath | Out-Null
  $saved = Save-Data ($stored.Body.data | ConvertTo-Json -Depth 10) $revision
  Assert-That ($saved.Status -eq 200 -and -not $saved.Body.backupOk) "a backup failure is returned without losing the inventory save"
  $revision = [long]$saved.Body.revision
  $status = Invoke-RestMethod "$api/display/status"
  Assert-That (-not $status.backup.ok -and $status.backup.error.message -and
    (Test-Path (Join-Path $dataDirectory "backup-error.log"))) "backup failure is exposed through status and a persistent log"
  Stop-TestServer $second
  $second = Start-TestServer
  $status = Invoke-RestMethod "$api/display/status"
  Assert-That (-not $status.backup.ok -and $status.backup.error.message) "unresolved backup warning survives a real server restart"
  $afterFailure = Invoke-Api -Path "/data"
  Assert-That ([long]$afterFailure.Body.revision -eq $revision -and
    ($afterFailure.Body.data | ConvertTo-Json -Depth 10 -Compress) -eq
    ($stored.Body.data | ConvertTo-Json -Depth 10 -Compress)) "backup failure and restart leave the complete inventory unchanged"
  Remove-Item -LiteralPath $dailyPath -Force
  $saved = Save-Data ($stored.Body.data | ConvertTo-Json -Depth 10) $revision
  Assert-That ($saved.Status -eq 200 -and $saved.Body.backupOk) "a later verified backup clears the backup warning"
  $revision = [long]$saved.Body.revision
  Stop-TestServer $second
  $second = Start-TestServer
  $status = Invoke-RestMethod "$api/display/status"
  Assert-That ($status.backup.ok) "verified backup success remains clear after restart despite the historical error log"
  Invoke-RestMethod "$api/data" -Headers @{
    "X-CGV-Display" = $boundToken; "X-CGV-Display-Revision" = [string]$revision
  } | Out-Null
  $status = Invoke-RestMethod "$api/display/status"
  Assert-That ($status.heartbeat.fresh -and $status.data.current) "a bound kiosk continues reporting after a server restart"
  Start-Sleep -Seconds 16
  $status = Invoke-RestMethod "$api/display/status"
  Assert-That (-not $status.heartbeat.fresh -and -not $status.data.current) "kiosk heartbeat and freshness expire without further requests"
} finally {
  Stop-TestServer $second
}
$latestRevision = $revision

Write-Host "== missing, corrupt and inaccessible backup markers =="
$stateFile = Join-Path $dataDirectory "backup-state.json"
$validState = [IO.File]::ReadAllBytes($stateFile)
foreach ($mode in @("missing", "corrupt", "inaccessible")) {
  Remove-Item -LiteralPath $stateFile -Force
  if ($mode -eq "corrupt") { [IO.File]::WriteAllText($stateFile, "{broken") }
  if ($mode -eq "inaccessible") { New-Item -ItemType Directory -Path $stateFile | Out-Null }
  $metadataServer = Start-TestServer
  try {
    $status = Invoke-RestMethod "$api/display/status"
    Assert-That (-not $status.backup.ok -and $status.backup.error.message) "$mode backup metadata yields a conservative warning"
    $unchanged = Invoke-Api -Path "/data"
    Assert-That ([long]$unchanged.Body.revision -eq $revision) "$mode backup metadata does not write the inventory"
  } finally { Stop-TestServer $metadataServer }
  if (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile -Force }
  [IO.File]::WriteAllBytes($stateFile, $validState)
}

Write-Host "== restoring a backup =="
Copy-Item -LiteralPath $backupPath -Destination $database -Force
Remove-Item -LiteralPath "$database-wal", "$database-shm" -Force -ErrorAction SilentlyContinue
$third = Start-TestServer
try {
  $restored = Invoke-Api -Path "/data"
  Assert-That ($restored.Status -eq 200 -and $restored.Body.data.settings.location -eq $guro -and $restored.Body.data.items[0].id -eq "legacy-1") "a restored backup serves the expected inventory and settings"
  Assert-That ($restored.Body.data.updatedAt -eq "2026-08-01T00:00:00.000Z" -and $restored.Body.data.settings.notices.Count -eq 1) "the restored data is the backed-up version, not the later one"
  $restoredRevision = [long]$restored.Body.revision
  $staleWindow = Save-Data (New-Payload "2026-08-15T00:00:00.000Z" "stale window") $latestRevision
  Assert-That ($staleWindow.Status -eq 409) "a window still holding the pre-restore revision cannot overwrite the restored data"
  $afterRestore = Save-Data (New-Payload "2026-08-15T00:00:00.000Z" $guro) $restoredRevision
  Assert-That ($afterRestore.Status -eq 200 -and [long]$afterRestore.Body.revision -gt $latestRevision) "revisions issued after a restore are later than every revision issued before it"
} finally {
  Stop-TestServer $third
}

Write-Host "== downgrade to v1.5.0 and back =="
$downgraded = Invoke-Fixture @("legacy-write", $database)
Assert-That ($downgraded.data.settings.location.Length -gt 0 -and [long]$downgraded.revision -eq 0) "the v1.5.0 write statement still works on a migrated database"
$fourth = Start-TestServer
try {
  $again = Invoke-Api -Path "/data"
  Assert-That ($again.Status -eq 200 -and $again.Body.data.updatedAt -eq "2026-08-20T00:00:00.000Z" -and [long]$again.Body.revision -gt 0) "data written by v1.5.0 is served again with a fresh revision"
} finally {
  Stop-TestServer $fourth
}

Write-Host "== backup includes transactions that are only in the write-ahead log =="
$walDirectory = Join-Path $RuntimeRoot "wal-check"
New-Item -ItemType Directory -Path $walDirectory -Force | Out-Null
$wal = Invoke-Fixture @("wal-backup", (Join-Path $walDirectory "source.db"), (Join-Path $walDirectory "backup.db"), $storeScript)
Assert-That ([long]$wal.walBytesWhenBackedUp -gt 0 -and $wal.mainFileUnchangedByWalWrites) "25 committed transactions existed only in the write-ahead log"
Assert-That ($wal.backup.integrity -eq "ok" -and -not $wal.backupHasCompanionFiles) "the backup taken at that moment is a valid single-file database"
Assert-That ($wal.backup.updatedAt -eq "2026-08-02T00:00:25.000Z" -and $wal.backup.updatedAt -eq $wal.source.updatedAt) "the backup contains the last committed transaction"
Assert-That ($wal.source.integrity -eq "ok") "the source database is intact after the backup"

Write-Host "== real Edge administrators and PowerShell process outage =="
$browserServer = Start-TestServer
try {
  & $Node (Join-Path $PSScriptRoot "verify-browser.mjs") $browserServer.Process.Id $serverScript
  Assert-That ($LASTEXITCODE -eq 0) "real Edge concurrency, delayed acknowledgment, server kill/restart and retry conflict pass"
} finally {
  Stop-TestServer $browserServer
}

Write-Host "== reset refuses an unverified backup and restores its final snapshot =="
$beforeReset = Invoke-Fixture @("inspect", $database)
$beforeHash = (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash
$confirmation = [string][char]0xCD08 + [char]0xAE30 + [char]0xD654
$resetScript = Join-Path $PackageDirectory "scripts\reset-data.ps1"
$lockedFile = [IO.File]::Open($database, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $resetOut = Join-Path $RuntimeRoot "reset-failed.out"
  $resetErr = Join-Path $RuntimeRoot "reset-failed.err"
  $reset = Start-Process powershell.exe -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $resetScript + '"'),
    "-Confirmation", $confirmation
  ) -WindowStyle Hidden -RedirectStandardOutput $resetOut -RedirectStandardError $resetErr -PassThru -Wait
  Assert-That ($reset.ExitCode -ne 0) "reset fails closed when its current database cannot be backed up"
} finally { $lockedFile.Dispose() }
Assert-That ((Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash -eq $beforeHash -and
  -not (Test-Path (Join-Path $dataDirectory "reset-data.flag"))) "failed pre-reset backup leaves the database byte-identical and does not set a reset marker"
$reset = Start-Process powershell.exe -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $resetScript + '"'),
  "-Confirmation", $confirmation
) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RuntimeRoot "reset.out") `
  -RedirectStandardError (Join-Path $RuntimeRoot "reset.err") -PassThru -Wait
Assert-That ($reset.ExitCode -eq 0 -and -not (Test-Path $database)) "reset removes live data only after a verified current backup"
$preReset = Get-ChildItem (Join-Path $dataDirectory "backups") -Filter "pre-reset-*.db" -File |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$copy = Invoke-Fixture @("inspect", $preReset.FullName)
Assert-That ($copy.integrity -eq "ok" -and
  ($copy.data | ConvertTo-Json -Depth 10 -Compress) -eq ($beforeReset.data | ConvertTo-Json -Depth 10 -Compress)) "pre-reset snapshot holds exactly the latest document"
Copy-Item -LiteralPath $preReset.FullName -Destination $database
$restoredServer = Start-TestServer
try {
  $restored = Invoke-Api -Path "/data"
  Assert-That (($restored.Body.data | ConvertTo-Json -Depth 10 -Compress) -eq
    ($beforeReset.data | ConvertTo-Json -Depth 10 -Compress)) "the actual server serves the complete pre-reset document after restoration"
} finally { Stop-TestServer $restoredServer }

Write-Host ""
Write-Host "$($checks.Count) runtime checks passed."
$result.Checks = $checks.Count
return $result
