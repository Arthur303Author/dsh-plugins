"""Adversarial checks for the dsh-screen-agent sidecar.

Only read-only actions (capture/zoom) are exercised on their happy path; every
input-action test drives an error path that must abort BEFORE touching the
cursor or keyboard. Nothing here clicks or types on the real desktop.
"""

import base64
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
import time

# Resolve the sidecar next to this suite instead of a baked-in development
# path: the sources moved to ~/.dsh/plugins/dsh-screen-agent, and a stale
# absolute path made every I/O case fail with "can't open file".
SIDE = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "lib", "screen_tools.py")
SIDE = os.path.normpath(SIDE)
BUDGET = 640000
# Disk-mode target lives in the OS temp dir so the suite is self-contained and
# does not depend on any scratch directory existing.
DISK_OUT = os.path.join(tempfile.gettempdir(), "dsh-screen-agent-disk-mode.png")
outcomes = []


def run(req, raw_input=None, timeout=120):
    payload = raw_input if raw_input is not None else json.dumps(req)
    proc = subprocess.run(
        [sys.executable, SIDE],
        input=payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
    )
    if not proc.stdout.strip():
        return {"ok": False, "error": f"empty stdout; stderr={proc.stderr[:300]}"}
    return json.loads(proc.stdout)


def check(name, condition, detail=""):
    outcomes.append((name, bool(condition), detail))
    print(("PASS  " if condition else "FAIL  ") + name + ("" if condition else f"   <- {detail}"))


def is_png(b64):
    """Decode and fully verify the payload as a PNG (catches truncation too)."""
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        return False
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        return False
    try:
        import io

        from PIL import Image

        image = Image.open(io.BytesIO(raw))
        image.verify()
        return True
    except Exception:
        return False


# --- capture ---------------------------------------------------------------
cap = run({"action": "capture", "inline": True})
check("capture succeeds", cap.get("ok") is True, cap)
check("capture returns a valid PNG", is_png(cap.get("pngBase64", "")))
check("capture payload is non-trivial", len(cap.get("pngBase64", "")) > 1000)
check(
    "capture stays within the provider budget",
    cap.get("imageWidth", 0) * cap.get("imageHeight", 0) <= BUDGET,
    f'{cap.get("imageWidth")}x{cap.get("imageHeight")}',
)
check("capture reports desktop >= image", cap.get("desktopWidth", 0) >= cap.get("imageWidth", 0))

disk = run({"action": "capture", "out": DISK_OUT})
check("capture still supports disk mode", disk.get("ok") is True, disk)
check("disk mode actually writes the file", os.path.exists(DISK_OUT), DISK_OUT)
check("disk mode omits the inline payload", "pngBase64" not in disk, list(disk)[:8])

# --- zoom: happy path ------------------------------------------------------
# Full width (2560 px) x 0.15 of the height (240 px) = 614,400 px, inside budget.
lossless = run({"action": "zoom", "inline": True, "nx0": 0.0, "ny0": 0.0, "nx1": 1.0, "ny1": 0.15})
check("zoom succeeds", lossless.get("ok") is True, lossless)
check("zoom returns a valid PNG", is_png(lossless.get("pngBase64", "")))
check("budget-sized crop is lossless", lossless.get("lossless") is True, lossless.get("scale"))
check(
    "lossless crop keeps native pixels",
    lossless.get("cropWidth") == lossless.get("imageWidth")
    and lossless.get("cropHeight") == lossless.get("imageHeight"),
    f'{lossless.get("cropWidth")}x{lossless.get("cropHeight")} -> {lossless.get("imageWidth")}x{lossless.get("imageHeight")}',
)
check("zoom echoes the requested rectangle", lossless.get("nx1") == 1.0 and lossless.get("ny1") == 0.15)

# Detail proof: the crop must carry more real pixels than the same area of a
# full screenshot. A 0.2x0.2 crop is 512x320 px here; scaled into the full-frame
# budget it would only be ~202x126 px.
fine = run({"action": "zoom", "inline": True, "nx0": 0.4, "ny0": 0.4, "nx1": 0.6, "ny1": 0.6})
check("small crop is lossless", fine.get("lossless") is True, fine.get("scale"))
check(
    "small crop beats the downscaled full frame",
    fine.get("imageWidth", 0) > 300,
    f'crop gave {fine.get("imageWidth")}x{fine.get("imageHeight")}',
)

# --- zoom: over budget -----------------------------------------------------
over = run({"action": "zoom", "inline": True, "nx0": 0.0, "ny0": 0.0, "nx1": 1.0, "ny1": 1.0})
check("oversized crop still returns an image", over.get("ok") is True)
check("oversized crop is flagged lossy", over.get("lossless") is False)
check(
    "oversized crop respects the budget",
    over.get("imageWidth", 0) * over.get("imageHeight", 0) <= BUDGET,
    f'{over.get("imageWidth")}x{over.get("imageHeight")}',
)

