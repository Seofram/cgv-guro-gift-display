$ErrorActionPreference = "Stop"

$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
)

$edgePath = $candidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  Select-Object -First 1

if ($edgePath) {
  Start-Process -FilePath $edgePath -ArgumentList @(
    "--new-window",
    "http://localhost:3000/"
  )
} else {
  Start-Process "http://localhost:3000/"
}
