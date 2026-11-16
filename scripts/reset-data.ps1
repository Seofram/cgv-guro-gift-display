param(
  # For unattended use (tests). When empty, the operator is asked to type it.
  [string]$Confirmation = ""
)

$ErrorActionPreference = "Stop"
$installDirectory = Split-Path $PSScriptRoot -Parent
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay"
$backupDirectory = Join-Path $runtimeDirectory "backups"
$databasePath = Join-Path $runtimeDirectory "inventory.db"
. (Join-Path $PSScriptRoot "server-process.ps1")

Write-Host ""
Write-Host "CGV 경품 안내의 영화, 경품, 재고, 주의사항 데이터를 모두 제거합니다."
Write-Host "제거하기 전에 현재 데이터를 backups 폴더에 백업합니다."
Write-Host "(백업 폴더는 지우지 않습니다: %LOCALAPPDATA%\CGVGiftDisplay\backups)"
if (-not $Confirmation) {
  $Confirmation = Read-Host "계속하려면 '초기화'를 입력하세요"
}

if ($Confirmation -ne "초기화") {
  Write-Host "취소되었습니다."
  exit 1
}

try {
  Invoke-RestMethod `
    -Uri "http://127.0.0.1:3210/display/close" `
    -Method Post `
    -TimeoutSec 3 | Out-Null
} catch {
  # The display controller may already be stopped.
}

Stop-CgvServer

Start-Sleep -Milliseconds 500
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

$dataFiles = @(
  "inventory.db",
  "inventory.db-wal",
  "inventory.db-shm",
  "display-data.json"
)
$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss-fff")

# The current data is never simply deleted. First a verified SQLite snapshot
# is taken; only when that snapshot can be read back are the live files
# removed. If the snapshot cannot be made (for example the database is
# damaged), reset stops and leaves the live files in place.
if (Test-Path -LiteralPath $databasePath -PathType Leaf) {
  New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
  $snapshotPath = Join-Path $backupDirectory "pre-reset-$stamp.db"
  $snapshotOk = $false
  $snapshotEmpty = $false
  $snapshotError = ""
  try {
    . (Join-Path $PSScriptRoot "sqlite-store.ps1")
    if ($null -eq (Read-CgvRecord -DatabasePath $databasePath)) {
      # Nothing has ever been saved; there is nothing to protect.
      $snapshotEmpty = $true
    } else {
      Backup-CgvData -DatabasePath $databasePath -Destination $snapshotPath
      $check = [CgvSqliteStore]::IntegrityCheck($snapshotPath)
      $copy = [CgvSqliteStore]::ReadSnapshot($snapshotPath)
      if ($check -ne "ok" -or $null -eq $copy -or -not $copy.Payload) {
        throw "백업 파일을 확인하지 못했습니다: $check"
      }
      $snapshotOk = $true
    }
  } catch {
    $snapshotError = $_.Exception.Message
    Remove-Item -LiteralPath $snapshotPath -Force -ErrorAction SilentlyContinue
  }

  if ($snapshotOk) {
    Write-Host "초기화 전 데이터를 백업했습니다: $snapshotPath"
  } elseif (-not $snapshotEmpty) {
    throw "초기화 전 백업을 확인하지 못해 초기화를 취소했습니다. 데이터는 그대로 보관됩니다. ($snapshotError)"
  }
}

foreach ($fileName in $dataFiles) {
  $filePath = Join-Path $runtimeDirectory $fileName
  if (Test-Path -LiteralPath $filePath) {
    Remove-Item -LiteralPath $filePath -Force
  }
}

$resetMarker = Join-Path $runtimeDirectory "reset-data.flag"
[IO.File]::WriteAllText(
  $resetMarker,
  (Get-Date).ToUniversalTime().ToString("o"),
  (New-Object System.Text.UTF8Encoding($false))
)
