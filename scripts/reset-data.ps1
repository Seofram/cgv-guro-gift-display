$ErrorActionPreference = "Stop"
$installDirectory = Split-Path $PSScriptRoot -Parent
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay"

Write-Host ""
Write-Host "CGV 경품 안내의 영화, 경품, 재고, 주의사항 데이터를 모두 제거합니다."
Write-Host "제거된 데이터는 복구할 수 없습니다."
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

$serverPath = [IO.Path]::GetFullPath(
  (Join-Path $installDirectory "cgv-gift-server.exe")
)
$connections = @(
  Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue
)
foreach ($connection in $connections) {
  $processInfo = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
  if (
    $processInfo -and
    $processInfo.Path -and
    ([IO.Path]::GetFullPath($processInfo.Path) -eq $serverPath)
  ) {
    Stop-Process -Id $processInfo.Id -Force -ErrorAction Stop
  }
}

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
