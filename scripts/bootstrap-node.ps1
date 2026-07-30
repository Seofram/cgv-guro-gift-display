param(
  [switch]$ForcePortable,
  [string]$RuntimeRoot
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$minimumVersion = [version]"22.13.0"
$nodeVersion = "22.23.2"
$projectDirectory = Split-Path $PSScriptRoot -Parent

if (-not $RuntimeRoot) {
  $RuntimeRoot = Join-Path $projectDirectory ".runtime"
} elseif (-not [IO.Path]::IsPathRooted($RuntimeRoot)) {
  $RuntimeRoot = Join-Path $projectDirectory $RuntimeRoot
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)

$pathFile = Join-Path $RuntimeRoot "node-path.txt"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Save-NodePath {
  param([string]$NodeDirectory)
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  [IO.File]::WriteAllText($pathFile, $NodeDirectory, $utf8NoBom)
}

function Get-NodeVersion {
  param([string]$NodeExecutable)
  try {
    $versionText = (& $NodeExecutable --version 2>$null).Trim()
    return [version]$versionText.TrimStart("v")
  } catch {
    return $null
  }
}

if (-not $ForcePortable) {
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode) {
    $systemVersion = Get-NodeVersion -NodeExecutable $systemNode.Source
    if ($systemVersion -and $systemVersion -ge $minimumVersion) {
      Save-NodePath -NodeDirectory (Split-Path $systemNode.Source -Parent)
      Write-Output "Using system Node.js $systemVersion"
      exit 0
    }
  }
}

$architecture = (
  [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
).ToLowerInvariant()

$checksums = @{
  "x64" = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
  "arm64" = "fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3"
  "x86" = "725c9e2bdd1c2016b41c995a81f4fa36ce4e2ee565b7455d8f889182727df647"
}

if (-not $checksums.ContainsKey($architecture)) {
  throw "Unsupported Windows architecture: $architecture"
}

$archiveName = "node-v$nodeVersion-win-$architecture.zip"
$downloadUrl = "https://nodejs.org/dist/v$nodeVersion/$archiveName"
$archivePath = Join-Path $RuntimeRoot $archiveName
$nodeDirectory = Join-Path $RuntimeRoot "node-v$nodeVersion-win-$architecture"
$nodeExecutable = Join-Path $nodeDirectory "node.exe"

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null

if (-not (Test-Path -LiteralPath $nodeExecutable)) {
  if (Test-Path -LiteralPath $archivePath) {
    $existingHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($existingHash -ne $checksums[$architecture]) {
      Remove-Item -LiteralPath $archivePath -Force
    }
  }

  if (-not (Test-Path -LiteralPath $archivePath)) {
    Write-Output "Preparing portable Node.js $nodeVersion..."
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archivePath
  }

  $downloadedHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  if ($downloadedHash -ne $checksums[$architecture]) {
    Remove-Item -LiteralPath $archivePath -Force
    throw "The Node.js download failed SHA-256 verification."
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $RuntimeRoot -Force
  Remove-Item -LiteralPath $archivePath -Force
}

$portableVersion = Get-NodeVersion -NodeExecutable $nodeExecutable
if (-not $portableVersion -or $portableVersion -lt $minimumVersion) {
  throw "The prepared Node.js version could not be verified."
}

Save-NodePath -NodeDirectory $nodeDirectory
Write-Output "Portable Node.js $portableVersion is ready."
