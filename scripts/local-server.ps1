param([switch]$NoOpen, [switch]$Supervise)

$ErrorActionPreference = "Stop"

if ($Supervise) {
  # Supervisor mode: keep one server process alive. If the server stops for
  # any reason it is started again; three failures in quick succession (for
  # example a port conflict) end supervision so the launcher can report it.
  $quickFailures = 0
  while ($true) {
    $startedAt = [DateTime]::UtcNow
    $child = Start-Process -FilePath "powershell.exe" -ArgumentList @(
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      ('"' + $PSCommandPath + '"'),
      "-NoOpen"
    ) -WindowStyle Hidden -PassThru
    $child.WaitForExit()
    if (([DateTime]::UtcNow - $startedAt).TotalSeconds -lt 15) {
      $quickFailures++
    } else {
      $quickFailures = 0
    }
    if ($quickFailures -ge 3) { exit 1 }
    Start-Sleep -Seconds 2
  }
}

$script:StartedAt = [Diagnostics.Stopwatch]::StartNew()
$script:Version = "1.5.1"
$script:WebRoot = Join-Path (Split-Path $PSScriptRoot -Parent) "web"
$script:RuntimeDirectory = Join-Path $env:LOCALAPPDATA "CGVGiftDisplay"
$script:DatabasePath = Join-Path $script:RuntimeDirectory "inventory.db"
$script:ResetMarker = Join-Path $script:RuntimeDirectory "reset-data.flag"
$script:PidFile = Join-Path $script:RuntimeDirectory "server.pid"
$script:BackupDirectory = Join-Path $script:RuntimeDirectory "backups"
$script:BackupRetentionDays = 14
$script:DisplayExpected = $null
$script:DisplayRunning = $null
$script:IncidentId = $null
$script:IncidentAt = $null
$script:LastSyncAt = $null
$script:DisplaySeenAt = $null
$script:DisplayGraceUntil = [DateTime]::UtcNow.AddSeconds(20)
$script:DisplayHeartbeatSeconds = 15
$script:AllowedHosts = @("127.0.0.1:3210", "localhost:3210")
$script:AllowedOrigins = @("http://127.0.0.1:3210", "http://localhost:3210")

. (Join-Path $PSScriptRoot "sqlite-store.ps1")

function ConvertTo-JsonBytes {
  param([Parameter(Mandatory = $true)]$Value)
  return [Text.Encoding]::UTF8.GetBytes(
    (ConvertTo-Json $Value -Depth 20 -Compress)
  )
}

function Write-HttpResponse {
  param(
    [Parameter(Mandatory = $true)][IO.Stream]$Stream,
    [Parameter(Mandatory = $true)][int]$Status,
    [Parameter(Mandatory = $true)][string]$ContentType,
    [Parameter(Mandatory = $true)][byte[]]$Body
  )
  $statusText = switch ($Status) {
    200 { "OK" }
    204 { "No Content" }
    400 { "Bad Request" }
    403 { "Forbidden" }
    404 { "Not Found" }
    409 { "Conflict" }
    428 { "Precondition Required" }
    415 { "Unsupported Media Type" }
    500 { "Internal Server Error" }
    default { "OK" }
  }
  $crlf = [string][char]13 + [string][char]10
  $header = (
    "HTTP/1.1 $Status $statusText$crlf" +
    "Content-Type: $ContentType$crlf" +
    "Content-Length: $($Body.Length)$crlf" +
    "Cache-Control: no-store$crlf" +
    "Connection: close$crlf$crlf"
  )
  $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
  $Stream.Flush()
}

function Write-JsonResponse {
  param(
    [Parameter(Mandatory = $true)][IO.Stream]$Stream,
    [Parameter(Mandatory = $true)][int]$Status,
    [Parameter(Mandatory = $true)]$Value
  )
  $arguments = @{
    Stream = $Stream
    Status = $Status
    ContentType = "application/json; charset=utf-8"
    Body = (ConvertTo-JsonBytes $Value)
  }
  Write-HttpResponse @arguments
}

