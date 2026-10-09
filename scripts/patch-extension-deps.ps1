# patch-extension-deps.ps1
# Ensures installed Pi extensions comply with Pi host-provided packages requirement.
# Host-provided packages (@sinclair/typebox, typebox, etc.) must be declared in peerDependencies with "*" range, not dependencies.

param(
    [string]$TargetDir = $(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" })
)

$ErrorActionPreference = 'Stop'

$hostPkgs = @(
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@mariozechner/pi-agent-core",
    "@mariozechner/pi-ai",
    "@mariozechner/pi-coding-agent",
    "@mariozechner/pi-tui",
    "@sinclair/typebox",
    "typebox"
)

$npmModules = Join-Path $TargetDir "npm\node_modules"
if (-not (Test-Path $npmModules)) {
    return
}

$patchedCount = 0

Get-ChildItem -Path $npmModules -Recurse -Filter "package.json" -Depth 3 | ForEach-Object {
    $pkgJsonPath = $_.FullName
    try {
        $content = Get-Content $pkgJsonPath -Raw
        $json = $content | ConvertFrom-Json
        if ($json.dependencies) {
            $changed = $false
            if (-not $json.peerDependencies) {
                $json | Add-Member -MemberType NoteProperty -Name "peerDependencies" -Value ([PSCustomObject]@{}) -Force
            }

            $deps = $json.dependencies
            $peerDeps = $json.peerDependencies

            foreach ($hp in $hostPkgs) {
                if ($deps.PSObject.Properties[$hp]) {
                    if (-not $peerDeps.PSObject.Properties[$hp] -or $peerDeps.PSObject.Properties[$hp].Value -ne "*") {
                        $peerDeps | Add-Member -MemberType NoteProperty -Name $hp -Value "*" -Force
                    }
                    $deps.PSObject.Properties.Remove($hp)
                    $changed = $true
                }
            }

            if ($changed) {
                $newContent = $json | ConvertTo-Json -Depth 20
                Set-Content -Path $pkgJsonPath -Value $newContent -NoNewline
                Write-Host "  -> Patched host dependencies in: $($json.name)" -ForegroundColor Yellow
                $patchedCount++
            }
        }
    } catch {}
}

if ($patchedCount -gt 0) {
    Write-Host "[OK] Patched $patchedCount package(s) for host-provided extension compliance." -ForegroundColor Green
}
