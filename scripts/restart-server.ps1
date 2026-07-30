$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path $PSScriptRoot -Parent
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay"
$standardLog = Join-Path $runtimeDirectory "server.log"
$errorLog = Join-Path $runtimeDirectory "server-error.log"

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

$connections = @(
  Get-NetTCPConnection `
    -LocalPort 3000 `
    -State Listen `
    -ErrorAction SilentlyContinue
)

foreach ($connection in $connections) {
  $ownerPid = $connection.OwningProcess
  $processInfo = Get-CimInstance `
    -ClassName Win32_Process `
    -Filter "ProcessId = $ownerPid" `
    -ErrorAction SilentlyContinue

  if (
    $processInfo.CommandLine -like "*$projectDirectory*" -or
    $processInfo.CommandLine -like "*vinext*"
  ) {
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
  } else {
    throw "포트 3000을 다른 프로그램이 사용 중입니다."
  }
}

$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
Start-Process `
  -FilePath $npmPath `
  -ArgumentList @("run", "dev") `
  -WorkingDirectory $projectDirectory `
  -WindowStyle Hidden `
  -RedirectStandardOutput $standardLog `
  -RedirectStandardError $errorLog

for ($attempt = 0; $attempt -lt 100; $attempt++) {
  Start-Sleep -Milliseconds 150
  $serverConnection = Get-NetTCPConnection `
    -LocalPort 3000 `
    -State Listen `
    -ErrorAction SilentlyContinue

  if ($serverConnection) {
    exit 0
  }
}

throw "로컬 서버가 제한 시간 안에 시작되지 않았습니다."
