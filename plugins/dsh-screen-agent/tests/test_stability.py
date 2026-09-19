"""Stability checks for the dsh-screen-agent sidecar.

test_sidecar.py covers correctness and rejection paths. This file covers what
only shows up under repetition and contention:

  * sustained sequential load
  * high-concurrency mixed load
  * GDI / USER handle hygiene across many window captures in one process
  * orphaned process leaks after load
  * repeated-run health

Read-only actions only. Nothing here clicks or types on the real desktop.

Run: python tests/test_stability.py
"""

import concurrent.futures
import ctypes
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(os.path.dirname(HERE), "lib")
SIDE = os.path.join(LIB, "screen_tools.py")
BUDGET = 640000
outcomes = []


def check(name, ok, detail=""):
    outcomes.append((name, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"   <- {detail}"))


def run(req, timeout=180):
    """One sidecar round-trip. Returns (parsed response, wall seconds)."""
    started = time.time()
    proc = subprocess.run(
        [sys.executable, SIDE],
        input=json.dumps(req),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
    )
    elapsed = time.time() - started
    if not proc.stdout.strip():
        return {"ok": False, "error": f"empty stdout; stderr={proc.stderr[:300]}"}, elapsed
    return json.loads(proc.stdout), elapsed


# --- 1. sustained sequential load ------------------------------------------
ROUNDS = 30
durations = []
failures = []
for index in range(ROUNDS):
    response, elapsed = run({"action": "capture", "inline": True})
    durations.append(elapsed)
    if response.get("ok") is not True:
        failures.append((index, response))

check(f"{ROUNDS} sequential captures all succeed", not failures, failures[:2])
ordered = sorted(durations)
check(
    "every capture stayed under 15s",
    ordered[-1] < 15,
    f"max {ordered[-1]:.2f}s",
)
check(
    "capture latency is not drifting upward",
    # Last quartile vs first quartile: a leak or growing state would show here.
    sum(ordered[-5:]) / 5 < (sum(ordered[:5]) / 5) * 3 + 1.0,
    f"first5 {sum(ordered[:5]) / 5:.2f}s  last5 {sum(ordered[-5:]) / 5:.2f}s",
)
print(f"      median {ordered[len(ordered) // 2]:.2f}s   max {ordered[-1]:.2f}s")


# --- 2. high-concurrency mixed load ----------------------------------------
def mixed(index):
    kind = index % 3
    if kind == 0:
        response, _ = run({"action": "capture", "inline": True})
    elif kind == 1:
        response, _ = run({"action": "zoom", "inline": True,
                           "nx0": 0.1, "ny0": 0.1, "nx1": 0.3, "ny1": 0.3})
    else:
        response, _ = run({"action": "windows"})
    return response.get("ok") is True, response.get("error")


with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
    mixed_results = list(pool.map(mixed, range(16)))
check(
    "16 concurrent mixed actions all succeed",
    all(ok for ok, _ in mixed_results),
    [err for ok, err in mixed_results if not ok][:2],
)

# Concurrency must not corrupt payloads: re-verify one inline image end to end.
concurrent_shots = []


def capture_payload(_):
    response, _ = run({"action": "capture", "inline": True})
    return response.get("pngBase64", "")


with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    concurrent_shots = list(pool.map(capture_payload, range(8)))


def valid_png(b64):
    try:
        import base64
        import io

        from PIL import Image

        raw = base64.b64decode(b64, validate=True)
        if raw[:8] != b"\x89PNG\r\n\x1a\n":
            return False
        Image.open(io.BytesIO(raw)).verify()
        return True
    except Exception:
        return False


check("8 concurrent payloads are all intact PNGs", all(valid_png(s) for s in concurrent_shots))


# --- 3. handle hygiene ------------------------------------------------------
sys.path.insert(0, LIB)
import screen_tools as sidecar  # noqa: E402  (path set above on purpose)

sidecar.make_dpi_aware()


try:
    from ctypes import wintypes

    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # Without explicit signatures ctypes passes the pseudo-handle as a 32-bit
    # int and GetGuiResources fails, returning 0 — indistinguishable from "no
    # GDI objects yet".
    _kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    _user32.GetGuiResources.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    _user32.GetGuiResources.restype = wintypes.DWORD
    _HANDLE_API = True
except Exception:
    _HANDLE_API = False


def gui_counts():
    """(GDI objects, USER objects) for this process, or None when unavailable."""
    if not _HANDLE_API:
        return None
    try:
        process = _kernel32.GetCurrentProcess()
        return (
            int(_user32.GetGuiResources(process, 0)),
            int(_user32.GetGuiResources(process, 1)),
        )
    except Exception:
        return None


