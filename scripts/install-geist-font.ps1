# install-geist-font.ps1
# Download and install GeistMono Nerd Font for current Windows user

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$fontsDir = Join-Path $rootDir "fonts\GeistMono"
$zipFile = Join-Path $rootDir "fonts\GeistMono.zip"
$userFontsDir = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts"
$registryPath = "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts"

if (-not (Test-Path $fontsDir)) {
    New-Item -ItemType Directory -Force -Path $fontsDir | Out-Null
}
if (-not (Test-Path $userFontsDir)) {
    New-Item -ItemType Directory -Force -Path $userFontsDir | Out-Null
}

$downloadUrl = "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/GeistMono.zip"

Write-Host "1. Tải GeistMono Nerd Font từ GitHub..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $downloadUrl -OutFile $zipFile -UseBasicParsing

Write-Host "2. Giải nén font..." -ForegroundColor Cyan
Expand-Archive -Path $zipFile -DestinationPath $fontsDir -Force
if (Test-Path $zipFile) {
    Remove-Item -Path $zipFile -Force
}

Write-Host "3. Cài đặt font vào Windows User Fonts ($userFontsDir)..." -ForegroundColor Cyan

# C# helper to broadcast font change
$csharp = @"
using System;
using System.Runtime.InteropServices;

public class FontHelper {
    [DllImport("gdi32.dll", EntryPoint = "AddFontResourceW", SetLastError = true)]
    public static extern int AddFontResource([In, MarshalAs(UnmanagedType.LPWStr)] string lpFileName);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
if (-not ([System.Management.Automation.PSTypeName]'FontHelper').Type) {
    Add-Type -TypeDefinition $csharp
}

$fontFiles = Get-ChildItem -Path $fontsDir -Filter "*.otf"
$installedCount = 0

foreach ($file in $fontFiles) {
    $destPath = Join-Path $userFontsDir $file.Name
    Copy-Item -Path $file.FullName -Destination $destPath -Force

    # Derive font registry display name
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $regName = "$baseName (OpenType)"

    Set-ItemProperty -Path $registryPath -Name $regName -Value $destPath -Force
    [FontHelper]::AddFontResource($destPath) | Out-Null
    $installedCount++
}

# Broadcast WM_FONTCHANGE (0x001D) to all top-level windows
$HWND_BROADCAST = [IntPtr]0xffff
$WM_FONTCHANGE = 0x001D
[FontHelper]::PostMessage($HWND_BROADCAST, $WM_FONTCHANGE, [IntPtr]0, [IntPtr]0) | Out-Null

Write-Host "✓ Đã cài đặt thành công $installedCount font GeistMono Nerd Font!" -ForegroundColor Green
Write-Host ""
Write-Host "Tên font để cấu hình trong Terminal / VS Code / Antigravity IDE:" -ForegroundColor Yellow
Write-Host "  - 'GeistMono Nerd Font'"
Write-Host "  - 'GeistMono NF'"
Write-Host "  - 'GeistMono NFM'"
