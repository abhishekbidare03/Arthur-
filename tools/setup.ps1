<#
    Arthur - one-time setup. Invoked by setup.bat.

    Installs dependencies, builds the UI, generates the Windows icon, and
    creates the Desktop and Start-menu shortcuts. Everything here is
    idempotent: running it again after a `git pull` rebuilds and moves on.

    What it deliberately does NOT do:

      * start `ollama serve` - a second server holds port 11434 and puts the
        tray app into a silent crash loop (see logs.md, Session 1)
      * download and run the Ollama installer - that is fetching an executable
        and running it on someone's machine, which is not a thing a setup
        script should do quietly. It checks, and links.
      * pull the models - that is several GB, and Arthur's own UI asks for
        consent per tier and shows progress, which is a far better place for it
        than a script with no progress bar.
#>

$ErrorActionPreference = 'Stop'

$root     = Split-Path $PSScriptRoot -Parent
$backend  = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

function Say([string]$Label, [string]$Value, [string]$Colour = 'Green') {
    Write-Host ('  {0,-16}{1}' -f $Label, $Value) -ForegroundColor $Colour
}

Write-Host ''
Write-Host '  Arthur - setup' -ForegroundColor Cyan
Write-Host ''

# --- Node --------------------------------------------------------------------
# Checked first and hard-failed: nothing below this works without it, and "npm
# is not recognised" three lines later is a worse message than this one.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Say 'Node.js' 'not found' 'Red'
    Write-Host ''
    Write-Host '  Arthur needs Node.js 22 or newer.  https://nodejs.org' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

$version = (& node --version).TrimStart('v')
$major = [int]($version -split '\.')[0]
if ($major -lt 22) {
    # `better-sqlite3` ships prebuilt binaries per Node major, and `--env-file`
    # and the test runner both assume 22. An older Node fails at install time
    # with a compiler error, which reads as a broken repo rather than a version.
    Say 'Node.js' "$version - too old, needs 22+" 'Red'
    Write-Host ''
    exit 1
}
Say 'Node.js' $version

# --- Dependencies ------------------------------------------------------------
foreach ($dir in @($backend, $frontend)) {
    $name = Split-Path $dir -Leaf
    Push-Location $dir
    try {
        if (Test-Path (Join-Path $dir 'node_modules')) {
            Say $name 'dependencies present' 'DarkGray'
        } else {
            Write-Host ('  {0,-16}installing...' -f $name) -ForegroundColor Yellow
            npm install --no-fund --no-audit | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "npm install failed in $name" }
            Say $name 'dependencies installed'
        }
    } finally {
        Pop-Location
    }
}

# --- Icon --------------------------------------------------------------------
# Before the build, not after: this writes frontend/public/favicon.ico, and Vite
# copies public/ into dist/ as part of building. Generating it afterwards leaves
# the first build with no tab icon until setup is run a second time.
& (Join-Path $PSScriptRoot 'make-icon.ps1')
$icon = Join-Path $root 'assets\Arthur.ico'

# --- Build the UI ------------------------------------------------------------
# The shipped app serves this build from the backend process. Without it there
# is no UI at all, so a failure here is fatal rather than a warning.
Push-Location $frontend
try {
    Write-Host ('  {0,-16}building...' -f 'UI') -ForegroundColor Yellow
    npm run build | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The UI build failed. Run "npm run build" in frontend/ to see why.' }
} finally {
    Pop-Location
}

$index = Join-Path $frontend 'dist\index.html'
if (-not (Test-Path $index)) { throw "The build produced no $index" }
$bundleKb = [Math]::Round((Get-ChildItem (Join-Path $frontend 'dist') -Recurse -File |
    Measure-Object Length -Sum).Sum / 1KB)
Say 'UI' "built ($bundleKb KB)"

# --- Shortcuts ---------------------------------------------------------------
# Pointed at the .vbs rather than at a .bat: the .vbs is what launches without
# a console window flashing.
$launcher = Join-Path $root 'Arthur.vbs'
$shell = New-Object -ComObject WScript.Shell

foreach ($folder in @([Environment]::GetFolderPath('Desktop'),
                      (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
    $link = $shell.CreateShortcut((Join-Path $folder 'Arthur.lnk'))
    # wscript, not the .vbs directly: a .vbs shortcut inherits the script-file
    # icon in some shells, and wscript.exe //B suppresses any script error
    # dialog from a stray window.
    $link.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $link.Arguments = '"' + $launcher + '"'
    $link.WorkingDirectory = $root
    $link.IconLocation = $icon
    $link.Description = 'Arthur - a local chat app. No internet, no API key.'
    $link.Save()
}
Say 'Shortcuts' 'Desktop and Start menu'

# --- Ollama ------------------------------------------------------------------
# Reported, never installed or started. Arthur's UI handles both cases at
# runtime; this is here so setup ends with an honest picture rather than a
# green wall that turns into a failure on the first message.
Write-Host ''
$ollamaUp = $null -ne (Get-NetTCPConnection -State Listen -LocalPort 11434 -ErrorAction SilentlyContinue)

if ($ollamaUp) {
    Say 'Ollama' 'running'

    $required = @('qwen2.5:1.5b', 'llama3.2:3b', 'qwen3:4b')
    try {
        $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
        $installed = @($tags.models | ForEach-Object { $_.name })
        $missing = @($required | Where-Object { $installed -notcontains $_ })

        if ($missing.Count -eq 0) {
            Say 'Models' 'all three tiers ready'
        } else {
            Say 'Models' "$($missing.Count) of 3 still to download" 'Yellow'
            Write-Host '                  Arthur will offer to fetch them on first launch.' -ForegroundColor DarkGray
        }
    } catch {
        Say 'Models' 'could not be listed' 'Yellow'
    }
} elseif (Get-Command ollama -ErrorAction SilentlyContinue) {
    Say 'Ollama' 'installed but not running' 'Yellow'
    Write-Host '                  Start it from the Start menu. Do not run `ollama serve` by hand.' -ForegroundColor DarkGray
} else {
    Say 'Ollama' 'not installed' 'Yellow'
    Write-Host '                  Arthur needs it to generate replies:  https://ollama.com/download' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  Setup complete. Launch Arthur from the Desktop shortcut.' -ForegroundColor Cyan
