[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ApplicationPath,
  [string]$ReportPath
)

$ErrorActionPreference = "Stop"
$readyMainTitle = "CGV 구로 경품 관리"
$readyDisplayTitle = "CGV 구로 경품 전시 화면"
$databasePath = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay\inventory.db"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

$resolvedApplication = (Resolve-Path -LiteralPath $ApplicationPath).Path
if ([IO.Path]::GetExtension($resolvedApplication) -ne ".exe") {
  throw "ApplicationPath must point to the installed Windows executable."
}

$runningApplication = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  try {
    $_.Path -eq $resolvedApplication
  } catch {
    $false
  }
}
if ($runningApplication) {
  throw "Close the installed CGV application before verification."
}
if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
  throw "Existing inventory database was not found at $databasePath."
}

if (-not $ReportPath) {
  $ReportPath = Join-Path (Split-Path $databasePath -Parent) "desktop-verification-$timestamp.json"
}
$reportDirectory = Split-Path $ReportPath -Parent
if ($reportDirectory) {
  New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class CgvWindowRecord
{
    public string Title { get; set; }
    public int Left { get; set; }
    public int Top { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}

public static class CgvNativeWindows
{
    private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximum);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr handle, out Rect rectangle);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);

    public static CgvWindowRecord[] ForProcess(int expectedProcessId)
    {
        var windows = new List<CgvWindowRecord>();
        EnumWindows((handle, parameter) =>
        {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (processId != expectedProcessId || !IsWindowVisible(handle))
            {
                return true;
            }

            var titleLength = GetWindowTextLength(handle);
            if (titleLength == 0)
            {
                return true;
            }

            var title = new StringBuilder(titleLength + 1);
            GetWindowText(handle, title, title.Capacity);
            Rect rectangle;
            if (!GetWindowRect(handle, out rectangle))
            {
                return true;
            }

            windows.Add(new CgvWindowRecord
            {
                Title = title.ToString(),
                Left = rectangle.Left,
                Top = rectangle.Top,
                Width = rectangle.Right - rectangle.Left,
                Height = rectangle.Bottom - rectangle.Top
            });
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
"@

function Wait-CgvWindows {
  param(
    [Diagnostics.Process]$Process,
    [string[]]$Titles,
    [int]$TimeoutMilliseconds = 45000
  )

  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
    Start-Sleep -Milliseconds 25
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "The desktop application exited before all native windows were ready."
    }

    $windows = @([CgvNativeWindows]::ForProcess($Process.Id))
    $ready = $true
    foreach ($title in $Titles) {
      if (-not ($windows | Where-Object Title -eq $title)) {
        $ready = $false
        break
      }
    }
    if ($ready) {
      $timer.Stop()
      return [pscustomobject]@{
        StartupMilliseconds = $timer.ElapsedMilliseconds
        Windows = $windows
      }
    }
  }

  throw "Native windows were not ready within $TimeoutMilliseconds ms."
}

function Stop-CgvProcess {
  param([Diagnostics.Process]$Process)

  if (-not $Process -or $Process.HasExited) {
    return
  }
  $Process.CloseMainWindow() | Out-Null
  if (-not $Process.WaitForExit(5000)) {
    $Process.Kill()
    $Process.WaitForExit()
  }
}

function Get-ListeningPorts {
  param([int]$ProcessId)

  return @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object OwningProcess -eq $ProcessId |
      Select-Object LocalAddress, LocalPort
  )
}

$backupPath = Join-Path (Split-Path $databasePath -Parent) "inventory.pre-desktop-verification-$timestamp.bak"
Copy-Item -LiteralPath $databasePath -Destination $backupPath

$screens = @(
  [Windows.Forms.Screen]::AllScreens |
    ForEach-Object {
      [pscustomobject]@{
        DeviceName = $_.DeviceName
        Primary = $_.Primary
        Left = $_.Bounds.Left
        Top = $_.Bounds.Top
        Width = $_.Bounds.Width
        Height = $_.Bounds.Height
      }
    }
)
if ($screens.Count -lt 2) {
  throw "Two physical Windows displays are required. Detected: $($screens.Count)."
}

$installDirectory = Split-Path $resolvedApplication -Parent
$forbiddenRuntime = @(
  Get-ChildItem -LiteralPath $installDirectory -Recurse -File |
    Where-Object Name -Match "^(node|npm|npx|chrome|msedge)(\.exe|\.cmd)?$"
)
if ($forbiddenRuntime) {
  throw "A forbidden runtime is bundled: $($forbiddenRuntime.FullName -join ', ')."
}

