param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Open", "Close", "Status")]
  [string]$Action
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "browser.ps1")
$stateDirectory = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay"
$stateFile = Join-Path $stateDirectory "display-window.txt"

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class CgvDisplayWindow {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(
        IntPtr hWnd,
        out uint processId
    );

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int X,
        int Y,
        int cx,
        int cy,
        uint uFlags
    );

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(
        IntPtr hWnd,
        uint Msg,
        IntPtr wParam,
        IntPtr lParam
    );

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern void keybd_event(
        byte virtualKey,
        byte scanCode,
        uint flags,
        UIntPtr extraInfo
    );

    public static IntPtr[] FindWindows(string titlePart) {
        var matches = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            int length = GetWindowTextLength(hWnd);
            if (length == 0) return true;

            var title = new StringBuilder(length + 1);
            GetWindowText(hWnd, title, title.Capacity);
            if (title.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) >= 0) {
                matches.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return matches.ToArray();
    }

    public static IntPtr[] FindProcessWindows(string processName) {
        var matches = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;

            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId == 0) return true;

            try {
                using (var process = Process.GetProcessById((int)processId)) {
                    if (string.Equals(
                        process.ProcessName,
                        processName,
                        StringComparison.OrdinalIgnoreCase
                    )) {
                        matches.Add(hWnd);
                    }
                }
            } catch {
                // The process may have exited during enumeration.
            }
            return true;
        }, IntPtr.Zero);
        return matches.ToArray();
    }

    public static void SendAltF4() {
        const byte VK_MENU = 0x12;
        const byte VK_F4 = 0x73;
        const uint KEYUP = 0x0002;
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_F4, 0, 0, UIntPtr.Zero);
        keybd_event(VK_F4, 0, KEYUP, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);
    }
}
"@

function Get-TrackedDisplayHandles {
  param([IntPtr[]]$KnownHandles)

  $tracked = @(
    $KnownHandles |
      Where-Object { [CgvDisplayWindow]::IsWindow($_) }
  )
  $tracked += @(
    [CgvDisplayWindow]::FindWindows("CGV 구로 경품 전시 화면")
  )
  return @($tracked | Sort-Object { $_.ToInt64() } -Unique)
}

function Close-DisplayWindow {
  $handles = @(
    [CgvDisplayWindow]::FindWindows("CGV 구로 경품 전시 화면")
  )

  if (Test-Path -LiteralPath $stateFile) {
    $handleText = (Get-Content -Raw -LiteralPath $stateFile).Trim()
    $handleValue = 0L
    if (
      [long]::TryParse($handleText, [ref]$handleValue) -and
      $handleValue -ne 0 -and
      [CgvDisplayWindow]::IsWindow([IntPtr]$handleValue)
    ) {
      $handles += [IntPtr]$handleValue
    }
  }

  $handles = @($handles | Sort-Object { $_.ToInt64() } -Unique)
  $knownHandles = @($handles)
  foreach ($handle in $handles) {
    [void][CgvDisplayWindow]::PostMessage(
      $handle,
      0x0112,
      [IntPtr]0xF060,
      [IntPtr]::Zero
    )
  }

  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Milliseconds 200
    $remaining = @(Get-TrackedDisplayHandles -KnownHandles $knownHandles)
    if ($remaining.Count -eq 0) {
      break
    }
  }

  if ($remaining.Count -gt 0) {
    foreach ($handle in $remaining) {
      [void][CgvDisplayWindow]::SetForegroundWindow($handle)
      Start-Sleep -Milliseconds 120
      [CgvDisplayWindow]::SendAltF4()
    }

    for ($attempt = 0; $attempt -lt 15; $attempt++) {
      Start-Sleep -Milliseconds 200
      $remaining = @(Get-TrackedDisplayHandles -KnownHandles $knownHandles)
      if ($remaining.Count -eq 0) {
        break
      }
    }
  }

  if ($remaining.Count -gt 0) {
    throw "전시 화면이 닫히지 않았습니다."
  }

  Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
}

if ($Action -eq "Status") {
  $knownHandles = @()
  if (Test-Path -LiteralPath $stateFile) {
    $handleText = (Get-Content -Raw -LiteralPath $stateFile).Trim()
    $handleValue = 0L
    if ([long]::TryParse($handleText, [ref]$handleValue) -and $handleValue -ne 0) {
      $knownHandles += [IntPtr]$handleValue
    }
  }

  $runningHandles = @(
    Get-TrackedDisplayHandles -KnownHandles $knownHandles
  )
  if ($runningHandles.Count -gt 0) {
    Write-Output "running"
  } else {
    Write-Output "stopped"
  }
  exit 0
}

if ($Action -eq "Close") {
  Close-DisplayWindow
  Write-Output "closed"
  exit 0
}

Close-DisplayWindow
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

$screens = [System.Windows.Forms.Screen]::AllScreens
$targetScreen = $screens | Where-Object { -not $_.Primary } | Select-Object -First 1
if (-not $targetScreen) {
  $targetScreen = [System.Windows.Forms.Screen]::PrimaryScreen
}

$bounds = $targetScreen.Bounds
$browser = Get-CgvBrowser
$existingBrowserHandles = @(
  [CgvDisplayWindow]::FindProcessWindows($browser.ProcessName) |
    ForEach-Object { $_.ToInt64() }
)
$arguments = @(
  "--kiosk",
  "http://127.0.0.1:3210/?view=display",
  "--user-data-dir=$($browser.DisplayProfileDirectory)",
  "--no-first-run",
  "--disable-session-crashed-bubble",
  "--window-position=$($bounds.X),$($bounds.Y)",
  "--window-size=$($bounds.Width),$($bounds.Height)"
)
if ($browser.Name -eq "edge") {
  $arguments += "--edge-kiosk-type=fullscreen"
}

Start-Process -FilePath $browser.Path -ArgumentList $arguments | Out-Null

$handle = [IntPtr]::Zero
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  Start-Sleep -Milliseconds 200
  $displayHandles = @(
    [CgvDisplayWindow]::FindWindows("CGV 구로 경품 전시 화면")
  )
  $newBrowserHandles = @(
    [CgvDisplayWindow]::FindProcessWindows($browser.ProcessName) |
      Where-Object { $existingBrowserHandles -notcontains $_.ToInt64() }
  )

  if ($displayHandles.Count -gt 0) {
    $handle = $displayHandles[0]
    break
  }
  if ($newBrowserHandles.Count -gt 0) {
    $handle = $newBrowserHandles[0]
    break
  }
}

if ($handle -eq [IntPtr]::Zero) {
  throw "전시 화면 창을 찾을 수 없습니다."
}

[void][CgvDisplayWindow]::SetWindowPos(
  $handle,
  [IntPtr](-1),
  $bounds.X,
  $bounds.Y,
  $bounds.Width,
  $bounds.Height,
  0x0040
)

$handle.ToInt64().ToString() | Set-Content -LiteralPath $stateFile -Encoding ascii
Write-Output "opened:$($targetScreen.DeviceName):$($bounds.Width)x$($bounds.Height)"
