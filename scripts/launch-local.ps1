$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path $PSScriptRoot -Parent
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay"
$errorLog = Join-Path $runtimeDirectory "startup-error.log"

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

try {
  & (Join-Path $PSScriptRoot "restart-controller.ps1")
  & (Join-Path $PSScriptRoot "restart-server.ps1")
  & (Join-Path $PSScriptRoot "open-admin.ps1")

  if (Test-Path -LiteralPath $errorLog) {
    Remove-Item -LiteralPath $errorLog -Force
  }
} catch {
  $message = $_.Exception.Message
  [IO.File]::WriteAllText(
    $errorLog,
    "$(Get-Date -Format o)`r`n$message",
    (New-Object Text.UTF8Encoding($false))
  )

  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.MessageBox]::Show(
    "CGV 경품 안내를 시작하지 못했습니다.`r`n`r`n$message`r`n`r`n$errorLog",
    "CGV 경품 안내 실행 오류",
    [Windows.Forms.MessageBoxButtons]::OK,
    [Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}
