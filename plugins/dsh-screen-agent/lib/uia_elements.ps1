# Enumerate one window's UI Automation tree and print one element per line.
#
# Used by screen_tools.py's `elements` action. Output format (pipe-separated,
# 6 fields):
#
#     <role>|<name>|<x>|<y>|<width>|<height>
#
# Coordinates are physical screen pixels for the element's bounding rectangle,
# so the caller can convert them to the same normalized space screen_click uses
# and click by element instead of by eyeballing a screenshot.
#
# Why a separate process: UI Automation is a .NET API that is trivially
# reachable from PowerShell and painful from ctypes. The sidecar already spawns
# helpers, so this adds no new dependency.
#
# Coverage caveat (measured): apps with a real accessibility tree work (Edge
# exposed 49 elements in 33 ms); custom-drawn UIs expose nothing (Blender,
# several Electron apps returned 0). Screenshot-based targeting stays necessary.
param(
    [Parameter(Mandatory = $true)][long]$Hwnd,
    [int]$Limit = 300,
    [string]$Filter = ""
)

$ErrorActionPreference = "Stop"

# Element names are frequently non-ASCII ("刷新", "新建会话"). Windows PowerShell
# 5.1 defaults to the console code page, which would mangle them on the way back
# to the sidecar.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    Write-Output "ERROR|UI Automation assemblies unavailable: $($_.Exception.Message)"
    exit 0
}

try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
} catch {
    Write-Output "ERROR|FromHandle failed: $($_.Exception.Message)"
    exit 0
}

if (-not $root) {
    Write-Output "ERROR|no automation element for that window handle"
    exit 0
}

# NB: this variable cannot be named $true — that is a read-only automatic constant.
$anyCondition = [System.Windows.Automation.Condition]::TrueCondition

try {
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $anyCondition)
} catch {
    Write-Output "ERROR|tree walk failed: $($_.Exception.Message)"
    exit 0
}

$windowRect = $root.Current.BoundingRectangle

$emitted = 0
foreach ($element in $all) {
    if ($emitted -ge $Limit) { break }
    try {
        $name = $element.Current.Name
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        if ($Filter -and ($name.IndexOf($Filter, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) { continue }

        $rect = $element.Current.BoundingRectangle
        # Offscreen and zero-size elements are not clickable targets.
        if ($rect.Width -le 1 -or $rect.Height -le 1) { continue }
        if ([double]::IsInfinity($rect.X) -or [double]::IsNaN($rect.X)) { continue }
        # Chromium reports scrolled-away content at huge negative offsets (seen:
        # y = -73328). An element must actually intersect the window, or
        # clicking its centre would aim far off-screen.
        if ($rect.Right -lt $windowRect.Left -or $rect.Left -gt $windowRect.Right) { continue }
        if ($rect.Bottom -lt $windowRect.Top -or $rect.Top -gt $windowRect.Bottom) { continue }

        $role = $element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        # The delimiter must not appear inside a field.
        $safeName = ($name -replace '\|', '/').Trim()

        Write-Output ("{0}|{1}|{2}|{3}|{4}|{5}" -f `
            $role, $safeName, [int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
        $emitted++
    } catch {
        # A single element can fail mid-walk (element went away); skip it.
    }
}
