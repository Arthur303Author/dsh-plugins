<#
UI Automation element snapshot for the screen-agent sidecar.

Emits one JSON document describing a window's elements, carrying the facts an
agent needs in order to act on an ELEMENT rather than on a pixel: role, name,
automation id, class, bounds, state, the action patterns it supports, and its
current value.

Every non-obvious decision below was measured on a real desktop first.

  * Chromium builds its accessibility tree lazily. The first FindAll on an Edge
    window returned 49 shell-only elements; the same window later returned 414,
    including the page's Text nodes. One sample therefore under-reports entire
    applications, so this script samples until two consecutive rounds agree and
    reports whether it stabilized.

  * Pattern availability CANNOT be read from the cached derived properties
    (IsInvokePatternAvailableProperty and friends): in the .NET client they read
    back empty, and PowerShell returns $null for a member that does not exist
    instead of throwing, so the failure is silent and looks like "no patterns".
    Patterns come from GetSupportedPatterns() on the live element instead.

  * That call is one cross-process round trip PER element, so it is the dominant
    cost. Stabilization therefore runs on cached properties alone -- after a
    cache request those reads are local -- and pattern probing happens once, on
    the settled tree, for candidates that survived a cheap pre-filter.

  * BoundingRectangle is Infinity for some virtualized nodes. Casting that to
    [int] throws and killed an earlier probe run, so bounds are validated first.

  * AutomationPattern.ProgrammaticName is "InvokePatternIdentifiers.Pattern", so
    a "Pattern$" strip leaves the noisy "…PatternIdentifiers." behind. Names are
    trimmed to the short action form and filtered against a whitelist.

  * Screen coordinates are only comparable if this process shares the sidecar's
    DPI awareness, so the process is made DPI aware before any element is read.

  * This file must stay ASCII. Windows PowerShell 5.1 decodes a BOM-less .ps1 as
    ANSI, and a non-ASCII character inside a string literal corrupts the parse.
