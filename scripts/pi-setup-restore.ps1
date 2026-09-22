# pi-setup-restore.ps1
# Restore pi setup from this portable repository into ~/.pi/agent

param(
    [string]$TargetDir = $(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }),
    [switch]$InstallFont,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$configDir = Join-Path $rootDir "config"

Write-Host "=== Pi Setup Restore ===" -ForegroundColor Cyan
Write-Host "Source config:    $configDir"
Write-Host "Target directory: $TargetDir"

if (-not (Test-Path $configDir)) {
    throw "Config directory not found: $configDir"
}

if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
}

# 1. Backup existing settings.json if present
$targetSettings = Join-Path $TargetDir "settings.json"
if (Test-Path $targetSettings) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "$targetSettings.bak.$timestamp"
    Copy-Item -Path $targetSettings -Destination $backupPath -Force
    Write-Host "(!) Existing settings.json backed up to: $backupPath" -ForegroundColor Yellow
}

# 2. Copy config files
Write-Host "Restoring configuration files..." -ForegroundColor Cyan
Get-ChildItem -Path $configDir -Exclude ".pi-setup-exclude" | ForEach-Object {
    $dest = Join-Path $TargetDir $_.Name
    if ($_.PSIsContainer) {
        Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
    } else {
        Copy-Item -Path $_.FullName -Destination $dest -Force
    }
    Write-Host "  -> $($_.Name)"
}

# 3. Install font if requested
if ($InstallFont) {
    $fontScript = Join-Path $scriptDir "install-geist-font.ps1"
    if (Test-Path $fontScript) {
        Write-Host "Installing GeistMono Nerd Font..." -ForegroundColor Cyan
        & $fontScript
    }
}

Write-Host ""
Write-Host "[OK] Restore completed successfully!" -ForegroundColor Green
Write-Host "Run 'pi list' or 'pi' to start your session." -ForegroundColor Yellow
