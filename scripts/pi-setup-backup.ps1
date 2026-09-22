# pi-setup-backup.ps1
# Backup shareable pi setup files from ~/.pi/agent into this portable repository

param(
    [string]$SourceDir = $(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" })
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

if (-not (Test-Path $configExtDir)) {
    New-Item -ItemType Directory -Force -Path $configExtDir | Out-Null
}

# 1. Copy settings.json
$srcSettings = Join-Path $SourceDir "settings.json"
if (Test-Path $srcSettings) {
    Copy-Item -Path $srcSettings -Destination (Join-Path $configDir "settings.json") -Force
    Write-Host "  -> settings.json"
}

# 2. Copy advisor.json
$srcAdvisor = Join-Path $SourceDir "advisor.json"
if (Test-Path $srcAdvisor) {
    Copy-Item -Path $srcAdvisor -Destination (Join-Path $configDir "advisor.json") -Force
    Write-Host "  -> advisor.json"
}

# 3. Copy shareable extensions (ignoring machine-generated orca-*.ts)
$srcExtDir = Join-Path $SourceDir "extensions"
if (Test-Path $srcExtDir) {
    Get-ChildItem -Path $srcExtDir | Where-Object {
        $_.Name -notlike "orca-*"
    } | ForEach-Object {
        $dest = Join-Path $configExtDir $_.Name
        if ($_.PSIsContainer) {
            if (-not (Test-Path $dest)) {
                New-Item -ItemType Directory -Path $dest -Force | Out-Null
            }
            Copy-Item -Path (Join-Path $_.FullName "*") -Destination $dest -Recurse -Force
        } else {
            Copy-Item -Path $_.FullName -Destination $dest -Force
        }
        Write-Host "  -> extensions/$($_.Name)"
    }
}

Write-Host ""
Write-Host "[OK] Backup completed! Secret files (auth.json, sessions, etc.) were excluded." -ForegroundColor Green
