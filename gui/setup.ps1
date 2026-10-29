$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Root ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $Python)) {
    $PyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if (-not $PyLauncher) {
        throw "Python 3 was not found. Install Python and run setup.ps1 again."
    }
    & $PyLauncher.Source -m venv $Venv
}

& $Python -m pip install --disable-pip-version-check -r (Join-Path $Root "requirements.lock.txt")
& $Python -c "import pdfplumber, pypdf, docx, reportlab, matplotlib, PIL; print('Document dependencies OK')"

$NodeCandidates = @(
    $env:NODE_REPL_NODE_PATH,
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $NodeCandidates) {
    $FoundNode = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes") -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($FoundNode) { $NodeCandidates = @($FoundNode.FullName) }
}

if (-not $NodeCandidates) {
    throw "Node.js was not found. Install Node.js or run this from the Codex desktop runtime."
}

$Ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($Ollama) {
    try {
        $Tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
        "Ollama is available. Models: $($Tags.models.Count)"
    } catch {
        "Ollama is installed but is not running."
    }
} else {
    "Ollama is not installed. Local low-cost classification is disabled."
}

"Setup complete. Double-click the launcher in the skill root."