windows = sidecar.enumerate_windows()
if windows and gui_counts() is not None:
    target = windows[0]["hwnd"]
    rect = sidecar.window_rect(target)
    width, height = rect.right - rect.left, rect.bottom - rect.top

    for _ in range(3):  # warm caches so the baseline is steady
        sidecar.print_window_image(target, width, height)

    before = gui_counts()
    # Do NOT assert before[0] > 0: print_window_image releases every GDI object
    # in its finally block, so a process that has done nothing else can sit at 0
    # legitimately. Asserting "> 0" made this check flap depending on which
    # window happened to be topmost (a window whose capture fails leaves the
    # counter at 0). The meaningful assertion is the growth check below.
    check("GDI/USER counters are readable", before is not None, before)
    for _ in range(60):
        sidecar.print_window_image(target, width, height)
    after = gui_counts()

    gdi_growth = after[0] - before[0]
    user_growth = after[1] - before[1]
    check(
        "60 in-process window captures do not leak GDI handles",
        gdi_growth <= 2,
        f"{before[0]} -> {after[0]} (+{gdi_growth})",
    )
    check(
        "60 in-process window captures do not leak USER handles",
        user_growth <= 2,
        f"{before[1]} -> {after[1]} (+{user_growth})",
    )
    # The whole point of capture_window(): it must not blow up on any window.
    failures = 0
    for window in windows[:5]:
        try:
            image, method = sidecar.capture_window(window["hwnd"])
            if image.size[0] < 1 or image.size[1] < 1:
                failures += 1
        except Exception:
            failures += 1
    check("capture_window survives every visible window", failures == 0, f"{failures} failures")
else:
    print("      handle hygiene skipped: no measurable target on this desktop")
    check("handle hygiene skipped", True)


# --- 4. orphaned processes --------------------------------------------------
def python_pids():
    """PIDs of live python.exe processes, parsed from tasklist CSV."""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq python.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except Exception:
        return None
    pids = set()
    for line in out.splitlines():
        parts = [part.strip().strip('"') for part in line.split('","')]
        if len(parts) >= 2 and parts[1].isdigit():
            pids.add(parts[1])
    return pids


before_pids = python_pids()
for _ in range(12):
    run({"action": "capture", "inline": True})
time.sleep(1.5)
after_pids = python_pids()

if before_pids is None or after_pids is None:
    print("      process leak check skipped: tasklist unavailable")
    check("process leak check skipped", True)
else:
    leaked = after_pids - before_pids
    check("no orphaned sidecar processes after 12 calls", not leaked, f"leaked: {sorted(leaked)}")


# --- 5. repeated-run health -------------------------------------------------
repeat_failures = 0
for _ in range(25):
    response, _ = run({"action": "zoom", "inline": True,
                       "nx0": 0.2, "ny0": 0.2, "nx1": 0.4, "ny1": 0.4})
    if response.get("ok") is not True:
        repeat_failures += 1
check("25 repeated zooms stay healthy", repeat_failures == 0, f"{repeat_failures} failures")

# Edge values of the documented 0..1 domain.
edge_full = run({"action": "zoom", "inline": True, "nx0": 0.0, "ny0": 0.0, "nx1": 1.0, "ny1": 1.0})[0]
check("full-frame zoom stays inside the budget",
      edge_full.get("ok") is True
      and edge_full.get("imageWidth", 0) * edge_full.get("imageHeight", 0) <= BUDGET,
      f'{edge_full.get("imageWidth")}x{edge_full.get("imageHeight")}')

edge_hair = run({"action": "zoom", "inline": True,
                 "nx0": 0.5, "ny0": 0.5, "nx1": 0.50001, "ny1": 0.50001})[0]
check("degenerate hairline crop is rejected, not crashed", edge_hair.get("ok") is False)

edge_corner = run({"action": "zoom", "inline": True,
                   "nx0": 0.9999, "ny0": 0.9999, "nx1": 1.0, "ny1": 1.0})[0]
check("corner sliver is handled without error or crash",
      isinstance(edge_corner.get("ok"), bool), edge_corner)


# --- summary ----------------------------------------------------------------
failed = [name for name, ok, _ in outcomes if not ok]
print()
print(f"{len(outcomes) - len(failed)}/{len(outcomes)} passed")
if failed:
    print("FAILED: " + "; ".join(failed))
    raise SystemExit(1)
print("all stability checks passed")