$installedBytes = (Get-ChildItem -LiteralPath $installDirectory -Recurse -File | Measure-Object Length -Sum).Sum
if ($installedBytes -gt 50MB) {
  throw "Installed footprint exceeds 50 MiB: $([math]::Round($installedBytes / 1MB, 2)) MiB."
}

$verificationProcess = $null
$warmProcess = $null
try {
  $verificationProcess = Start-Process -FilePath $resolvedApplication -ArgumentList "--verify-display" -PassThru
  $verification = Wait-CgvWindows -Process $verificationProcess -Titles @($readyMainTitle, $readyDisplayTitle)

  $listeners = Get-ListeningPorts -ProcessId $verificationProcess.Id
  if ($listeners.Count -gt 0) {
    throw "The installed application opened a local listening port."
  }

  $displayWindow = $verification.Windows | Where-Object Title -eq $readyDisplayTitle | Select-Object -First 1
  $displayCenterX = $displayWindow.Left + [math]::Floor($displayWindow.Width / 2)
  $displayCenterY = $displayWindow.Top + [math]::Floor($displayWindow.Height / 2)
  $displayScreen = $screens |
    Where-Object {
      $displayCenterX -ge $_.Left -and
      $displayCenterX -lt ($_.Left + $_.Width) -and
      $displayCenterY -ge $_.Top -and
      $displayCenterY -lt ($_.Top + $_.Height)
    } |
    Select-Object -First 1
  if (-not $displayScreen -or $displayScreen.Primary) {
    throw "The display window was not placed on a non-primary monitor."
  }

  $fullscreen = (
    [math]::Abs($displayWindow.Left - $displayScreen.Left) -le 2 -and
    [math]::Abs($displayWindow.Top - $displayScreen.Top) -le 2 -and
    [math]::Abs($displayWindow.Width - $displayScreen.Width) -le 2 -and
    [math]::Abs($displayWindow.Height - $displayScreen.Height) -le 2
  )
  if (-not $fullscreen) {
    throw "The display window does not cover the selected monitor."
  }

  $confirmation = Read-Host "관리 창에 기존 영화/경품 데이터가 정상 표시됩니까? (Y/N)"
  if ($confirmation -notmatch "^(?i:y|yes)$") {
    throw "Existing database contents were not confirmed by the operator."
  }

  Stop-CgvProcess -Process $verificationProcess
  $verificationProcess = $null
  Start-Sleep -Milliseconds 500

  $warmProcess = Start-Process -FilePath $resolvedApplication -PassThru
  $warm = Wait-CgvWindows -Process $warmProcess -Titles @($readyMainTitle) -TimeoutMilliseconds 15000
  $warmListeners = Get-ListeningPorts -ProcessId $warmProcess.Id
  if ($warmListeners.Count -gt 0) {
    throw "The warm-started application opened a local listening port."
  }
  if ($warm.StartupMilliseconds -gt 2000) {
    throw "Warm startup exceeded 2000 ms: $($warm.StartupMilliseconds) ms."
  }

  $report = [ordered]@{
    Status = "passed"
    VerifiedAt = (Get-Date).ToString("o")
    ApplicationPath = $resolvedApplication
    ApplicationSha256 = (Get-FileHash -LiteralPath $resolvedApplication -Algorithm SHA256).Hash
    InstalledMiB = [math]::Round($installedBytes / 1MB, 2)
    BundledNodeNpmBrowserRuntime = $false
    LocalListeningServer = $false
    DatabasePath = $databasePath
    DatabaseBackupPath = $backupPath
    ExistingDataConfirmedByOperator = $true
    MonitorCount = $screens.Count
    Monitors = $screens
    DisplayMonitor = $displayScreen
    DisplayFullscreen = $fullscreen
    VerificationLaunchMilliseconds = $verification.StartupMilliseconds
    WarmStartupMilliseconds = $warm.StartupMilliseconds
    WarmStartupTargetMilliseconds = 2000
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
  Write-Host "검증 통과: $ReportPath"
  Write-Host "DB 백업: $backupPath"
} catch {
  $failure = [ordered]@{
    Status = "failed"
    VerifiedAt = (Get-Date).ToString("o")
    ApplicationPath = $resolvedApplication
    DatabasePath = $databasePath
    DatabaseBackupPath = $backupPath
    Error = $_.Exception.Message
  }
  $failure | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReportPath -Encoding utf8
  Write-Error "검증 실패: $ReportPath"
  throw
} finally {
  Stop-CgvProcess -Process $verificationProcess
  Stop-CgvProcess -Process $warmProcess
}