# --- zoom: rejection paths -------------------------------------------------
cases = [
    ("empty width", {"nx0": 0.5, "ny0": 0.0, "nx1": 0.5, "ny1": 0.5}),
    ("inverted", {"nx0": 0.8, "ny0": 0.8, "nx1": 0.2, "ny1": 0.2}),
    ("negative", {"nx0": -0.1, "ny0": 0.0, "nx1": 0.5, "ny1": 0.5}),
    ("above one", {"nx0": 0.0, "ny0": 0.0, "nx1": 1.4, "ny1": 0.5}),
    ("too small", {"nx0": 0.5, "ny0": 0.5, "nx1": 0.5001, "ny1": 0.5001}),
    ("missing keys", {"nx0": 0.1}),
    ("non-numeric", {"nx0": "abc", "ny0": 0.0, "nx1": 0.5, "ny1": 0.5}),
    ("null", {"nx0": None, "ny0": 0.0, "nx1": 0.5, "ny1": 0.5}),
]
for label, rect in cases:
    res = run({"action": "zoom", **rect})
    check(f"zoom rejects {label}", res.get("ok") is False, res)

# --- windows: enumeration and targeting ------------------------------------
listing = run({"action": "windows"})
check("windows enumerates successfully", listing.get("ok") is True, listing)
check("windows reports a numeric count", isinstance(listing.get("count"), int), listing.get("count"))
check("windows returns display lines", isinstance(listing.get("lines"), list) and len(listing.get("lines", [])) > 0)

visible = listing.get("windows", [])
check("windows exposes structured entries", isinstance(visible, list))

# A developer desktop usually has the harness's own browser window on top, and
# this plugin refuses to act on it on purpose. Target the first window the plugin
# WILL act on, so this suite does not depend on what happens to be frontmost.
_PROTECT_MARKERS = [
    marker.strip().lower()
    for marker in os.environ.get("DSH_SCREEN_AGENT_PROTECT", "DeepSeek Harness").split(",")
    if marker.strip()
]


def protected_entry(entry):
    title = str(entry.get("title", "")).lower()
    return any(marker in title for marker in _PROTECT_MARKERS)


actionable = [] if not visible else [
    (index, window) for index, window in enumerate(visible)
    if not protected_entry(window)
]

if actionable:
    top_index, top = actionable[0]
    check("window entries carry a handle and title", "hwnd" in top and "title" in top, list(top)[:6])
    check("window entries carry a rectangle", top.get("width", 0) > 0 and top.get("height", 0) > 0)

    # Capture it WITHOUT stealing focus: this must neither raise the window nor
    # change what the user is looking at.
    shot = run({"action": "window", "inline": True, "window": top_index, "focus": False, "capture": True})
    check("window capture succeeds", shot.get("ok") is True, shot)
    check("window capture returns a valid PNG", is_png(shot.get("pngBase64", "")))
    check(
        "window capture names its method",
        shot.get("captureMethod") in ("printwindow", "screen-fallback"),
        shot.get("captureMethod"),
    )
    check(
        "window capture respects the budget",
        shot.get("imageWidth", 0) * shot.get("imageHeight", 0) <= BUDGET,
        f'{shot.get("imageWidth")}x{shot.get("imageHeight")}',
    )

    # Index, title substring, and hwnd must all resolve to the same window.
    by_index = run({"action": "window", "window": top_index, "focus": False, "capture": False})
    by_title = run({"action": "window", "window": top["title"][:12], "focus": False, "capture": False})
    by_handle = run({"action": "window", "window": f'0x{top["hwnd"]:08X}', "focus": False, "capture": False})
    check("window resolves by index", by_index.get("ok") is True, by_index)
    check("window resolves by title substring", by_title.get("ok") is True, by_title)
    check("window resolves by hwnd", by_handle.get("ok") is True, by_handle)
    check(
        "index, title and hwnd agree",
        by_index.get("hwnd") == by_title.get("hwnd") == by_handle.get("hwnd") == shot.get("hwnd"),
        f'{by_index.get("hwnd")} / {by_title.get("hwnd")} / {by_handle.get("hwnd")} / {shot.get("hwnd")}',
    )
elif visible:
    check("window capture skipped: every visible window is protected", True)
else:
    check("window capture skipped: no visible windows on this desktop", True)

# --- window: rejection paths (focus=False, so nothing is raised) -----------
window_cases = [
    ("missing window", {"window": None}),
    ("out-of-range index", {"window": 9999}),
    ("no title match", {"window": "zzz-no-such-window-zzz"}),
    ("blank title", {"window": "   "}),
    ("boolean window", {"window": True}),
]
for label, args in window_cases:
    res = run({"action": "window", "focus": False, "capture": False, **args})
    check(f"window rejects {label}", res.get("ok") is False, res)

