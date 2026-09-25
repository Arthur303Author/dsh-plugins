<#
Act on a UI Automation element identified by what it IS, not by where it is.

uia_snapshot.ps1 describes a window's elements; this script drives one of them
through the action pattern that element advertises, so no coordinate is measured,
no screenshot is read, and the cursor never moves.

WHY SELECTION IS BY FINGERPRINT, NOT BY A LIVE REFERENCE
  Every tool call runs in a fresh process, so an element object cannot survive
  between the snapshot and the action. UI Automation's RuntimeId looks like the
  answer, but from the .NET client it is a dead end: AutomationElement exposes
  GetRuntimeId() and NO FromRuntimeId(), and the COM IUIAutomation route
  (ElementFromRuntimeId) is not reachable from PowerShell -- New-Object -ComObject
  UIAutomationClient.CUIAutomation fails with "Class not registered", and the
  interface is not late-bound. Re-finding the element by automation id, name and
  role is the supported path, and it has a useful property: once the UI changes,
  the element is reported MISSING rather than acted on through a stale handle.

WHAT A SUCCESSFUL CALL DOES *NOT* MEAN
  Windows has no background element delivery. Measured on this machine, every
  pattern tried (Invoke on WPF and on UWP Calculator, Toggle, Value) RAISED THE
  TARGET WINDOW TO THE FOREGROUND. Microsoft's own computer-use documentation
  states the same limit for Windows: the pointer moves and the task takes the
  foreground. What DOES hold here is that the cursor never moves, and that the
  element is hit exactly -- no pixel measurement, no DPI drift, no mis-click.

  Because focus is taken, this script puts the foreground back afterwards unless
  asked not to, so a user who was typing elsewhere is not left hijacked.

This file must stay ASCII: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI,
and a non-ASCII character inside a string literal corrupts the parse.
#>
param(
    [Parameter(Mandatory = $true)][long]$Hwnd,
    [Parameter(Mandatory = $true)]
    [ValidateSet('invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'scroll_into_view', 'focus', 'describe')]
    [string]$Action,
    [string]$Name = '',
    [string]$Aid = '',
    [string]$Role = '',
    [int]$Occurrence = 1,
    [string]$Value = '',
    [switch]$KeepFocus
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ScreenAgentFocus {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);

    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
    public static long FgHandle() { return GetForegroundWindow().ToInt64(); }
    public static string Fg() { IntPtr h = GetForegroundWindow(); return h.ToInt64() + "|" + Title(h); }

    /** SetForegroundWindow is asynchronous; polling is the only honest check. */
    public static bool WaitFg(IntPtr h, int ms) {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms) {
            if (GetForegroundWindow() == h) return true;
            System.Threading.Thread.Sleep(25);
        }
        return GetForegroundWindow() == h;
    }

    /**
     * Escalating takeover. The foreground lock keys off who owns the last input
     * event, so a synthesized ALT is what makes a plain request succeed.
     */
    public static bool ForceForeground(long lh) {
        IntPtr h = new IntPtr(lh);
        if (GetForegroundWindow() == h) return true;
        SetForegroundWindow(h);
        if (WaitFg(h, 250)) return true;
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        SetForegroundWindow(h);
        if (WaitFg(h, 350)) return true;
        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint myThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != myThread && fgThread != 0) { attached = AttachThreadInput(myThread, fgThread, true); }
        bool ok = SetForegroundWindow(h);
        if (attached) { AttachThreadInput(myThread, fgThread, false); }
        if (ok && WaitFg(h, 350)) return true;
        SwitchToThisWindow(h, true);
        return WaitFg(h, 500);
    }
}
"@

function Write-Json($obj) {
    Write-Output ($obj | ConvertTo-Json -Depth 5 -Compress)
}

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    Write-Json @{ ok = $false; error = "UI Automation assemblies unavailable: $($_.Exception.Message)" }
    exit 0
}

if ($Name.Length -eq 0 -and $Aid.Length -eq 0 -and $Role.Length -eq 0) {
    Write-Json @{ ok = $false; error = "select the element first: pass automationId, name and/or role" }
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

function Get-Safe($sb, $fallback) {
    try { $v = & $sb; if ($null -eq $v) { return $fallback } return $v } catch { return $fallback }
}

$cr = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @($AE::NameProperty, $AE::ControlTypeProperty, $AE::AutomationIdProperty, $AE::ClassNameProperty, $AE::IsOffscreenProperty, $AE::IsEnabledProperty)) { [void]$cr.Add($p) }

$cr.Push()
try { $found = $root.FindAll($TS::Descendants, $any) }
finally { $cr.Pop() }

$exact = New-Object System.Collections.ArrayList
$partial = New-Object System.Collections.ArrayList

