$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "browser.ps1")

$browser = Get-CgvBrowser
Start-Process -FilePath $browser.Path -ArgumentList @(
  "--app=http://127.0.0.1:3210/",
  "--user-data-dir=$($browser.AdminProfileDirectory)",
  "--no-first-run",
  "--disable-session-crashed-bubble"
)
