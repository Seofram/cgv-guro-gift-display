$ErrorActionPreference = "Stop"

function Stop-CgvServer {
  $runtimeDirectory = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay"
  $pidFile = Join-Path $runtimeDirectory "server.pid"
  $candidateIds = @()

  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = 0
    if ([int]::TryParse(
      (Get-Content -Raw -LiteralPath $pidFile).Trim(),
      [ref]$savedPid
    )) {
      $candidateIds += $savedPid
    }
  }

  # Stop supervisors first; otherwise they would start the server again.
  $serverProcesses = @(
    Get-CimInstance Win32_Process -Filter (
      "Name = 'powershell.exe' OR Name = 'pwsh.exe'"
    ) -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine.IndexOf(
          "local-server.ps1",
          [StringComparison]::OrdinalIgnoreCase
        ) -ge 0
      }
  )
  foreach ($serverProcess in $serverProcesses) {
    if ($serverProcess.CommandLine.IndexOf(
      "-Supervise",
      [StringComparison]::OrdinalIgnoreCase
    ) -ge 0) {
      Stop-Process -Id $serverProcess.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  $candidateIds += @($serverProcesses | ForEach-Object { [int]$_.ProcessId })

  $connections = @(
    Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue
  )
  $candidateIds += @($connections | ForEach-Object { $_.OwningProcess })
  $candidateIds = @($candidateIds | Sort-Object -Unique)

  foreach ($candidateId in $candidateIds) {
    $process = Get-CimInstance Win32_Process -Filter (
      "ProcessId = $candidateId"
    ) -ErrorAction SilentlyContinue
    if (-not $process) { continue }

    $isPowerShellServer = (
      $process.Name -in @("powershell.exe", "pwsh.exe") -and
      $process.CommandLine -and
      $process.CommandLine.IndexOf(
        "local-server.ps1",
        [StringComparison]::OrdinalIgnoreCase
      ) -ge 0
    )
    $isLegacyServer = $process.Name -eq "cgv-gift-server.exe"
    if ($isPowerShellServer -or $isLegacyServer) {
      Stop-Process -Id $candidateId -Force -ErrorAction SilentlyContinue
    }
  }

  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