if actionable:
    check(
        "window rejects out-of-range click fraction",
        run({"action": "window", "window": top_index, "focus": False, "capture": False,
             "nx": 1.5, "ny": 0.5}).get("ok") is False,
    )
    check(
        "window rejects bad button",
        run({"action": "window", "window": top_index, "focus": False, "capture": False,
             "nx": 0.5, "ny": 0.5, "button": "laser"}).get("ok") is False,
    )

# --- click: rejection only (never reaches the cursor) ----------------------
click_cases = [
    ("out of range nx", {"nx": 1.5, "ny": 0.5}),
    ("negative ny", {"nx": 0.5, "ny": -0.2}),
    ("missing ny", {"nx": 0.5}),
    ("non-numeric", {"nx": "left", "ny": 0.5}),
    ("bad button", {"nx": 0.5, "ny": 0.5, "button": "laser"}),
    ("bad clicks", {"nx": 0.5, "ny": 0.5, "clicks": "many"}),
]
for label, args in click_cases:
    res = run({"action": "click", **args})
    check(f"click rejects {label}", res.get("ok") is False, res)

# --- type: rejection only --------------------------------------------------
check("type rejects non-string", run({"action": "type", "text": 123}).get("ok") is False)
check("type rejects huge input", run({"action": "type", "text": "a" * 20001}).get("ok") is False)
check("type rejects bad delay", run({"action": "type", "text": "x", "delayMs": "fast"}).get("ok") is False)

# --- protocol handling -----------------------------------------------------
check("unknown action rejected", run({"action": "reboot"}).get("ok") is False)
check("empty input rejected", run({}, raw_input="").get("ok") is False)
check("malformed JSON rejected", run({}, raw_input="{not json").get("ok") is False)
check("JSON array rejected", run({}, raw_input="[1,2,3]").get("ok") is False)
check("action-less object rejected", run({}, raw_input="{}").get("ok") is False)
check("errors are JSON on stdout", run({"action": "nope"}).get("error") is not None)
check("errors name the expected actions", "capture" in str(run({"action": "nope"}).get("error", "")))

# --- move / key: the split-out movement and keyboard actions ---------------
# Every case here is a rejection path, so nothing moves the real cursor and no
# key ever reaches a window.
move_cases = [
    ("missing coordinates", {}),
    ("out-of-range nx", {"nx": 1.5, "ny": 0.5}),
    ("negative ny", {"nx": 0.5, "ny": -0.1}),
    ("non-numeric", {"nx": "left", "ny": 0.5}),
    ("null coordinate", {"nx": None, "ny": 0.5}),
]
for label, args in move_cases:
    res = run({"action": "move", **args})
    check(f"move rejects {label}", res.get("ok") is False, res)

key_cases = [
    ("missing keys", {}),
    ("empty list", {"keys": []}),
    ("not a list", {"keys": "esc"}),
    ("non-string entry", {"keys": [123]}),
    ("unknown key name", {"keys": ["nosuchkey"]}),
    ("repeated modifier", {"keys": ["ctrl+ctrl+a"]}),
    ("combo ending in a modifier", {"keys": ["ctrl+shift"]}),
    ("too many combos", {"keys": ["esc"] * 33}),
]
for label, args in key_cases:
    res = run({"action": "key", **args})
    check(f"key rejects {label}", res.get("ok") is False, res)

# One bad name anywhere in the batch must abort the whole call before any key is
# sent — otherwise the valid prefix would already have fired.
res = run({"action": "key", "keys": ["esc", "nosuchkey"]})
check("key aborts the whole batch on one bad name", res.get("ok") is False, res)

# --- sampling + ambiguity: both proved on a throwaway WinForms window --------
# Two contracts are checked against one self-made target, so neither depends on
# a particular application being open or installed:
#
#  1. Sampling. The old rule stopped at the first repeated fingerprint. A tree
#     that returns the same two-element shell twice (Windows 11 Notepad did
#     exactly that) was declared stable, and the caller was told the app "draws
#     its own UI". The rule now also requires MinRounds (3) before a repeat is
#     accepted, and an empty tree is never called stable, while a real tree must
#     still settle.
#
#  2. Ambiguity. Measured harm of guessing: a call that passed only
#     role='Button' matched 5 buttons, silently took occurrence 1, and closed a
#     tab nobody named. An under-specified selector must refuse and list the
#     candidates instead.
#
# The probe is WinForms on purpose. Tk publishes NOTHING to UI Automation
# (measured: a Tk window with three buttons and a label returns 0 elements), so a
# Tk probe would only ever exercise the empty-tree path.
GUI_PROBE = r'''
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = "screen-agent sampling probe"
$form.Width = 360
$form.Height = 220
$form.TopMost = $true
for ($i = 0; $i -lt 3; $i++) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = "probe-button-$i"
    $b.Name = "probeButton$i"
    $b.Location = New-Object System.Drawing.Point(20, (20 + $i * 40))
    $form.Controls.Add($b)
}
$l = New-Object System.Windows.Forms.Label
$l.Text = "probe-label"
$l.Name = "probeLabel"
$l.Location = New-Object System.Drawing.Point(20, 150)
$form.Controls.Add($l)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 25000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
[void]$form.ShowDialog()
'''