function Read-HttpRequest {
  param([Parameter(Mandatory = $true)][IO.Stream]$Stream)
  $header = New-Object IO.MemoryStream
  $last = New-Object Collections.Generic.Queue[byte]
  while ($true) {
    $value = $Stream.ReadByte()
    if ($value -lt 0) { throw "요청 연결이 닫혔습니다." }
    $header.WriteByte([byte]$value)
    $last.Enqueue([byte]$value)
    if ($last.Count -gt 4) { [void]$last.Dequeue() }
    if ($last.Count -eq 4 -and ($last.ToArray() -join ",") -eq "13,10,13,10") {
      break
    }
    if ($header.Length -gt 16384) { throw "요청 헤더가 너무 큽니다." }
  }
  $headerText = [Text.Encoding]::ASCII.GetString($header.ToArray())
  $crlf = [string][char]13 + [string][char]10
  $lines = $headerText -split $crlf
  $requestParts = $lines[0] -split " "
  if ($requestParts.Count -lt 2) { throw "올바르지 않은 HTTP 요청입니다." }
  $headers = @{}
  foreach ($line in ($lines | Select-Object -Skip 1)) {
    if ($line -match "^([^:\s]+):\s*(.*?)\s*$") {
      $headers[$Matches[1].ToLowerInvariant()] = $Matches[2]
    }
  }
  $contentLength = 0
  if ($headers.ContainsKey("content-length")) {
    if ($headers["content-length"] -notmatch "^\d{1,9}$") {
      throw "올바르지 않은 Content-Length입니다."
    }
    $contentLength = [int]$headers["content-length"]
  }
  if ($contentLength -gt 2000000) { throw "요청 본문이 너무 큽니다." }
  $body = New-Object byte[] $contentLength
  $offset = 0
  while ($offset -lt $contentLength) {
    $count = $Stream.Read($body, $offset, $contentLength - $offset)
    if ($count -le 0) { throw "요청 본문이 완전하지 않습니다." }
    $offset += $count
  }
  return [PSCustomObject]@{
    Method = $requestParts[0].ToUpperInvariant()
    Path = (($requestParts[1] -split "\?", 2)[0])
    Headers = $headers
    Body = $body
  }
}

