<#
Pre-push privacy check.

Scans three surfaces for machine-specific or secret-looking content and exits
non-zero when it finds any:

  1. the working tree (tracked files)
  2. **every commit in history**, one by one -- a string can be present from the
     first commit onward, and `git log -S` only reports commits that CHANGE the
     number of occurrences, so it would miss exactly that case
  3. tracked file PATHS

Why this exists: this repository is public, and two real leaks already happened
here -- a hardcoded `C:\Users\<name>\.dsh\...` inside a test script, and a
generated `dsh-function.ps1` carrying the deploying user's absolute path.

How to fix a finding: rewrite the value into an equivalent portable form, never
delete it. A hardcoded home directory becomes `process.env.DSH_HOME ??
join(homedir(), '.dsh')` (Node) or `$env:USERPROFILE` / `~` (PowerShell); a
credential moves to an environment variable or a gitignored local file; a
generated artifact gets gitignored instead of committed. The code must still
work after the change -- that is the acceptance test.

Usage:
  pwsh -File scripts/privacy-check.ps1
  pwsh -File scripts/privacy-check.ps1 -ExtraPattern 'internal-host\.corp'
  pwsh -File scripts/privacy-check.ps1 -Quiet

Exit codes: 0 clean, 1 findings, 2 not a git repository.

This file is deliberately ASCII-only: Windows PowerShell 5.1 decodes a BOM-less
.ps1 as ANSI, so a non-ASCII character inside a string literal corrupts the parse.
#>
[CmdletBinding()]
param(
    [string[]]$ExtraPattern = @(),
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# --- locate the repository root ------------------------------------------------
$root = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $root) {
    Write-Host 'privacy-check: not inside a git repository' -ForegroundColor Red
    exit 2
}
Set-Location $root

# --- build the pattern list ----------------------------------------------------
# The local account name (both separator styles) is always checked; callers add
# project-specific terms such as internal hostnames.
$user = $env:USERNAME
$patterns = @(
    [regex]::Escape($user),
    [regex]::Escape("C:\Users\$user"),
    [regex]::Escape("/Users/$user"),
    [regex]::Escape("/home/$user"),
    'api[_-]?key\s*[=:]\s*["'']',
    'secret\s*[=:]\s*["'']',
    'password\s*[=:]\s*["'']',
    'BEGIN [A-Z ]*PRIVATE KEY',
    'ghp_[A-Za-z0-9]{20,}',
    'sk-[A-Za-z0-9]{20,}'
)
$patterns += $ExtraPattern
$regex = ($patterns | Where-Object { $_ }) -join '|'

if (-not $Quiet) {
    Write-Host 'privacy-check: scanning tracked content, all history, and paths' -ForegroundColor Cyan
    Write-Host "  account name  : $user"
    if ($ExtraPattern.Count -gt 0) { Write-Host "  extra patterns: $($ExtraPattern -join ', ')" }
}

$findings = @()

# --- 1. working tree -----------------------------------------------------------
# -i everywhere: a missed credential costs far more than a false positive, and
# callers should not have to guess the casing the leak was written in.
$tree = & git grep -I -i -n -E $regex -- . 2>$null
if ($tree) { $findings += ($tree | ForEach-Object { "worktree  $_" }) }

# --- 2. history, commit by commit ---------------------------------------------
$revs = @(& git rev-list --all 2>$null)
if ($revs.Count -gt 0) {
    $hist = & git grep -I -i -n -E $regex $revs 2>$null
    if ($hist) { $findings += ($hist | ForEach-Object { "history   $_" }) }
}

# --- 3. tracked paths ---------------------------------------------------------
$paths = & git ls-files 2>$null | Where-Object { $_ -match $regex }
if ($paths) { $findings += ($paths | ForEach-Object { "path      $_" }) }

if ($findings.Count -gt 0) {
    Write-Host ''
    Write-Host "FOUND $($findings.Count) potential privacy finding(s):" -ForegroundColor Red
    $findings | Select-Object -First 40 | ForEach-Object { Write-Host "  $_" }
    if ($findings.Count -gt 40) { Write-Host "  ... and $($findings.Count - 40) more" }
    Write-Host ''
    Write-Host 'Rewrite each value into a portable equivalent (env var / homedir() /' -ForegroundColor Yellow
    Write-Host '.gitignore) -- do NOT delete it, the code must still work.' -ForegroundColor Yellow
    exit 1
}

if (-not $Quiet) { Write-Host 'privacy-check: clean' -ForegroundColor Green }
exit 0