#>
param(
    [Parameter(Mandatory = $true)][long]$Hwnd,
    [int]$Limit = 150,
    [string]$Filter = "",
    [int]$MaxRounds = 5,
    [int]$IntervalMs = 220,
    [switch]$Single
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ScreenAgentDpi {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
try { [void][ScreenAgentDpi]::SetProcessDPIAware() } catch { }

function Write-Json($obj) {
    Write-Output ($obj | ConvertTo-Json -Depth 6 -Compress)
}

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    Write-Json @{ ok = $false; error = "UI Automation assemblies unavailable: $($_.Exception.Message)" }
    exit 0
}

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$any = [System.Windows.Automation.Condition]::TrueCondition

$root = $null
try { $root = $AE::FromHandle([IntPtr]$Hwnd) } catch { }
if ($null -eq $root) {
    Write-Json @{ ok = $false; error = "no UI Automation element for window handle $Hwnd" }
    exit 0
}

# Only patterns a caller can drive. SynchronizedInput, Transform, Window and
# friends are UIA internals that name no user-facing action. ScrollItem is
# deliberately excluded even though it is actionable: measured on Calculator and
# Edge it appeared on 53/60 and 60/60 elements, so it carries no signal. The
# action that needs it (scroll_into_view) is attempted directly by uia_act.ps1.
$USEFUL_PATTERNS = @(
    'Invoke', 'Value', 'Toggle', 'SelectionItem', 'Selection',
    'ExpandCollapse', 'Scroll', 'RangeValue', 'Text'
)

function New-CacheRequest {
    $cr = New-Object System.Windows.Automation.CacheRequest
    foreach ($p in @(
            $AE::NameProperty, $AE::ControlTypeProperty, $AE::BoundingRectangleProperty,
            $AE::IsEnabledProperty, $AE::IsOffscreenProperty, $AE::AutomationIdProperty,
            $AE::ClassNameProperty, $AE::IsKeyboardFocusableProperty, $AE::HasKeyboardFocusProperty
        )) { [void]$cr.Add($p) }
    return $cr
}

function Get-Safe($sb, $fallback) {
    try { $v = & $sb; if ($null -eq $v) { return $fallback } return $v } catch { return $fallback }
}

function Get-ShortPatterns($el) {
    $acc = New-Object System.Collections.ArrayList
    try {
        foreach ($p in $el.GetSupportedPatterns()) {
            $short = $p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', ''
            if ($USEFUL_PATTERNS -contains $short) { [void]$acc.Add($short) }
        }
    } catch { }
    return , @($acc.ToArray())
}

<#
Read the tree once. With -Full, patterns and control state are probed as well;
without it only cached properties are touched, which stays local and fast.
#>
function Read-Snapshot {
    param($CacheRequest, [switch]$Full)

    $CacheRequest.Push()
    try { $found = $root.FindAll($TS::Descendants, $any) }
    finally { $CacheRequest.Pop() }

    $list = New-Object System.Collections.ArrayList
    foreach ($el in $found) {
        $c = $null
        try { $c = $el.Cached } catch { continue }
        if ($null -eq $c) { continue }

        $name = Get-Safe { [string]$c.Name } ''
        $aid = Get-Safe { [string]$c.AutomationId } ''
        if ($Filter -and ($name.IndexOf($Filter, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) { continue }

        $off = Get-Safe { [bool]$c.IsOffscreen } $false

        if (-not $Full) {
            # Fingerprint pass: identity only, no per-element round trips.
            [void]$list.Add([pscustomobject]@{
                    role = Get-Safe { $c.ControlType.ProgrammaticName -replace '^ControlType\.', '' } '?'
                    name = $name
                    aid  = $aid
                })
            continue
        }

        # A nameless, id-less, offscreen node cannot be a target.
        if ($name.Length -eq 0 -and $aid.Length -eq 0 -and $off) { continue }

        $pats = Get-ShortPatterns $el
        if ($name.Length -eq 0 -and $aid.Length -eq 0 -and $pats.Count -eq 0) { continue }

        $entry = [ordered]@{
            role = Get-Safe { $c.ControlType.ProgrammaticName -replace '^ControlType\.', '' } '?'
            name = $name
            aid  = $aid
            cls  = Get-Safe { [string]$c.ClassName } ''
            on   = Get-Safe { [bool]$c.IsEnabled } $false
            off  = $off
            kbd  = Get-Safe { [bool]$c.IsKeyboardFocusable } $false
            foc  = Get-Safe { [bool]$c.HasKeyboardFocus } $false
            pats = $pats
        }

        $rect = Get-Safe { $c.BoundingRectangle } $null
        $entry.x = $null; $entry.y = $null; $entry.w = $null; $entry.h = $null
        if ($null -ne $rect) {
            $rx = Get-Safe { [double]$rect.X } $null
            $ry = Get-Safe { [double]$rect.Y } $null
            $rw = Get-Safe { [double]$rect.Width } $null
            $rh = Get-Safe { [double]$rect.Height } $null
            if ($null -ne $rx -and $null -ne $ry -and $null -ne $rw -and $null -ne $rh -and
                -not [double]::IsInfinity($rx) -and -not [double]::IsNaN($rx) -and
                -not [double]::IsInfinity($ry) -and -not [double]::IsNaN($ry) -and
                -not [double]::IsInfinity($rw) -and -not [double]::IsNaN($rw) -and
                -not [double]::IsInfinity($rh) -and -not [double]::IsNaN($rh)) {
                $entry.x = [int]$rx; $entry.y = [int]$ry; $entry.w = [int]$rw; $entry.h = [int]$rh
            }
        }

        if ($pats -contains 'Value') {
            $value = Get-Safe {
                $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                [string]$vp.Current.Value
            } ''
            if ($value.Length -gt 160) { $value = $value.Substring(0, 160) + '...' }
            $entry.val = $value
        }
        if ($pats -contains 'Toggle') {
            $entry.chk = Get-Safe {
                $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                [string]$tp.Current.ToggleState
            } ''
        }
        if ($pats -contains 'ExpandCollapse') {
            $entry.exp = Get-Safe {
                $ep = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
                [string]$ep.Current.ExpandCollapseState
            } ''
        }
        if ($pats -contains 'SelectionItem') {
            $entry.sel = Get-Safe {
                $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                [bool]$sp.Current.IsSelected
            } $false
        }

        [void]$list.Add([pscustomobject]$entry)
        if ($list.Count -ge $Limit) { break }
    }

    return , @($list.ToArray())
}

function Get-Fingerprint($items) {
    $parts = New-Object System.Collections.ArrayList
    foreach ($it in $items) { [void]$parts.Add($it.role + [char]1 + $it.name + [char]1 + $it.aid) }
    return ($parts -join [char]2)
}

$cr = New-CacheRequest
$stable = $false
$rounds = 0
$previous = ''
for ($r = 1; $r -le $MaxRounds; $r++) {
    $rounds = $r
    $cheap = Read-Snapshot -CacheRequest $cr
    $fingerprint = Get-Fingerprint $cheap
    if ($r -gt 1 -and $fingerprint -eq $previous) { $stable = $true; break }
    $previous = $fingerprint
    if ($Single) { break }
    if ($r -lt $MaxRounds) { Start-Sleep -Milliseconds $IntervalMs }
}

$elements = Read-Snapshot -CacheRequest $cr -Full
$title = Get-Safe { [string]$root.Current.Name } ''

Write-Json ([ordered]@{
        ok       = $true
        window   = $title
        hwnd     = $Hwnd
        count    = $elements.Count
        stable   = $stable
        rounds   = $rounds
        elements = $elements
    })
