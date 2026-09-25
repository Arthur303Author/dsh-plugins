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

TWO HARD-WON IMPLEMENTATION NOTES (both bugs shipped here first):

  * Every needle is matched as a FIXED STRING passed via repeated `-e` flags,
    NOT as a regex. `git grep -E` takes POSIX ERE, which has no `\s` shorthand,
    so one bad pattern makes the whole alternation fail to compile; and on
    Windows a regex containing a double quote gets mangled by command-line
    quoting, silently matching nothing. Fixed-string needles sidestep both.
  * The exit code is checked. `git grep` exits 0 with matches, 1 without, and
    >1 on error -- swallowing stderr would make a broken scan look like a clean
    one, which is the worst possible failure mode for this tool.

Usage:
  pwsh -File scripts/privacy-check.ps1
  pwsh -File scripts/privacy-check.ps1 -ExtraNeedle 'internal-host'
  pwsh -File scripts/privacy-check.ps1 -Quiet

Exit codes: 0 clean, 1 findings, 2 not a git repository, 3 the scan failed.

This file is deliberately ASCII-only: Windows PowerShell 5.1 decodes a BOM-less
.ps1 as ANSI, so a non-ASCII character inside a string literal corrupts the parse.
#>
[CmdletBinding()]
param(
    [string[]]$ExtraNeedle = @(),
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

# --- build the needle list -----------------------------------------------------
# The local account name (both separator styles) is always checked; callers add
# project-specific terms such as internal hostnames.
$user = $env:USERNAME
$needles = @(
    $user,
    "C:\Users\$user",
    "/Users/$user",
    "/home/$user",
    'api_key=', 'apikey=', 'api-key=',
    'api_key:', 'apikey:', 'api-key:',
    'password=', 'password:',
    'secret=', 'secret:',
    'BEGIN RSA PRIVATE KEY', 'BEGIN OPENSSH PRIVATE KEY', 'BEGIN PRIVATE KEY',
    # Vendor-prefixed key shapes only. A bare 'sk-' matched 'disk-mode' and
    # similar ordinary words, so the prefix has to be specific enough to be a
    # real signal.
    'ghp_', 'sk-ant-', 'sk-proj-', 'sk-live-'
)
$needles += $ExtraNeedle
$needles = $needles | Where-Object { $_ } | Select-Object -Unique

# This script names every needle it looks for, so it matches itself. Drop its own
# lines from the results instead of weakening the needle list.
$selfPath = 'scripts/privacy-check.ps1'
$dropSelf = { param($line) $line -notlike "*$selfPath*" }

if (-not $Quiet) {
    Write-Host 'privacy-check: scanning tracked content, all history, and paths' -ForegroundColor Cyan
    Write-Host "  account name : $user"
    Write-Host "  needles      : $($needles.Count)"
    if ($ExtraNeedle.Count -gt 0) { Write-Host "  extra        : $($ExtraNeedle -join ', ')" }
}

# Expand to `-e n1 -e n2 ...`, matched case-insensitively as fixed strings.
$needleArgs = @()
foreach ($n in $needles) { $needleArgs += @('-e', $n) }

$findings = @()
$scanFailed = $false

# --- 1. working tree -----------------------------------------------------------
$tree = & git grep -I -i -n -F @needleArgs -- . 2>&1
if ($LASTEXITCODE -eq 0) {
    $tree = $tree | Where-Object $dropSelf
    if ($tree) { $findings += ($tree | ForEach-Object { "worktree  $_" }) }
} elseif ($LASTEXITCODE -gt 1) {
    Write-Host "privacy-check: git grep failed on the working tree (exit $LASTEXITCODE):" -ForegroundColor Red
    $tree | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }
    $scanFailed = $true
}

# --- 2. history, commit by commit ---------------------------------------------
$revs = @(& git rev-list --all 2>$null)
if ($revs.Count -gt 0) {
    $hist = & git grep -I -i -n -F @needleArgs $revs 2>&1
    if ($LASTEXITCODE -eq 0) {
        $hist = $hist | Where-Object $dropSelf
        if ($hist) { $findings += ($hist | ForEach-Object { "history   $_" }) }
    } elseif ($LASTEXITCODE -gt 1) {
        Write-Host "privacy-check: git grep failed on history (exit $LASTEXITCODE)" -ForegroundColor Red
        $hist | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }
        $scanFailed = $true
    }
}

# --- 3. tracked paths ---------------------------------------------------------
$tracked = & git ls-files 2>$null
foreach ($p in $tracked) {
    foreach ($n in $needles) {
        if ($p.IndexOf($n, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $findings += "path      $p  (matches '$n')"
            break
        }
    }
}

if ($scanFailed) {
    Write-Host 'privacy-check: ABORTED -- the scan itself failed; treat as NOT clean.' -ForegroundColor Red
    exit 3
}

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
