param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [switch]$CrashWorker
)

# Focused fault injection against the actual packaged functions and SQLite
# store, under Windows PowerShell 5.1. No production paths or HTTP server.
$ErrorActionPreference = "Stop"
if (-not $CrashWorker) {
  if (Test-Path -LiteralPath $RuntimeRoot) { throw "Use a new isolated test directory." }
  New-Item -ItemType Directory -Path $RuntimeRoot | Out-Null
}
$script:DatabasePath = Join-Path $RuntimeRoot "inventory.db"
$script:BackupDirectory = Join-Path $RuntimeRoot "backups"
$script:BackupStateFile = Join-Path $RuntimeRoot "backup-state.json"
$script:BackupPendingFile = Join-Path $RuntimeRoot "backup-state.pending"
$script:BackupRecoveryFile = Join-Path $script:BackupDirectory "current-recovery.db"
$script:BackupErrorLog = Join-Path $RuntimeRoot "backup-error.log"
$script:BackupRetentionDays = 14
$script:BackupError = $null
$script:LastBackupAt = $null
. (Join-Path $PackageDirectory "scripts\sqlite-store.ps1")

$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PackageDirectory "scripts\local-server.ps1"), [ref]$tokens, [ref]$parseErrors
)
if ($parseErrors.Count) { throw "Packaged server does not parse." }
$names = @("Write-DurableBackupText", "Write-BackupState", "Read-BackupState",
  "Write-BackupFailure", "Save-Snapshot", "Save-DailyBackup", "Initialize-BackupStatus")
foreach ($definition in $ast.FindAll({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names
}, $true)) { Invoke-Expression $definition.Extent.Text }

if ($CrashWorker) {
  # Interrupt exactly after a temporary FAILURE state is durable, before the
  # old healthy marker can be replaced. The parent kills this worker process.
  function Backup-CgvData { throw "Injected snapshot failure" }
  function Write-BackupState {
    Write-DurableBackupText -Path ($script:BackupStateFile + ".tmp") -Text (
      @{ ok = $false; at = [DateTime]::UtcNow.ToString("o"); error = $script:BackupError } |
        ConvertTo-Json -Depth 4 -Compress
    )
    [IO.File]::WriteAllText((Join-Path $RuntimeRoot "crash-ready"), "ready")
    while ($true) { Start-Sleep -Milliseconds 100 }
  }
  Read-BackupState
  Save-DailyBackup
  exit 1
}

$checks = 0
function Assert-Backup {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "FAILED backup protocol: $Message" }
  $script:checks++
  Write-Host "  ok  $Message"
}
function Recover-Backup {
  Save-DailyBackup
  Assert-Backup ($null -eq $script:BackupError -and
    -not (Test-Path -LiteralPath $script:BackupPendingFile) -and
    -not (Test-Path -LiteralPath ($script:BackupStateFile + ".tmp"))) "verified recovery commits health and removes incomplete metadata"
  Initialize-BackupStatus
  Assert-Backup ($null -eq $script:BackupError) "health remains clear after startup revalidation"
}

$payload = '{"items":[],"settings":{"location":"isolated","title":"test","notices":[],"pageSeconds":8,"showSoldout":true},"updatedAt":"2026-11-16T00:00:00Z"}'
$written = Write-CgvData -DatabasePath $script:DatabasePath -Payload $payload -UpdatedAt "2026-11-16T00:00:00Z" -BaseRevision 0
$originalRecord = Read-CgvRecord -DatabasePath $script:DatabasePath
$daily = Join-Path $script:BackupDirectory ("inventory-" + (Get-Date).ToString("yyyyMMdd") + ".db")
Save-Snapshot -BackupPath $daily
$originalHash = (Get-FileHash -LiteralPath $daily).Hash
Assert-Backup ($null -eq $script:BackupError) "initial online backup is healthy"

# A later pending operation must dominate an older successful marker.
Write-DurableBackupText -Path $script:BackupPendingFile -Text "pending"
$worker = Start-Process powershell.exe -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $PSCommandPath + '"'),
  "-PackageDirectory", ('"' + $PackageDirectory + '"'),
  "-RuntimeRoot", ('"' + $RuntimeRoot + '"'), "-CrashWorker"
) -WindowStyle Hidden -PassThru
try {
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if (Test-Path -LiteralPath (Join-Path $RuntimeRoot "crash-ready")) { break }
    if ($worker.HasExited) { throw "Crash worker exited before injection point." }
    Start-Sleep -Milliseconds 100
  }
  Assert-Backup (Test-Path -LiteralPath (Join-Path $RuntimeRoot "crash-ready")) "worker reached durable temporary failure before marker replacement"
} finally {
  Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue
  $worker.WaitForExit()
}
$old = ConvertFrom-Json ([IO.File]::ReadAllText($script:BackupStateFile))
Assert-Backup $old.ok "interrupted failure leaves the older successful marker intact"
Initialize-BackupStatus
Assert-Backup ($null -ne $script:BackupError) "startup cannot mistake temporary failure plus old success for health"
Recover-Backup