probe_path = os.path.join(tempfile.gettempdir(), "screen_agent_sampling_probe.ps1")
with open(probe_path, "w", encoding="utf-8-sig") as handle:
    handle.write(GUI_PROBE)

probe = subprocess.Popen(
    ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probe_path],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    probe_spec = None
    for _ in range(40):
        listing = run({"action": "windows"})
        for entry in (listing.get("windows") or []):
            if "sampling probe" in str(entry.get("title", "")):
                probe_spec = str(entry.get("title"))
                break
        if probe_spec is not None:
            break
        time.sleep(0.5)

    if probe_spec is None:
        check("sampling probe window appeared", False, "WinForms window never showed up")
    else:
        listed = run({"action": "elements", "window": probe_spec, "limit": 60})
        check("sampling probe is readable", listed.get("ok") is True, listed)
        check("sampling runs at least MinRounds before accepting a repeat",
              isinstance(listed.get("rounds"), int) and listed.get("rounds") >= 3,
              listed.get("rounds"))
        check("a real tree is still reported stable", listed.get("stable") is True,
              listed.get("stable"))
        check("sampling probe exposes its widgets",
              listed.get("count", 0) >= 4, listed.get("count"))

        # Pick the role from the data instead of assuming one. Measured: a
        # WinForms Button surfaces as role 'Pane' through the MSAA bridge, so
        # hardcoding 'Button' tested the wrong thing (and did fail here once).
        role_counts = {}
        for element in listed.get("elements", []):
            role = element.get("role")
            role_counts[role] = role_counts.get(role, 0) + 1
        repeated = [role for role, n in role_counts.items() if role and n > 1]

        roles_text = ", ".join(f"{role}x{n}" for role, n in sorted(role_counts.items()))
        if not repeated:
            check("probe exposes a role that repeats", False, f"roles seen: {roles_text}")
        else:
            ambiguous = run({
                "action": "act",
                "window": probe_spec,
                "elementAction": "describe",
                "role": repeated[0],
            })
            check("ambiguous selector is refused", ambiguous.get("ok") is False, ambiguous)
            check("refusal names the ambiguity",
                  "refusing to guess" in str(ambiguous.get("error", "")),
                  f"{ambiguous.get('error')} | roles seen: {roles_text}")
            # The candidates must ride inside the error text: the tool layer keeps
            # only `error` from a failing sidecar response.
            refusal = str(ambiguous.get("error", ""))
            check("refusal lists the candidates in the error text",
                  "candidates:" in refusal and refusal.count("#") > 1,
                  f"{refusal} | roles seen: {roles_text}")
            check("refusal says how many matched",
                  "elements matched" in refusal, refusal)

            single = run({
                "action": "act",
                "window": probe_spec,
                "elementAction": "describe",
                "role": repeated[0],
                "occurrence": 1,
            })
            check("an explicit occurrence is honoured", single.get("ok") is True,
                  f"{single} | roles seen: {roles_text}")

            blank = run({
                "action": "act",
                "window": probe_spec,
                "elementAction": "describe",
                "name": "",
                "automationId": "",
                "role": "",
            })
            check("a blank selector is rejected before any lookup",
                  blank.get("ok") is False and "select the element" in str(blank.get("error", "")),
                  blank)
finally:
    probe.terminate()
    try:
        probe.wait(timeout=5)
    except subprocess.TimeoutExpired:
        probe.kill()

# --- concurrency: the old fixed-filename design would race here ------------
def one_capture(_):
    res = run({"action": "capture", "inline": True})
    return res.get("ok") is True and is_png(res.get("pngBase64", ""))

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    parallel = list(pool.map(one_capture, range(6)))
check("6 concurrent captures all return valid PNGs", all(parallel), parallel)

# --- summary ---------------------------------------------------------------
failed = [name for name, ok, _ in outcomes if not ok]
print()
print(f"{len(outcomes) - len(failed)}/{len(outcomes)} passed")
if failed:
    print("FAILED: " + "; ".join(failed))
    raise SystemExit(1)
print("all sidecar checks passed")
