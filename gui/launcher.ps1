$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $PSScriptRoot ".runtime"
$UrlFile = Join-Path $RuntimeDir "app-url.txt"
$ServerFile = Join-Path $PSScriptRoot "server.mjs"
$ServerLog = Join-Path $RuntimeDir "server.log"

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
if (Test-Path -LiteralPath $UrlFile) {
    Remove-Item -LiteralPath $UrlFile -Force
}

$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
    throw "Document dependencies are missing. Run gui\setup.ps1 first."
}

$NodeCandidates = @(
    $env:NODE_REPL_NODE_PATH,
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $NodeCandidates) {
    $FoundNode = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes") -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($FoundNode) { $NodeCandidates = @($FoundNode.FullName) }
}
if (-not $NodeCandidates) {
    throw "Node.js was not found. Run gui\setup.ps1 first."
}

$Node = $NodeCandidates | Select-Object -First 1
$ExistingPidFile = Join-Path $RuntimeDir "server.pid"
if (Test-Path -LiteralPath $ExistingPidFile) {
    $ExistingPid = Get-Content -LiteralPath $ExistingPidFile -ErrorAction SilentlyContinue
    if ($ExistingPid) {
        $Existing = Get-Process -Id ([int]$ExistingPid) -ErrorAction SilentlyContinue
        if ($Existing) {
            Stop-Process -Id $Existing.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

$Env:PAPERBANK_ROOT = $Root
$Env:PAPERBANK_PYTHON = $Python
$Server = Start-Process -FilePath $Node -ArgumentList @($ServerFile) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $ServerLog -RedirectStandardError (Join-Path $RuntimeDir "server-error.log") -PassThru
Set-Content -LiteralPath $ExistingPidFile -Value $Server.Id -Encoding ascii

$Url = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Path -LiteralPath $UrlFile) {
        $Url = (Get-Content -LiteralPath $UrlFile -Raw).Trim()
        if ($Url) { break }
    }
    if ($Server.HasExited) { break }
}
if (-not $Url) {
    throw "The local app failed to start. See $ServerLog"
}

$EdgeCandidates = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path -LiteralPath $_ }

if ($EdgeCandidates) {
    $Edge = $EdgeCandidates | Select-Object -First 1
    Start-Process -FilePath $Edge -ArgumentList @("--app=$Url", "--window-size=1440,1000")
} else {
    Start-Process $Url
}
