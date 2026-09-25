<#
Install this repository's git hooks.

Why an installer instead of a committed hook: git never tracks `.git/hooks/`, so
a hook can only reach a machine by being copied there. Run this once per clone.

Usage:
  pwsh -File scripts/install-hooks.ps1
  pwsh -File scripts/install-hooks.ps1 -Uninstall

Installs (or removes) a `pre-push` hook that runs scripts/privacy-check.ps1 and
aborts the push on any finding. Bypass a single push with `git push --no-verify`.

ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#>
[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$root = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $root) {
    Write-Host 'install-hooks: not inside a git repository' -ForegroundColor Red
    exit 2
}
Set-Location $root

$hooksDir = Join-Path $root '.git\hooks'
$target = Join-Path $hooksDir 'pre-push'

if ($Uninstall) {
    if (Test-Path $target) {
        # Never delete outright: hand the file to the Recycle Bin instead.
        Add-Type -AssemblyName Microsoft.VisualBasic
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')
        Write-Host 'install-hooks: removed pre-push (moved to the Recycle Bin)' -ForegroundColor Yellow
    } else {
        Write-Host 'install-hooks: nothing to remove'
    }
    return
}

if (-not (Test-Path $hooksDir)) { New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null }

$template = Join-Path $root 'scripts\pre-push'
if (-not (Test-Path $template)) {
    Write-Host "install-hooks: template missing at $template" -ForegroundColor Red
    exit 1
}

Copy-Item -Force $template $target
Write-Host 'install-hooks: installed .git/hooks/pre-push' -ForegroundColor Green
Write-Host '  it runs scripts/privacy-check.ps1 before every push and aborts on findings.'
Write-Host '  bypass one push with: git push --no-verify' -ForegroundColor DarkGray
