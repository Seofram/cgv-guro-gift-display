$ErrorActionPreference = "Stop"
$controllerName = "display-controller.mjs"
$controllerPath = Join-Path $PSScriptRoot $controllerName
$projectDirectory = Split-Path $PSScriptRoot -Parent

$connections = @(
  Get-NetTCPConnection `
    -LocalAddress "127.0.0.1" `
    -LocalPort 3210 `
    -State Listen `
    -ErrorAction SilentlyContinue
)

foreach ($connection in $connections) {
  $ownerPid = $connection.OwningProcess
  $processInfo = Get-CimInstance `
    -ClassName Win32_Process `
    -Filter "ProcessId = $ownerPid" `
    -ErrorAction SilentlyContinue

  if ($processInfo.CommandLine -like "*$controllerName*") {
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
  }
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
Start-Process `
  -FilePath $nodePath `
  -ArgumentList @("--no-warnings", "`"$controllerPath`"") `
  -WorkingDirectory $projectDirectory `
  -WindowStyle Hidden
