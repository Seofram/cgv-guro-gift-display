$ErrorActionPreference = "Stop"
$projectDirectory = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$localAppDataDirectory = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
$runtimeDirectory = [IO.Path]::GetFullPath(
  (Join-Path $localAppDataDirectory "CGVGiftDisplay")
)

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Target
  )

  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd(
    [IO.Path]::DirectorySeparatorChar
  )
  $targetPath = [IO.Path]::GetFullPath($Target)
  $prefix = $parentPath + [IO.Path]::DirectorySeparatorChar

  if (-not $targetPath.StartsWith(
    $prefix,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "안전하지 않은 제거 경로입니다: $targetPath"
  }

  return $targetPath
}

$runtimeDirectory = Assert-ChildPath `
  -Parent $localAppDataDirectory `
  -Target $runtimeDirectory

if ((Split-Path $runtimeDirectory -Leaf) -ne "CGVGiftDisplay") {
  throw "로컬 데이터 경로를 확인하지 못했습니다."
}

$generatedDirectories = @(
  ".runtime",
  "node_modules",
  ".next",
  ".vinext",
  ".wrangler",
  ".npm-cache",
  "build",
  "dist"
) | ForEach-Object {
  Assert-ChildPath `
    -Parent $projectDirectory `
    -Target (Join-Path $projectDirectory $_)
}

Write-Host ""
Write-Host "다음 항목을 제거합니다."
Write-Host "- 영화, 경품, 재고, 주의사항 데이터"
Write-Host "- 전시 제어 로그와 실행 상태"
Write-Host "- 자동 준비된 Node.js와 설치된 구성요소"
Write-Host "- 로컬 빌드 캐시"
Write-Host ""
Write-Host "프로그램 소스와 이 제거 파일은 남습니다."
$confirmation = Read-Host "계속하려면 '제거'를 입력하세요"

if ($confirmation -ne "제거") {
  Write-Host "취소되었습니다."
  exit 1
}

try {
  Invoke-RestMethod `
    -Uri "http://127.0.0.1:3210/display/close" `
    -Method Post `
    -TimeoutSec 3 | Out-Null
} catch {
  # The display controller may already be stopped.
}

$processTargets = @(
  @{ Port = 3210; Match = "display-controller.mjs" },
  @{ Port = 3000; Match = $projectDirectory }
)

foreach ($target in $processTargets) {
  $connections = @(
    Get-NetTCPConnection `
      -LocalPort $target.Port `
      -State Listen `
      -ErrorAction SilentlyContinue
  )

  foreach ($connection in $connections) {
    $ownerPid = $connection.OwningProcess
    $processInfo = Get-CimInstance `
      -ClassName Win32_Process `
      -Filter "ProcessId = $ownerPid" `
      -ErrorAction SilentlyContinue

    if ($processInfo.CommandLine -like "*$($target.Match)*") {
      Stop-Process -Id $ownerPid -Force -ErrorAction Stop
    }
  }
}

Start-Sleep -Milliseconds 700

if (Test-Path -LiteralPath $runtimeDirectory) {
  Remove-Item -LiteralPath $runtimeDirectory -Recurse -Force
}

foreach ($directory in $generatedDirectories) {
  if (Test-Path -LiteralPath $directory) {
    Remove-Item -LiteralPath $directory -Recurse -Force
  }
}
