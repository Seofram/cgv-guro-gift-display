$ErrorActionPreference = "Stop"
$installDirectory = Split-Path $PSScriptRoot -Parent
$application = Join-Path $installDirectory "cgv-gift-server.exe"
$healthUrl = "http://127.0.0.1:3210/health"

try {
  $healthy = $false
  try {
    $result = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    $healthy = [bool]$result.ok
  } catch {
    $healthy = $false
  }

  if (-not $healthy) {
    $process = Start-Process -FilePath $application -ArgumentList "--no-open" -PassThru
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      Start-Sleep -Milliseconds 50
      if ($process.HasExited) {
        throw "The local display server exited during startup."
      }
      try {
        $result = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        if ($result.ok) {
          $healthy = $true
          break
        }
      } catch {
        $healthy = $false
      }
    }
  }

  if (-not $healthy) {
    throw "The local display server was not ready within two seconds."
  }

  & (Join-Path $PSScriptRoot "open-admin.ps1")
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.MessageBox]::Show(
    "CGV 경품 안내를 시작하지 못했습니다.`r`n`r`n$($_.Exception.Message)",
    "CGV 경품 안내 실행 오류",
    [Windows.Forms.MessageBoxButtons]::OK,
    [Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}
