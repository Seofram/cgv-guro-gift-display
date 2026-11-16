$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "browser.ps1")

$browser = Get-CgvBrowser
Start-Process -FilePath $browser.Path -ArgumentList @(
  "--app=http://127.0.0.1:3210/",
  # Windows PowerShell 5.1 does not quote arguments; a profile path with a
  # space (C:\Users\First Last) must be quoted explicitly.
  ('--user-data-dir="' + $browser.AdminProfileDirectory + '"'),
  "--no-first-run",
  "--disable-session-crashed-bubble"
)
