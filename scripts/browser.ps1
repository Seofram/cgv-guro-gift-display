$ErrorActionPreference = "Stop"

function Get-CgvBrowser {
  $installDirectory = Split-Path $PSScriptRoot -Parent
  $settingsPath = Join-Path $installDirectory "browser-settings.json"
  $browserName = "edge"
  $configuredPath = ""

  if (Test-Path -LiteralPath $settingsPath) {
    try {
      $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
      if ($settings.browser) {
        $browserName = ([string]$settings.browser).Trim().ToLowerInvariant()
      }
      if ($settings.executablePath) {
        $configuredPath = [Environment]::ExpandEnvironmentVariables(
          ([string]$settings.executablePath).Trim()
        )
      }
    } catch {
      throw "browser-settings.json 파일을 읽을 수 없습니다: $($_.Exception.Message)"
    }
  }

  if ($browserName -notin @("edge", "chrome")) {
    throw "browser 값은 edge 또는 chrome이어야 합니다."
  }

  if ($configuredPath) {
    if (-not (Test-Path -LiteralPath $configuredPath -PathType Leaf)) {
      throw "설정한 브라우저 실행 파일을 찾을 수 없습니다: $configuredPath"
    }
    $executablePath = $configuredPath
  } else {
    if ($browserName -eq "chrome") {
      $candidates = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
      )
    } else {
      $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
      )
    }

    $executablePath = $candidates |
      Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
      Select-Object -First 1
  }

  if (-not $executablePath) {
    $displayName = if ($browserName -eq "chrome") { "Google Chrome" } else { "Microsoft Edge" }
    throw "$displayName 브라우저를 찾을 수 없습니다. browser-settings.json을 확인하세요."
  }

  $profileRoot = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay"
  $adminProfileDirectory = Join-Path $profileRoot "browser-profile-$browserName-admin"
  $displayProfileDirectory = Join-Path $profileRoot "browser-profile-$browserName-display"
  New-Item -ItemType Directory -Path $adminProfileDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $displayProfileDirectory -Force | Out-Null

  [PSCustomObject]@{
    Name = $browserName
    Path = $executablePath
    ProcessName = if ($browserName -eq "chrome") { "chrome" } else { "msedge" }
    AdminProfileDirectory = $adminProfileDirectory
    DisplayProfileDirectory = $displayProfileDirectory
  }
}
