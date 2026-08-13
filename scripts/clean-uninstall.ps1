$ErrorActionPreference = "Stop"
$projectDirectory = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$localAppDataDirectory = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
$runtimeDirectory = [IO.Path]::GetFullPath(
  (Join-Path $localAppDataDirectory "CGVGiftDisplay")
)
. (Join-Path $PSScriptRoot "server-process.ps1")

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

Write-Host ""
Write-Host "다음 항목을 제거합니다."
Write-Host "- 영화, 경품, 재고, 주의사항 데이터"
Write-Host "- 전시 제어 로그와 실행 상태"
Write-Host "- CGV 전용 Edge/Chrome 프로필"
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

Stop-CgvServer

Start-Sleep -Milliseconds 700

$profileMarker = [IO.Path]::Combine(
  $runtimeDirectory,
  "browser-profile-"
)
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -in @("msedge.exe", "chrome.exe") -and
    $_.CommandLine -and
    $_.CommandLine.IndexOf(
      $profileMarker,
      [StringComparison]::OrdinalIgnoreCase
    ) -ge 0
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

if (Test-Path -LiteralPath $runtimeDirectory) {
  Remove-Item -LiteralPath $runtimeDirectory -Recurse -Force
}