function Get-MimeType {
  param([Parameter(Mandatory = $true)][string]$Path)
  switch ([IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".js" { "text/javascript; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    ".png" { "image/png" }
    ".svg" { "image/svg+xml" }
    ".woff" { "font/woff" }
    ".ico" { "image/x-icon" }
    default { "application/octet-stream" }
  }
}

function Resolve-StaticPath {
  param([Parameter(Mandatory = $true)][string]$RequestPath)
  try {
    $decoded = [Uri]::UnescapeDataString($RequestPath).TrimStart("/")
  } catch {
    return $null
  }
  if (($decoded -split "[/\\]") -contains "..") { return $null }
  $candidate = if (-not $decoded) {
    Join-Path $script:WebRoot "index.html"
  } else {
    Join-Path $script:WebRoot (
      $decoded -replace "/", [IO.Path]::DirectorySeparatorChar
    )
  }
  $root = [IO.Path]::GetFullPath($script:WebRoot).TrimEnd(
    [IO.Path]::DirectorySeparatorChar
  )
  $fullPath = [IO.Path]::GetFullPath($candidate)
  if (-not $fullPath.StartsWith(
    $root + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )) { return $null }
  if (Test-Path -LiteralPath $fullPath -PathType Leaf) { return $fullPath }
  if (-not [IO.Path]::GetExtension($decoded)) {
    return Join-Path $script:WebRoot "index.html"
  }
  return $null
}

function Invoke-DisplayAction {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Open", "Close", "Status")]
    [string]$Action
  )
  $output = & (Join-Path $PSScriptRoot "display-window.ps1") -Action $Action
  return ($output | Out-String).Trim()
}

function Get-DisplayStatus {
  $running = (Invoke-DisplayAction -Action Status) -eq "running"
  if ($null -eq $script:DisplayExpected) { $script:DisplayExpected = $running }
  if (
    $script:DisplayExpected -eq $true -and
    $script:DisplayRunning -eq $true -and
    -not $running -and
    -not $script:IncidentId
  ) {
    $script:IncidentId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
    $script:IncidentAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  if ($running) {
    $script:IncidentId = $null
    $script:IncidentAt = $null
  }
  $script:DisplayRunning = $running
  # A window alone does not prove the display works: the display page must
  # also keep fetching inventory. A short grace period covers page start-up.
  $utcNow = [DateTime]::UtcNow
  $responding = $running -and (
    $utcNow -lt $script:DisplayGraceUntil -or (
      $null -ne $script:DisplaySeenAt -and
      ($utcNow - $script:DisplaySeenAt).TotalSeconds -lt $script:DisplayHeartbeatSeconds
    )
  )
  return @{
    controller = $true
    running = $running
    responding = $responding
    displaySeenAt = $(
      if ($null -ne $script:DisplaySeenAt) { $script:DisplaySeenAt.ToString("o") } else { $null }
    )
    expected = [bool]$script:DisplayExpected
    abnormal = (
      $script:DisplayExpected -eq $true -and
      -not $running -and
      [bool]$script:IncidentId
    )
    incidentId = $script:IncidentId
    incidentAt = $script:IncidentAt
    lastSyncAt = $script:LastSyncAt
  }
}

function Test-AppData {
  param([Parameter(Mandatory = $true)]$Value)
  if ($Value -isnot [Management.Automation.PSCustomObject]) { return $false }
  $names = @($Value.PSObject.Properties.Name)
  if (-not (
    $names -contains "items" -and
    $names -contains "settings" -and
    $names -contains "updatedAt" -and
    $Value.items -is [Array] -and
    $Value.settings -is [Management.Automation.PSCustomObject] -and
    $Value.updatedAt -is [string]
  )) { return $false }
  # Every inventory row must be an object; a null or scalar row would
  # otherwise be stored and break both screens on every start.
  foreach ($item in $Value.items) {
    if ($item -isnot [Management.Automation.PSCustomObject]) { return $false }
  }
  return $true
}

# Keeps the inventory as it was before the first change of each day, so an
# accidental deletion or reset can be recovered by hand. A backup problem
# must never prevent saving.
function Save-DailyBackup {
  try {
    $backupPath = Join-Path $script:BackupDirectory (
      "inventory-" + (Get-Date).ToString("yyyyMMdd") + ".db"
    )
    if (Test-Path -LiteralPath $backupPath) { return }
    if ($null -eq (Read-CgvRecord -DatabasePath $script:DatabasePath)) { return }
    New-Item -ItemType Directory -Path $script:BackupDirectory -Force | Out-Null
    # A verified single-file SQLite snapshot taken with the online backup
    # API, so it is consistent even while the write-ahead log holds data.
    Backup-CgvData -DatabasePath $script:DatabasePath -Destination $backupPath
    Get-ChildItem -LiteralPath $script:BackupDirectory -Filter "inventory-*.db" |
      Sort-Object Name -Descending |
      Select-Object -Skip $script:BackupRetentionDays |
      Remove-Item -Force -ErrorAction SilentlyContinue
  } catch {
    # Saving continues without a backup.
  }
}

function Get-RequestHeader {
  param(
    [Parameter(Mandatory = $true)]$Request,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ($Request.Headers.ContainsKey($Name)) { return [string]$Request.Headers[$Name] }
  return ""
}

# Only this application's own pages may use the controller. Requests that a
# browser sends on behalf of another site (cross-site forms or scripts, DNS
# rebinding) carry a foreign Host, Origin, or Sec-Fetch-Site value.
function Get-RequestRejection {
  param([Parameter(Mandatory = $true)]$Request)
  $hostName = (Get-RequestHeader $Request "host").ToLowerInvariant()
  if ($hostName -notin $script:AllowedHosts) {
    return @{ Status = 403; Message = "허용되지 않은 호스트입니다." }
  }
  $isApi = (
    $Request.Path -eq "/data" -or
    $Request.Path.StartsWith("/display/", [StringComparison]::Ordinal)
  )
  if (-not $isApi) { return $null }
  $origin = (Get-RequestHeader $Request "origin").ToLowerInvariant()
  if ($origin -and $origin -notin $script:AllowedOrigins) {
    return @{ Status = 403; Message = "허용되지 않은 출처입니다." }
  }
  $fetchSite = (Get-RequestHeader $Request "sec-fetch-site").ToLowerInvariant()
  if ($fetchSite -and $fetchSite -notin @("same-origin", "none")) {
    return @{ Status = 403; Message = "허용되지 않은 출처입니다." }
  }
  if (
    $Request.Method -eq "POST" -and
    $Request.Path -eq "/data" -and
    -not (Get-RequestHeader $Request "content-type").ToLowerInvariant().StartsWith(
      "application/json"
    )
  ) {
    return @{ Status = 415; Message = "application/json 형식만 저장할 수 있습니다." }
  }
  return $null
}

function Invoke-Request {
  param(
    [Parameter(Mandatory = $true)]$Request,
    [Parameter(Mandatory = $true)][IO.Stream]$Stream
  )
  $rejection = Get-RequestRejection -Request $Request
  if ($rejection) {
    Write-JsonResponse -Stream $Stream -Status $rejection.Status -Value @{
      ok = $false
      message = $rejection.Message
    }
    return
  }
  if ($Request.Method -eq "OPTIONS") {
    Write-HttpResponse -Stream $Stream -Status 204 -ContentType "text/plain" -Body ([byte[]]@())
    return
  }
  if ($Request.Method -eq "GET" -and $Request.Path -eq "/health") {
    Write-JsonResponse -Stream $Stream -Status 200 -Value @{
      ok = $true
      version = $script:Version
      runtime = "powershell"
      startupMs = $script:StartedAt.ElapsedMilliseconds
    }
    return
  }
  if ($Request.Method -eq "GET" -and $Request.Path -eq "/data") {
    try {
      $record = Read-CgvRecord -DatabasePath $script:DatabasePath
      $payload = if ($null -eq $record) { $null } else { $record.Payload }
      $storedValue = if ($null -eq $payload) { $null } else { ConvertFrom-Json $payload }
    } catch {
      # A failed read is reported as a server error, never as "no data".
      Write-JsonResponse -Stream $Stream -Status 500 -Value @{
        ok = $false
        message = $_.Exception.Message
      }
      return
    }
    if ((Get-RequestHeader $Request "x-cgv-client") -eq "display") {
      $script:DisplaySeenAt = [DateTime]::UtcNow
    }
    if ($null -eq $payload) {
      Write-JsonResponse -Stream $Stream -Status 404 -Value @{
        ok = $false
        message = "no data"
        revision = 0
        reset = (Test-Path -LiteralPath $script:ResetMarker)
      }
    } else {
      Write-JsonResponse -Stream $Stream -Status 200 -Value @{
        ok = $true
        data = $storedValue
        revision = $record.Revision
      }
    }
    return
  }
  if ($Request.Method -eq "POST" -and $Request.Path -eq "/data") {
    # Every write states the revision it was made from. A client that does
    # not (v1.5.0 and earlier pages left open across an update) is refused,
    # so it cannot overwrite data it has never seen.
    $baseText = Get-RequestHeader $Request "x-cgv-base-revision"
    if ($baseText -notmatch "^\d{1,18}$") {
      Write-JsonResponse -Stream $Stream -Status 428 -Value @{
        ok = $false
        message = "프로그램이 업데이트되었습니다. 관리 화면을 닫고 다시 실행해 주세요."
      }
      return
    }
    try {
      $payload = [Text.Encoding]::UTF8.GetString($Request.Body)
      $value = ConvertFrom-Json $payload
      if (-not (Test-AppData $value)) { throw "올바르지 않은 데이터입니다." }
    } catch {
      Write-JsonResponse -Stream $Stream -Status 400 -Value @{
        ok = $false
        message = $_.Exception.Message
      }
      return
    }
    try {
      $writeArguments = @{
        DatabasePath = $script:DatabasePath
        Payload = $payload
        UpdatedAt = $value.updatedAt
        BaseRevision = [long]$baseText
      }
      Save-DailyBackup
      $result = Write-CgvData @writeArguments
      if (-not $result.Written) {
        # Another window stored a different revision first. Nothing was
        # written; the caller keeps its edits and asks the operator.
        Write-JsonResponse -Stream $Stream -Status 409 -Value @{
          ok = $false
          conflict = $true
          revision = $result.Revision
          message = "다른 창에서 먼저 저장한 데이터가 있습니다."
        }
        return
      }
      Remove-Item -LiteralPath $script:ResetMarker -Force -ErrorAction SilentlyContinue
      $script:LastSyncAt = (Get-Date).ToUniversalTime().ToString("o")
      Write-JsonResponse -Stream $Stream -Status 200 -Value @{
        ok = $true
        revision = $result.Revision
      }
    } catch {
      Write-JsonResponse -Stream $Stream -Status 500 -Value @{
        ok = $false
        message = $_.Exception.Message
      }
    }
    return
  }
  if ($Request.Method -eq "GET" -and $Request.Path -eq "/display/status") {
    try {
      Write-JsonResponse -Stream $Stream -Status 200 -Value (Get-DisplayStatus)
    } catch {
      Write-JsonResponse -Stream $Stream -Status 500 -Value @{
        controller = $true
        running = $false
        message = $_.Exception.Message
      }
    }
    return
  }
  if (
    $Request.Method -eq "POST" -and
    $Request.Path -in @("/display/open", "/display/close")
  ) {
    try {
      $opening = $Request.Path -eq "/display/open"
      $message = Invoke-DisplayAction -Action $(if ($opening) { "Open" } else { "Close" })
      $script:DisplayExpected = $opening
      $script:DisplayRunning = $opening
      $script:DisplaySeenAt = $null
      $script:DisplayGraceUntil = [DateTime]::UtcNow.AddSeconds(20)
      $script:IncidentId = $null
      $script:IncidentAt = $null
      Write-JsonResponse -Stream $Stream -Status 200 -Value @{
        ok = $true
        message = $message
      }
    } catch {
      Write-JsonResponse -Stream $Stream -Status 500 -Value @{
        ok = $false
        message = $_.Exception.Message
      }
    }
    return
  }
  if ($Request.Method -eq "GET") {
    $staticPath = Resolve-StaticPath -RequestPath $Request.Path
    if ($staticPath -and (Test-Path -LiteralPath $staticPath -PathType Leaf)) {
      Write-HttpResponse -Stream $Stream -Status 200 -ContentType (
        Get-MimeType $staticPath
      ) -Body ([IO.File]::ReadAllBytes($staticPath))
    } else {
      Write-JsonResponse -Stream $Stream -Status 404 -Value @{ ok = $false }
    }
    return
  }
  Write-JsonResponse -Stream $Stream -Status 404 -Value @{ ok = $false }
}

try {
  if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA 환경 변수를 찾을 수 없습니다."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $script:WebRoot "index.html"))) {
    throw "웹 화면 파일을 찾을 수 없습니다: $script:WebRoot"
  }
  New-Item -ItemType Directory -Path $script:RuntimeDirectory -Force | Out-Null
  Initialize-CgvDataStore -DatabasePath $script:DatabasePath
  $legacyPath = Join-Path $script:RuntimeDirectory "display-data.json"
  if (
    $null -eq (Read-CgvData -DatabasePath $script:DatabasePath) -and
    (Test-Path -LiteralPath $legacyPath -PathType Leaf)
  ) {
    $legacyPayload = [IO.File]::ReadAllText($legacyPath, [Text.Encoding]::UTF8)
    $legacyValue = ConvertFrom-Json $legacyPayload
    if (Test-AppData $legacyValue) {
      $legacyArguments = @{
        DatabasePath = $script:DatabasePath
        Payload = $legacyPayload
        UpdatedAt = $legacyValue.updatedAt
        BaseRevision = 0
      }
      [void](Write-CgvData @legacyArguments)
    }
  }
  [IO.File]::WriteAllText(
    $script:PidFile,
    $PID.ToString(),
    (New-Object Text.UTF8Encoding($false))
  )
  $listener = New-Object Net.Sockets.TcpListener -ArgumentList @(
    [Net.IPAddress]::Parse("127.0.0.1"),
    3210
  )
  $listener.Start()
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      # Requests arrive from this PC only, so a slow header means an idle
      # (speculative) browser connection; release the single thread quickly.
      $client.ReceiveTimeout = 1500
      $client.SendTimeout = 5000
      $stream = $client.GetStream()
      try {
        $request = Read-HttpRequest -Stream $stream
        Invoke-Request -Request $request -Stream $stream
      } catch {
        try {
          Write-JsonResponse -Stream $stream -Status 400 -Value @{
            ok = $false
            message = $_.Exception.Message
          }
        } catch {
          # A browser or health probe may close the socket before the reply.
        }
      } finally {
        $stream.Dispose()
      }
    } catch {
      # A single disconnected client must not stop the local server.
    } finally {
      $client.Close()
    }
  }
} catch {
  New-Item -ItemType Directory -Path $script:RuntimeDirectory -Force | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $script:RuntimeDirectory "server-error.log"),
    $_.Exception.ToString(),
    (New-Object Text.UTF8Encoding($true))
  )
  exit 1
} finally {
  if ($listener) { $listener.Stop() }
  Remove-Item -LiteralPath $script:PidFile -Force -ErrorAction SilentlyContinue
}
