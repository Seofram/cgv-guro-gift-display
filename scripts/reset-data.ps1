$ErrorActionPreference = "Stop"
$installDirectory = Split-Path $PSScriptRoot -Parent
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay"
. (Join-Path $PSScriptRoot "server-process.ps1")

Write-Host ""
Write-Host "CGV 경품 안내의 영화, 경품, 재고, 주의사항 데이터를 모두 제거합니다."
Write-Host "초기화 전의 데이터는 backups 폴더의 일일 백업으로만 복구할 수 있습니다."
Write-Host "(백업 폴더는 지우지 않습니다: %LOCALAPPDATA%\CGVGiftDisplay\backups)"
$confirmation = Read-Host "계속하려면 '초기화'를 입력하세요"

if ($confirmation -ne "초기화") {
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
