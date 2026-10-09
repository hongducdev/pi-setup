# pi-setup-backup.ps1
# Backup shareable pi setup files from ~/.pi/agent into this portable repository.
# Respects config/.pi-setup-exclude (secrets, runtime state, node_modules, *.bak ...).

param(
    [string]$SourceDir = $(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }),
    [string]$PiLensConfig = (Join-Path $env:USERPROFILE ".pi-lens\config.json")
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$configDir = Join-Path $rootDir "config"
$configExtDir = Join-Path $configDir "extensions"

Write-Host "=== Pi Setup Backup ===" -ForegroundColor Cyan
Write-Host "Source directory: $SourceDir"
Write-Host "Target config:    $configDir"

if (-not (Test-Path $SourceDir)) {
    throw "Source directory not found: $SourceDir"
}

# Exclude globs (relative to ~/.pi/agent, "/" separators)
$excludeFile = Join-Path $configDir ".pi-setup-exclude"
$excludes = @()
if (Test-Path $excludeFile) {
    $excludes = Get-Content $excludeFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") }
}

function Test-Excluded([string]$rel) {
    $r = $rel -replace '\\', '/'
    foreach ($g in $excludes) {
        if ($r -like $g) { return $true }
        if ($g.EndsWith("/*") -and ($r -like ($g.Substring(0, $g.Length - 2)) -or $r -like "$($g.Substring(0, $g.Length - 2))/*")) { return $true }
        if ($r -like "*/$g") { return $true }
    }
    return $false
}

function Copy-Shareable([string]$srcPath, [string]$destPath, [string]$rel) {
    if (Test-Excluded $rel) { Write-Host "  (skip) $rel" -ForegroundColor DarkGray; return }
    $parent = Split-Path -Parent $destPath
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -Path $srcPath -Destination $destPath -Force
    Write-Host "  -> $rel"
}

# 1. Top-level shareable files
foreach ($name in @("settings.json", "advisor.json", "AGENTS.md", "live-log.json", "env-context.json")) {
    $src = Join-Path $SourceDir $name
    if (Test-Path $src) { Copy-Shareable $src (Join-Path $configDir $name) $name }
}

# 2. Extensions (recursive, filtered). Helper scripts live in the repo's scripts/ directly.
foreach ($sub in @("extensions")) {
    $srcDir = Join-Path $SourceDir $sub
    if (-not (Test-Path $srcDir)) { continue }
    Get-ChildItem -Path $srcDir -Recurse -File -Force | ForEach-Object {
        $rel = "$sub/" + $_.FullName.Substring($srcDir.Length + 1).Replace('\', '/')
        Copy-Shareable $_.FullName (Join-Path $configDir $rel) $rel
    }
}

# 3. pi-lens global config (~/.pi-lens/config.json -> pi-lens/config.json)
if (Test-Path $PiLensConfig) {
    $lensDir = Join-Path $rootDir "pi-lens"
    if (-not (Test-Path $lensDir)) { New-Item -ItemType Directory -Force -Path $lensDir | Out-Null }
    Copy-Item -Path $PiLensConfig -Destination (Join-Path $lensDir "config.json") -Force
    Write-Host "  -> pi-lens/config.json"
}

Write-Host ""
Write-Host "[OK] Backup completed. Excluded: secrets, sessions, runtime state (see config/.pi-setup-exclude)." -ForegroundColor Green
Write-Host "Review 'git diff' and scan for secrets before committing." -ForegroundColor Yellow