# Actual Windows sharing violations: snapshot succeeds, marker replacement
# fails. Today's known-good daily snapshot must survive byte-for-byte.
$script:BackupError = @{ message = "injected unresolved state"; at = [DateTime]::UtcNow.ToString("o") }
$markerLock = [IO.File]::Open($script:BackupStateFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { Save-DailyBackup } finally { $markerLock.Dispose() }
Assert-Backup ($null -ne $script:BackupError) "marker replacement failure is reported even when the snapshot succeeds"
Assert-Backup ([CgvSqliteStore]::IntegrityCheck($script:BackupRecoveryFile) -eq "ok") "successful recovery snapshot exists despite failed success-state write"
Assert-Backup ((Get-FileHash -LiteralPath $daily).Hash -eq $originalHash) "recovery does not overwrite today's original daily snapshot"
Initialize-BackupStatus
Assert-Backup ($null -ne $script:BackupError) "incomplete success-state update remains a warning after restart"
Recover-Backup

# Both result recording and logging fail, while the separately flushed pending
# fence survives. Neither an old marker nor an unchanged log may imply health.
$script:BackupError = @{ message = "injected unresolved state"; at = [DateTime]::UtcNow.ToString("o") }
$tempLock = [IO.File]::Open(($script:BackupStateFile + ".tmp"), [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$logLock = [IO.File]::Open($script:BackupErrorLog, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { Save-DailyBackup } finally { $tempLock.Dispose(); $logLock.Dispose() }
Assert-Backup ($null -ne $script:BackupError -and (Test-Path -LiteralPath $script:BackupPendingFile)) "pending fence survives simultaneous state-recording and log-write failures"
Initialize-BackupStatus
Assert-Backup ($null -ne $script:BackupError) "restart remains conservative when failure state and log could not be written"
Recover-Backup

# If NO filesystem mutation is possible there may be no new durable evidence.
# Refuse backup work, and require fresh fenced proof instead of old success on
# startup. These function-level I/O faults avoid changing host filesystem ACLs.
$originalWriter = (Get-Item Function:Write-DurableBackupText).ScriptBlock
$originalStateWriter = (Get-Item Function:Write-BackupState).ScriptBlock
function Write-DurableBackupText { throw "Injected durable write failure" }
function Write-BackupState { throw "Injected state write failure" }
$logLock = [IO.File]::Open($script:BackupErrorLog, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$snapshotHash = (Get-FileHash -LiteralPath $script:BackupRecoveryFile).Hash
try {
  $script:BackupError = @{ message = "retry"; at = [DateTime]::UtcNow.ToString("o") }
  Save-DailyBackup
  Assert-Backup ($null -ne $script:BackupError -and
    (Get-FileHash -LiteralPath $script:BackupRecoveryFile).Hash -eq $snapshotHash) "failure to persist pending state prevents any snapshot mutation"
  Initialize-BackupStatus
  Assert-Backup ($null -ne $script:BackupError) "startup never trusts old success while fresh durable proof is impossible"
} finally {
  $logLock.Dispose()
  Set-Item Function:Write-DurableBackupText $originalWriter
  Set-Item Function:Write-BackupState $originalStateWriter
}
Recover-Backup

# Partial pending records, corrupt/partial temporary records, and healthy
# temporary records all represent an uncommitted transition.
foreach ($evidence in @($script:BackupPendingFile, ($script:BackupStateFile + ".tmp"))) {
  Write-DurableBackupText -Path $evidence -Text "{partial"
  Initialize-BackupStatus
  Assert-Backup ($null -ne $script:BackupError) "partial transition metadata remains unknown on startup"
  Recover-Backup
}
$record = Read-CgvRecord -DatabasePath $script:DatabasePath
Assert-Backup ($record.Revision -eq $originalRecord.Revision -and $record.Payload -ceq $originalRecord.Payload) "all backup faults and recovery attempts leave inventory and revision unchanged"
Assert-Backup ((Get-FileHash -LiteralPath $daily).Hash -eq $originalHash) "the original verified daily backup remains byte-identical"
Write-Host "$checks focused backup protocol checks passed."
return $checks
