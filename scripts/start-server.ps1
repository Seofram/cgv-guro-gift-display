$ErrorActionPreference = "Stop"
$installDirectory = Split-Path $PSScriptRoot -Parent
$serverScript = Join-Path $PSScriptRoot "local-server.ps1"
$healthUrl = "http://127.0.0.1:3210/health"
. (Join-Path $PSScriptRoot "server-process.ps1")

try {
  $healthy = $false
  try {
    $result = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    $healthy = [bool]$result.ok -and $result.runtime -eq "powershell"
    if ($result.ok -and -not $healthy) {
      Stop-CgvServer
    }
  } catch {
    $healthy = $false
  }

  if (-not $healthy) {
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList @(
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      ('"' + $serverScript + '"'),
      "-NoOpen"
    ) -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
      Start-Sleep -Milliseconds 50
      if ($process.HasExited) {
        $logPath = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay\server-error.log"
        $detail = if (Test-Path -LiteralPath $logPath) {
          [IO.File]::ReadAllText($logPath, [Text.Encoding]::UTF8)
        } else {
          "오류 로그가 생성되지 않았습니다."
        }
        throw "로컬 서버가 시작 중 종료되었습니다.$([Environment]::NewLine)$([Environment]::NewLine)$detail"
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
    throw "로컬 서버가 4초 안에 준비되지 않았습니다."
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