foreach ($el in $found) {
    $c = $null
    try { $c = $el.Cached } catch { continue }
    if ($null -eq $c) { continue }

    $eName = Get-Safe { [string]$c.Name } ''
    $eAid = Get-Safe { [string]$c.AutomationId } ''
    $eRole = Get-Safe { $c.ControlType.ProgrammaticName -replace '^ControlType\.', '' } '?'

    if ($Aid.Length -gt 0 -and $eAid -ne $Aid) { continue }
    if ($Role.Length -gt 0 -and $eRole -ne $Role) { continue }

    if ($Name.Length -gt 0) {
        if ($eName -eq $Name) { [void]$exact.Add($el) }
        elseif ($eName -like "*$Name*") { [void]$partial.Add($el) }
    }
    else {
        [void]$exact.Add($el)
    }
}

# An exact name match outranks a substring one; occurrence then breaks ties.
if ($exact.Count -gt 0) { $matches = @($exact.ToArray()); $matchKind = 'exact' }
else { $matches = @($partial.ToArray()); $matchKind = 'partial' }

if ($matches.Count -eq 0) {
    Write-Json ([ordered]@{
            ok      = $false
            error   = "no element matched (name='$Name' automationId='$Aid' role='$Role'); the UI may have changed - take a fresh snapshot"
            matched = 0
        })
    exit 0
}
if ($Occurrence -lt 1 -or $Occurrence -gt $matches.Count) {
    Write-Json ([ordered]@{
            ok      = $false
            error   = "occurrence $Occurrence is out of range: $($matches.Count) element(s) matched"
            matched = $matches.Count
        })
    exit 0
}

$target = $matches[$Occurrence - 1]
$fgBefore = [ScreenAgentFocus]::Fg()
$fgBeforeHandle = [ScreenAgentFocus]::FgHandle()

$outcome = ''
$ok = $true
switch ($Action) {
    'invoke' {
        try {
            $p = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $p.Invoke()
            $outcome = 'invoked'
        } catch { $ok = $false; $outcome = $_.Exception.Message }
    }
    'set_value' {
        try {
            $p = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $p.SetValue($Value)
            $outcome = 'value set; read back: ' + $p.Current.Value
        } catch { $ok = $false; $outcome = $_.Exception.Message }
    }
    'toggle' {
        try {
            $p = $target.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            $p.Toggle()
            $outcome = 'toggled; state is now ' + $p.Current.ToggleState
        } catch { $ok = $false; $outcome = $_.Exception.Message }
    }
    'select' {
        try {
            $p = $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $p.Select()
            $outcome = 'selected'
        } catch { $ok = $false; $outcome = $_.Exception.Message }
    }
    'expand' {
        try {
            $p = $target.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            $p.Expand()
            $outcome = 'expanded; state is now ' + $p.Current.ExpandCollapseState
        } catch { $ok = $false; $outcome = $_.Exception.Message }
    }
    'collapse' {
        try {
            $p = $target.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            $p.Collapse()
            $outcome = 'collapsed; state is now ' + $p.Current.ExpandCollapseState
        } catch { $ok = $false; $outcome = $_.Exception.Message }
    }
    'scroll_into_view' {
        try {
            $p = $target.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
            $p.ScrollIntoView()
            $outcome = 'scrolled into view'
        } catch { $ok = $false; $outcome = $_.Exception.Message }
    }
    'focus' {
        try { $target.SetFocus(); $outcome = 'focused' }
        catch { $ok = $false; $outcome = $_.Exception.Message }
    }
    'describe' {
        $outcome = 'no action requested (describe only)'
    }
}

Start-Sleep -Milliseconds 420

$fgAfterHandle = [ScreenAgentFocus]::FgHandle()
$restored = $false
if (-not $KeepFocus -and $fgAfterHandle -ne $fgBeforeHandle -and $fgBeforeHandle -ne 0) {
    # The pattern call pulled the target forward; hand the foreground back.
    if ([ScreenAgentFocus]::ForceForeground($fgBeforeHandle)) { $restored = $true }
    Start-Sleep -Milliseconds 150
}

Write-Json ([ordered]@{
        ok            = $ok
        action        = $Action
        matchKind     = $matchKind
        matched       = $matches.Count
        occurrence    = $Occurrence
        role          = Get-Safe { $target.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '' } '?'
        name          = Get-Safe { [string]$target.Current.Name } ''
        aid           = Get-Safe { [string]$target.Current.AutomationId } ''
        outcome       = $outcome
        foregroundBefore = $fgBefore
        foregroundAfter  = [ScreenAgentFocus]::Fg()
        focusRestored = $restored
        note          = 'a pattern call reaches the control but raises its window to the foreground; the cursor is not moved'
    })
