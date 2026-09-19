#!/usr/bin/env python3
"""dsh-screen-agent host sidecar.

One JSON request on stdin, one JSON response on stdout. Eight actions:

  capture  full virtual desktop -> PNG (all monitors, per-monitor DPI aware)
  zoom     crop a normalized sub-rectangle of the desktop at native resolution
  windows  list visible top-level windows (z-order, title, size, state)
  window   focus one window, optionally click/type inside it, then capture it
  move     place the cursor, pressing nothing
  click    press a button, optionally moving the cursor there first
  key      send key combinations (Esc/Tab/arrows/F-keys/modifier combos)
  type     send key combinations and/or Unicode text

Moving and clicking are separate actions by design: a click that moves the
cursor itself can change what is under it (popup menus reposition), so a
position measured a moment earlier stops holding. `move` first, let it settle,
then `click` in place (`move: false`, or omit coordinates) with no hidden
movement. Where a shortcut exists, prefer `key` over pointing at all.

Screen capture uses Pillow (already present in this environment). Input
synthesis uses ctypes -> user32!SendInput, so there is no pyautogui dependency.

Window capture uses PrintWindow with PW_RENDERFULLCONTENT, which reads the
window's own surface and therefore still works while the window is occluded (a
screen grab cannot do that). When PrintWindow refuses or returns a blank
surface, the sidecar falls back to foregrounding the window and reading its
rectangle off the composited desktop.

Coordinate contract: callers work in *normalized* coordinates, nx/ny in 0..1,
measured as a fraction of the frame. Pixels are never exchanged, because the
image is resized for transport (and again by the provider's visual budget), so
any pixel the model reads off its own view is wrong by the resize ratio. A
fraction survives every resize.

Image payloads travel back as base64 inside the JSON response (`inline`): no
temp file, so concurrent calls cannot race on a shared path and nothing is left
on disk.

The default pixel budget mirrors the provider's own visual budget: DeepSeek
resizes every image to roughly an 800x800 equivalent (640,000 px, 384 tokens).
Downscaling to that here means the model sees exactly the image measured, and
a crop at or below the budget arrives losslessly.
"""

import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes

# --------------------------------------------------------------------------
# Budgets
# --------------------------------------------------------------------------

# ~800x800: the provider's own per-image visual budget. Staying at or below it
# is what makes a crop lossless.
DEFAULT_MAX_PIXELS = 640000

# A crop smaller than this is upscaled into a blur; refuse instead.
MIN_REGION_PX = 8


def resample_filter():
    from PIL import Image

    resampling = getattr(Image, "Resampling", None)
    return getattr(resampling, "LANCZOS", None) or getattr(Image, "LANCZOS", None) or Image.BILINEAR


def fit_within(image, req):
    """Downscale to the pixel budget. Returns (image, scale); scale 1.0 means untouched."""
    max_pixels = req.get("maxPixels")
    max_pixels = DEFAULT_MAX_PIXELS if max_pixels is None else int(max_pixels)
    width, height = image.size
    if max_pixels <= 0 or width * height <= max_pixels:
        return image, 1.0
    scale = (max_pixels / float(width * height)) ** 0.5
    # Truncate, do not round: rounding both sides up can push the product back
    # over the budget (measured: 1386x797 -> 1055x607 = 640,385 > 640,000).
    resized = image.resize(
        (max(1, int(width * scale)), max(1, int(height * scale))),
        resample_filter(),
    )
    return resized, scale


def emit_image(image, req, result):
    """Attach the PNG to `result` inline (base64) or on disk when asked."""
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")

    if req.get("inline"):
        import base64
        import io

        buffer = io.BytesIO()
        image.save(buffer, "PNG")
        payload = buffer.getvalue()
        result["bytes"] = len(payload)
        result["pngBase64"] = base64.b64encode(payload).decode("ascii")
        return result

    out = req.get("out")
    if not out:
        raise ValueError("out is required when inline is not set")
    image.save(out, "PNG")
    result["out"] = out
    result["bytes"] = None
    return result


# --------------------------------------------------------------------------
# DPI awareness: without this, capture and the cursor disagree under scaling.
# Must run before any window/GDI call in this process.
# --------------------------------------------------------------------------


DPI_AWARENESS = "unset"


def make_dpi_aware() -> str:
    """Set process DPI awareness. Must run before the first GDI/window call."""
    global DPI_AWARENESS
    try:
        # PROCESS_PER_MONITOR_DPI_AWARE
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        DPI_AWARENESS = "per-monitor"
        return DPI_AWARENESS
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
        DPI_AWARENESS = "system"
    except Exception:
        DPI_AWARENESS = "none"
    return DPI_AWARENESS


SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79


def virtual_desktop():
    gsm = ctypes.windll.user32.GetSystemMetrics
    return gsm(SM_XVIRTUALSCREEN), gsm(SM_YVIRTUALSCREEN), gsm(SM_CXVIRTUALSCREEN), gsm(SM_CYVIRTUALSCREEN)


# --------------------------------------------------------------------------
# Input synthesis (SendInput)
# --------------------------------------------------------------------------

ULONG_PTR = ctypes.c_uint64 if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_uint32

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

# Keys Windows treats as "extended": without the flag they arrive as their
# numpad twins (arrows become numpad digits, and so on).
EXTENDED_VKS = {
    0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,  # page up/down, end, home, arrows
    0x2D, 0x2E,                                       # insert, delete
    0x5B, 0x5C,                                       # left/right windows
    0x6F, 0x90,                                       # numpad divide, num lock
    0xA3, 0xA5,                                       # right ctrl, right alt
}

VK_RETURN = 0x0D
VK_MENU = 0x12
VK_SHIFT = 0x10

BUTTONS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


def _send(inp: INPUT) -> None:
    sent = ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
    if sent != 1:
        raise OSError("SendInput rejected the event (is the session unlocked and interactive?)")


def _mouse(flags: int) -> None:
    _send(INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(0, 0, 0, flags, 0, 0)))


def _key_vk(vk: int, up: bool) -> None:
    """Send one virtual-key press or release, supplying the scan code as well.

    An event that carries only a virtual key is ignored by applications that
    read the scan code, so both are always provided. Blender's input layer is
    one of those: a VK-only F3 did nothing at all.
    """
    scan = ctypes.windll.user32.MapVirtualKeyW(vk, 0)  # MAPVK_VK_TO_VSC
    flags = KEYEVENTF_KEYUP if up else 0
    if vk in EXTENDED_VKS:
        flags |= KEYEVENTF_EXTENDEDKEY
    _send(INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(vk, scan, flags, 0, 0)))


def _key_unicode(unit: int) -> None:
    _send(INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, unit, KEYEVENTF_UNICODE, 0, 0)))
    _send(INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)))


# --- named keys and combos --------------------------------------------------
# Unicode keystrokes cannot express Escape, Tab, arrows, function keys, or any
# modifier combination. Those need real virtual-key codes.

MODIFIER_VKS = {
    "ctrl": 0x11, "control": 0x11,
    "shift": 0x10,
    "alt": 0x12,
    "win": 0x5B, "super": 0x5B, "cmd": 0x5B,
}

NAMED_VKS = {
    "esc": 0x1B, "escape": 0x1B,
    "tab": 0x09,
    "enter": VK_RETURN, "return": VK_RETURN,
    "space": 0x20, "spacebar": 0x20,
    "backspace": 0x08, "back": 0x08,
    "delete": 0x2E, "del": 0x2E,
    "insert": 0x2D, "ins": 0x2D,
    "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pgup": 0x21,
    "pagedown": 0x22, "pgdn": 0x22,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "capslock": 0x14,
    "printscreen": 0x2C,
    "pause": 0x13,
    "numlock": 0x90,
    "num0": 0x60, "num1": 0x61, "num2": 0x62, "num3": 0x63, "num4": 0x64,
    "num5": 0x65, "num6": 0x66, "num7": 0x67, "num8": 0x68, "num9": 0x69,
    "num*": 0x6A, "num+": 0x6B, "num-": 0x6D, "num.": 0x6E, "num/": 0x6F,
}

OEM_VKS = {
    ";": 0xBA, "=": 0xBB, ",": 0xBC, "-": 0xBD, ".": 0xBE, "/": 0xBF,
    "`": 0xC0, "[": 0xDB, "\\": 0xDC, "]": 0xDD, "'": 0xDE,
}


def resolve_vk(name: str) -> int:
    """Map one key name to its virtual-key code."""
    key = name.strip().lower()
    if key in MODIFIER_VKS:
        return MODIFIER_VKS[key]
    if key in NAMED_VKS:
        return NAMED_VKS[key]
    if len(key) == 1 and key.isalpha():
        return ord(key.upper())
    if len(key) == 1 and key.isdigit():
        return ord(key)
    if key in OEM_VKS:
        return OEM_VKS[key]
    if len(key) > 1 and key[0] == "f" and key[1:].isdigit():
        number = int(key[1:])
        if 1 <= number <= 24:
            return 0x70 + number - 1
    raise ValueError(
        f"unknown key {name!r}; use a letter, digit, F1-F24, or one of: "
        + ", ".join(sorted(set(NAMED_VKS) | set(MODIFIER_VKS) | set(OEM_VKS))),
    )


def parse_combo(combo: str):
    """Split 'ctrl+shift+a' into ([modifier vks], key vk). Pure; sends nothing."""
    parts = [part.strip().lower() for part in str(combo).split("+") if part.strip()]
    if not parts:
        raise ValueError("empty key combo")
    *modifiers, key = parts
    for modifier in modifiers:
        if modifier not in MODIFIER_VKS:
            raise ValueError(
                f"{modifier!r} is not a modifier; only ctrl, shift, alt, and win "
                "may prefix a combination",
            )
    if len(set(modifiers)) != len(modifiers):
        raise ValueError(f"{combo!r} repeats a modifier")
    if key in MODIFIER_VKS:
        raise ValueError(f"{combo!r} ends with a modifier; add the key it should modify")
    return [MODIFIER_VKS[modifier] for modifier in modifiers], resolve_vk(key)


# Injecting down/up back to back is too fast: the target processes the messages
# after the modifier has already been released, so Ctrl+A arrives as a bare 'a',
# and a very short keypress can be dropped entirely. Both need a little dwell.
MODIFIER_SETTLE_SECONDS = 0.03
KEY_HOLD_SECONDS = 0.02


def tap_key(vk: int, modifiers=()) -> None:
    """Press modifiers, hold the key briefly, release in reverse order."""
    for modifier in modifiers:
        _key_vk(modifier, False)
    if modifiers:
        time.sleep(MODIFIER_SETTLE_SECONDS)
    try:
        _key_vk(vk, False)
        time.sleep(KEY_HOLD_SECONDS)
        _key_vk(vk, True)
    finally:
        # Release modifiers in reverse so a stuck modifier cannot outlive the call.
        for modifier in reversed(modifiers):
            _key_vk(modifier, True)


def press_parsed(modifiers, key) -> None:
    """Press and release one already-parsed combination."""
    tap_key(key, modifiers)


def press_combo(combo: str) -> None:
    """Press and release one key combination (modifiers held for the keypress)."""
    press_parsed(*parse_combo(combo))


def char_to_key(char: str):
    """Map one printable character to (virtual key, needs shift), or None.

    Typing through the real key layout (rather than injecting Unicode) is what
    applications that read scan codes actually accept. Blender ignores
    KEYEVENTF_UNICODE outright, so 'cylinder' typed as Unicode did nothing.
    """
    code = ord(char)
    if code > 0xFFFF:
        return None
    result = ctypes.windll.user32.VkKeyScanW(code)
    if result == -1:
        return None
    virtual_key = result & 0xFF
    shift_state = (result >> 8) & 0xFF
    return virtual_key, bool(shift_state & 1)


# --------------------------------------------------------------------------
# Windows: enumeration, foregrounding, occlusion-proof capture
# --------------------------------------------------------------------------

GWL_EXSTYLE = -20
GW_OWNER = 4
WS_EX_TOOLWINDOW = 0x00000080
SW_RESTORE = 9
DWMWA_EXTENDED_FRAME_BOUNDS = 9
PW_RENDERFULLCONTENT = 2

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def window_title(hwnd) -> str:
    user32 = ctypes.windll.user32
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def window_class(hwnd) -> str:
    buffer = ctypes.create_unicode_buffer(256)
    ctypes.windll.user32.GetClassNameW(hwnd, buffer, 256)
    return buffer.value


def window_rect(hwnd):
    """GetWindowRect — the frame PrintWindow actually renders.

    DWM's extended frame bounds are tighter (they drop the invisible resize
    border), but PrintWindow draws from GetWindowRect. Mixing the two offsets
    every click by the difference: aiming at one menu row consistently landed
    on the row below it. Screenshot pixels and click coordinates must share one
    origin, so both use GetWindowRect.
    """
    rect = RECT()
    if not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    if rect.right <= rect.left or rect.bottom <= rect.top:
        return None
    return rect


def enumerate_windows():
    """Visible, titled, unowned top-level windows, topmost first (z-order)."""
    user32 = ctypes.windll.user32
    found = []

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        if user32.GetWindowTextLengthW(hwnd) == 0:
            return True
        if user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        if user32.GetWindow(hwnd, GW_OWNER) != 0:
            return True
        rect = window_rect(hwnd)
        if rect is None:
            return True
        found.append({
            "hwnd": hwnd,
            "title": window_title(hwnd),
            "class": window_class(hwnd),
            "left": rect.left,
            "top": rect.top,
            "width": rect.right - rect.left,
            "height": rect.bottom - rect.top,
            "minimized": bool(user32.IsIconic(hwnd)),
            "foreground": user32.GetForegroundWindow() == hwnd,
        })
        return True

    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return found


def wait_for_foreground(hwnd, timeout=0.3):
    """Poll until `hwnd` owns the foreground.

    SetForegroundWindow is not synchronous: the window manager applies it a few
    milliseconds later, so checking GetForegroundWindow immediately reports a
    false failure for a switch that actually succeeded.
    """
    user32 = ctypes.windll.user32
    deadline = time.time() + timeout
    while True:
        if user32.GetForegroundWindow() == hwnd:
            return True
        if time.time() >= deadline:
            return False
        time.sleep(0.03)


def focus_window(hwnd) -> bool:
    """Bring a window to the foreground, escalating through the documented locks."""
    user32 = ctypes.windll.user32
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(0.12)
    if wait_for_foreground(hwnd, 0.2):
        return True

    # Attempt 1: plain request. Succeeds when this process is already trusted.
    user32.SetForegroundWindow(hwnd)
    if wait_for_foreground(hwnd, 0.25):
        return True

    # Attempt 2: the foreground lock grants the right to a process that owns the
    # last input event. A synthetic ALT press makes that true for us.
    _key_vk(VK_MENU, False)
    _key_vk(VK_MENU, True)
    user32.SetForegroundWindow(hwnd)
    if wait_for_foreground(hwnd, 0.25):
        return True

    # Attempt 3: share the foreground thread's input queue for the call.
    foreground = user32.GetForegroundWindow()
    target_thread = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
    this_thread = ctypes.windll.kernel32.GetCurrentThreadId()
    if target_thread and target_thread != this_thread:
        user32.AttachThreadInput(this_thread, target_thread, True)
        try:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            user32.AttachThreadInput(this_thread, target_thread, False)
    if wait_for_foreground(hwnd, 0.3):
        return True

    # Attempt 4: long-standing shell helper that bypasses the lock.
    try:
        user32.SwitchToThisWindow(hwnd, True)
    except Exception:
        pass
    return wait_for_foreground(hwnd, 0.3)


def hbitmap_to_image(mem_dc, bitmap, width, height):
    from PIL import Image

    info = BITMAPINFO()
    info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    info.bmiHeader.biWidth = width
    info.bmiHeader.biHeight = -height  # negative: top-down scanlines
    info.bmiHeader.biPlanes = 1
    info.bmiHeader.biBitCount = 32
    info.bmiHeader.biCompression = 0  # BI_RGB
    buffer = ctypes.create_string_buffer(width * height * 4)
    if ctypes.windll.gdi32.GetDIBits(mem_dc, bitmap, 0, height, buffer, ctypes.byref(info), 0) == 0:
        raise OSError("GetDIBits returned no scanlines")
    return Image.frombuffer("RGB", (width, height), buffer, "raw", "BGRX", 0, 1).copy()


def print_window_image(hwnd, width, height):
    """Read a window's own surface. Works while the window is covered."""
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    window_dc = user32.GetWindowDC(hwnd)
    if not window_dc:
        raise OSError("GetWindowDC failed")
    mem_dc = gdi32.CreateCompatibleDC(window_dc)
    bitmap = gdi32.CreateCompatibleBitmap(window_dc, width, height)
    if not mem_dc or not bitmap:
        if bitmap:
            gdi32.DeleteObject(bitmap)
        if mem_dc:
            gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(hwnd, window_dc)
        raise OSError("could not allocate a capture surface")
    previous = gdi32.SelectObject(mem_dc, bitmap)
    try:
        if not user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT):
            raise OSError("PrintWindow refused the request")
        return hbitmap_to_image(mem_dc, bitmap, width, height)
    finally:
        # GDI objects are process-wide and finite: always release them.
        gdi32.SelectObject(mem_dc, previous)
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(hwnd, window_dc)


def is_blank(image) -> bool:
    low, high = image.convert("L").getextrema()
    return low == high


def grab_from_screen(rect):
    """Read a rectangle off the composited desktop (requires it to be visible)."""
    from PIL import ImageGrab

    screen = ImageGrab.grab(all_screens=True)
    ox, oy = virtual_desktop()[0:2]
    return screen.crop((rect.left - ox, rect.top - oy, rect.right - ox, rect.bottom - oy))


def capture_window(hwnd):
    """Return (image, method). Prefers the occluded-safe path."""
    rect = window_rect(hwnd)
    if rect is None:
        raise ValueError("the window has no usable rectangle (it may have just closed)")
    width, height = rect.right - rect.left, rect.bottom - rect.top

    problems = []
    try:
        image = print_window_image(hwnd, width, height)
        if not is_blank(image):
            return image, "printwindow"
        problems.append("PrintWindow returned a blank surface")
    except Exception as exc:
        problems.append(f"PrintWindow failed ({exc})")

    focus_window(hwnd)
    time.sleep(0.15)
    current = window_rect(hwnd) or rect
    image = grab_from_screen(current)
    if is_blank(image):
        raise OSError(
            "; ".join(problems) + "; the screen fallback was blank as well (is the session locked?)",
        )
    return image, "screen-fallback"


# --------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------


def do_capture(req):
    from PIL import ImageGrab

    image = ImageGrab.grab(all_screens=True)
    source_w, source_h = image.size
    image, scale = fit_within(image, req)

    ox, oy, vw, vh = virtual_desktop()
    result = {
        "ok": True,
        "originX": ox,
        "originY": oy,
        "desktopWidth": vw,
        "desktopHeight": vh,
        "sourceWidth": source_w,
        "sourceHeight": source_h,
        "imageWidth": image.size[0],
        "imageHeight": image.size[1],
        "scale": scale,
        "lossless": scale == 1.0,
        "dpiAwareness": DPI_AWARENESS,
    }
    return emit_image(image, req, result)


def do_zoom(req):
    """Crop a normalized rectangle out of a *full-resolution* desktop grab.

    The crop is taken from the native grab, never from a downscaled frame, so
    the detail the provider discards on a full screenshot is still present here.
    A crop at or below the pixel budget (640,000 px, the provider's own visual
    budget) arrives losslessly.
    """
    from PIL import ImageGrab

    keys = ("nx0", "ny0", "nx1", "ny1")
    missing = [key for key in keys if req.get(key) is None]
    if missing:
        raise ValueError(f"zoom requires {', '.join(keys)}; missing {', '.join(missing)}")

    nx0, ny0, nx1, ny1 = (float(req[key]) for key in keys)
    for key, value in zip(keys, (nx0, ny0, nx1, ny1)):
        if not 0.0 <= value <= 1.0:
            raise ValueError(f"{key} must be between 0 and 1 (got {value})")
    if not nx1 > nx0 or not ny1 > ny0:
        raise ValueError("the rectangle is empty: nx1 must exceed nx0 and ny1 must exceed ny0")

    image = ImageGrab.grab(all_screens=True)
    full_w, full_h = image.size

    left = int(round(nx0 * full_w))
    top = int(round(ny0 * full_h))
    right = min(full_w, max(left + 1, int(round(nx1 * full_w))))
    bottom = min(full_h, max(top + 1, int(round(ny1 * full_h))))
    left = max(0, min(left, right - 1))
    top = max(0, min(top, bottom - 1))

    region = image.crop((left, top, right, bottom))
    if region.size[0] < MIN_REGION_PX or region.size[1] < MIN_REGION_PX:
        raise ValueError(
            f"the requested rectangle is only {region.size[0]}x{region.size[1]} px; "
            f"ask for at least {MIN_REGION_PX}x{MIN_REGION_PX}",
        )

    cropped_w, cropped_h = region.size
    region, scale = fit_within(region, req)

    # Report the virtual desktop's own metrics, not the bitmap's, so the zoom
    # note and the click mapping always describe the same coordinate space.
    ox, oy, vw, vh = virtual_desktop()
    result = {
        "ok": True,
        "originX": ox,
        "originY": oy,
        "desktopWidth": vw,
        "desktopHeight": vh,
        "sourceWidth": full_w,
        "sourceHeight": full_h,
        "cropLeft": left,
        "cropTop": top,
        "cropWidth": cropped_w,
        "cropHeight": cropped_h,
        "imageWidth": region.size[0],
        "imageHeight": region.size[1],
        "scale": scale,
        "lossless": scale == 1.0,
        "nx0": nx0,
        "ny0": ny0,
        "nx1": nx1,
        "ny1": ny1,
        "dpiAwareness": DPI_AWARENESS,
    }
    return emit_image(region, req, result)


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


def cursor_position():
    point = POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(point))
    return point.x, point.y


def _to_desktop(req):
    """Map a normalized frame position (0..1) to a desktop pixel."""
    ox, oy, vw, vh = virtual_desktop()
    try:
        nx = float(req["nx"])
        ny = float(req["ny"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("nx and ny are required and must be numbers") from exc
    if not (0.0 <= nx <= 1.0 and 0.0 <= ny <= 1.0):
        raise ValueError("nx and ny must be between 0 and 1")
    x = ox + int(round(nx * max(0, vw - 1)))
    y = oy + int(round(ny * max(0, vh - 1)))
    return x, y


# --------------------------------------------------------------------------
# Protected windows
# --------------------------------------------------------------------------
# This agent is driven from a browser tab. Clicking into its own conversation
# window is self-destructive, and it has actually happened during development.
# Any window whose title carries one of these markers refuses to be targeted.
# Override with DSH_SCREEN_AGENT_PROTECT="marker one,marker two" (empty disables).

PROTECTED_TITLE_MARKERS = [
    marker.strip().lower()
    for marker in (os.environ.get("DSH_SCREEN_AGENT_PROTECT") or "DeepSeek Harness").split(",")
    if marker.strip()
]


def is_protected_title(title) -> bool:
    lowered = str(title or "").lower()
    return any(marker in lowered for marker in PROTECTED_TITLE_MARKERS)


def assert_not_protected(window) -> None:
    """Refuse to act on the agent's own window."""
    title = window.get("title", "") if isinstance(window, dict) else str(window)
    if is_protected_title(title):
        raise ValueError(
            f"refusing to act on {title!r}: it matches a protected marker "
            f"({', '.join(PROTECTED_TITLE_MARKERS)}). "
            "Set DSH_SCREEN_AGENT_PROTECT to change which windows are protected.",
        )


def top_level_window_at(x: int, y: int):
    """Handle of the top-level window under one screen pixel, or None."""
    try:
        user32 = ctypes.windll.user32
        point = POINT(int(x), int(y))
        hwnd = user32.WindowFromPoint(point)
        if not hwnd:
            return None
        # GA_ROOT = 2: walk up from the child control to its top-level window.
        root = user32.GetAncestor(hwnd, 2)
        return root or hwnd
    except Exception:
        return None


def assert_point_not_protected(x: int, y: int) -> None:
    """Refuse to click a point that falls inside the agent's own window."""
    hwnd = top_level_window_at(x, y)
    if hwnd is None:
        return
    title = window_title(hwnd)
    if is_protected_title(title):
        raise ValueError(
            f"refusing to click at ({x},{y}): that point is inside a protected window ({title!r})",
        )


# --------------------------------------------------------------------------
# UI Automation elements
# --------------------------------------------------------------------------
# Screenshot targeting is fragile: resolution, DPI scaling and layout all move
# the pixels. Where an app exposes a real accessibility tree, the OS will name
# its controls outright — so we hand back their rectangles and let the caller
# click by element instead of by eyeballed coordinates.
#
# Measured coverage on this machine: Edge exposed 49 elements in 33 ms; Blender,
# Alas and several others exposed nothing at all. This complements screenshots,
# it does not replace them.

UIA_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uia_elements.ps1")

_POWERSHELL = None


def powershell_exe():
    """First working PowerShell on PATH (pwsh is absent on this machine)."""
    global _POWERSHELL
    if _POWERSHELL is None:
        found = None
        for candidate in ("powershell", "pwsh"):
            try:
                probe = subprocess.run(
                    [candidate, "-NoProfile", "-Command", "exit 0"],
                    capture_output=True, timeout=20,
                )
                if probe.returncode == 0:
                    found = candidate
                    break
            except Exception:
                continue
        _POWERSHELL = found or ""
    return _POWERSHELL or None


def do_elements(req):
    """Enumerate one window's UI Automation tree as clickable elements."""
    window = resolve_window(req.get("window"))
    assert_not_protected(window)
    hwnd = int(window["hwnd"])

    try:
        limit = max(1, min(1000, int(req.get("limit") or 200)))
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer") from exc

    shell = powershell_exe()
    if shell is None:
        raise OSError("neither powershell nor pwsh is available on PATH")
    if not os.path.exists(UIA_SCRIPT):
        raise OSError(f"missing helper script: {UIA_SCRIPT}")

    command = [
        shell, "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", UIA_SCRIPT,
        "-Hwnd", str(hwnd),
        "-Limit", str(limit),
    ]
    filter_text = req.get("filter")
    if filter_text:
        command += ["-Filter", str(filter_text)]

    try:
        finished = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=90,
        )
    except subprocess.TimeoutExpired as exc:
        raise OSError("UI Automation enumeration timed out after 90s") from exc

    ox, oy, desktop_w, desktop_h = virtual_desktop()
    elements = []
    problems = []
    for raw in (finished.stdout or "").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        if raw.startswith("ERROR|"):
            problems.append(raw[6:])
            continue
        parts = raw.split("|")
        if len(parts) != 6:
            continue
        role, name, left, top, width, height = parts
        try:
            left, top, width, height = int(left), int(top), int(width), int(height)
        except ValueError:
            continue
        centre_x, centre_y = left + width // 2, top + height // 2
        elements.append({
            "role": role,
            "name": name,
            "left": left,
            "top": top,
            "width": width,
            "height": height,
            # Centre as a normalized screen position, directly usable by click.
            "nx": round((centre_x - ox) / max(1, desktop_w - 1), 5),
            "ny": round((centre_y - oy) / max(1, desktop_h - 1), 5),
        })

    if not elements and problems:
        raise OSError(problems[0])

    return {
        "ok": True,
        "window": window["title"],
        "count": len(elements),
        "elements": elements,
    }


# --------------------------------------------------------------------------
# Waiting for the screen
# --------------------------------------------------------------------------

def _screen_fingerprint():
    """Cheap 64x40 greyscale digest of the whole desktop."""
    from PIL import ImageGrab

    image = ImageGrab.grab(all_screens=True).convert("L").resize((64, 40))
    return image.tobytes()


# A pixel must move by more than this to count as a change (0-255 greyscale).
NOISE_FLOOR = 12
# Fraction of sampled cells that must move for the screen to count as changed.
CHANGE_THRESHOLD = 0.02


def _fingerprint_delta(before, after) -> float:
    """Fraction of sampled cells that changed beyond the noise floor.

    Exact equality is useless on a real desktop: a music widget, a clock or a
    blinking caret keeps pixels moving forever, so "stable" would never be
    reached (measured: 18 polls, still changing). Comparing the *proportion* of
    changed cells tolerates that ambient motion while still catching a window
    opening or a page loading.
    """
    if len(before) != len(after):
        return 1.0
    changed = 0
    for old, new in zip(before, after):
        if abs(old - new) > NOISE_FLOOR:
            changed += 1
    return changed / max(1, len(before))


def do_wait(req):
    """Wait until the screen changes, or until it stops changing.

    Fixed sleeps are a guess; this is a measurement. Polling a small greyscale
    digest is enough to tell "still loading" from "settled" without paying for
    a full screenshot every time.
    """
    mode = str(req.get("for") or "change").lower()
    if mode not in ("change", "stable"):
        raise ValueError("for must be 'change' or 'stable'")
    try:
        timeout_ms = max(0, min(120000, int(req.get("timeoutMs") or 10000)))
    except (TypeError, ValueError) as exc:
        raise ValueError("timeoutMs must be an integer") from exc
    try:
        interval_ms = max(20, min(5000, int(req.get("intervalMs") or 250)))
    except (TypeError, ValueError) as exc:
        raise ValueError("intervalMs must be an integer") from exc

    started = time.time()
    baseline = _screen_fingerprint()
    previous = baseline
    stable_polls = 0
    polls = 0

    while (time.time() - started) * 1000.0 < timeout_ms:
        time.sleep(interval_ms / 1000.0)
        polls += 1
        current = _screen_fingerprint()

        if mode == "change":
            if _fingerprint_delta(baseline, current) >= CHANGE_THRESHOLD:
                return {
                    "ok": True,
                    "settled": True,
                    "mode": mode,
                    "changeRatio": round(_fingerprint_delta(baseline, current), 4),
                    "polls": polls,
                    "elapsedMs": int((time.time() - started) * 1000),
                }
        else:
            if _fingerprint_delta(previous, current) <= CHANGE_THRESHOLD:
                stable_polls += 1
                if stable_polls >= 2:
                    return {
                        "ok": True,
                        "settled": True,
                        "mode": mode,
                        "changeRatio": round(_fingerprint_delta(previous, current), 4),
                        "polls": polls,
                        "elapsedMs": int((time.time() - started) * 1000),
                    }
            else:
                stable_polls = 0
        previous = current

    return {
        "ok": True,
        "settled": False,
        "mode": mode,
        "polls": polls,
        "elapsedMs": int((time.time() - started) * 1000),
    }


def do_move(req):
    """Place the cursor without pressing any button.

    Split from clicking on purpose. A click that moves the cursor itself makes
    "measure, then click" unreliable: the move can change what is under the
    cursor (popup menus reposition, hover states shift), so a position measured
    a moment earlier no longer holds. Moving first, letting it settle, then
    pressing in place removes that window entirely.
    """
    x, y = _to_desktop(req)
    if not ctypes.windll.user32.SetCursorPos(x, y):
        raise OSError("SetCursorPos rejected the coordinates")
    time.sleep(0.02)
    cursor_x, cursor_y = cursor_position()
    result = {
        "ok": True,
        "desktopX": x,
        "desktopY": y,
        "cursorX": cursor_x,
        "cursorY": cursor_y,
    }
    if (cursor_x, cursor_y) != (x, y):
        result["warning"] = "the cursor settled away from the requested point (clamped at a display edge?)"
    return result


def do_key(req):
    """Send key combinations only, no text. The key half of do_type, standalone."""
    return do_type({"keys": req.get("keys")})


def do_click(req):
    """Click, optionally moving the cursor there first.

    Movement and the button press are deliberately separate steps. With
    `move: false`, or with no coordinates at all, the press happens wherever the
    cursor already is — which is what makes a measured click safe: place the
    cursor with screen_move, let it rest, confirm, then press in place with zero
    hidden movement in between.
    """
    has_nx = req.get("nx") is not None
    has_ny = req.get("ny") is not None
    if has_nx != has_ny:
        # Half a coordinate is a caller mistake, and silently treating it as
        # "press where the cursor happens to be" would fire a click somewhere
        # nobody asked for.
        raise ValueError(
            "give nx and ny together, or omit both to press where the cursor already is",
        )
    has_position = has_nx and has_ny
    should_move = has_position and req.get("move", True) is not False

    if has_position:
        x, y = _to_desktop(req)
    else:
        x, y = cursor_position()

    # Never press into the window this agent is being driven from.
    assert_point_not_protected(x, y)

    button = str(req.get("button") or "left").lower()
    try:
        clicks = max(1, min(10, int(req.get("clicks") or 1)))
    except (TypeError, ValueError) as exc:
        raise ValueError("clicks must be an integer") from exc
    try:
        hold_ms = max(0, min(5000, int(req.get("holdMs") or 0)))
    except (TypeError, ValueError) as exc:
        raise ValueError("holdMs must be an integer") from exc
    if button not in BUTTONS:
        raise ValueError("button must be one of: left, right, middle")
    down, up = BUTTONS[button]

    if should_move:
        if not ctypes.windll.user32.SetCursorPos(x, y):
            raise OSError("SetCursorPos rejected the coordinates")
        time.sleep(0.03)

    # Read the cursor back: end-to-end proof that the normalized mapping and the
    # desktop's DPI scaling agree, and — when not moving — proof of exactly
    # where the press is about to land.
    cursor_x, cursor_y = cursor_position()

    for _ in range(clicks):
        _mouse(down)
        if hold_ms:
            time.sleep(hold_ms / 1000.0)
        _mouse(up)
        time.sleep(0.02)

    result = {
        "ok": True,
        "desktopX": x,
        "desktopY": y,
        "cursorX": cursor_x,
        "cursorY": cursor_y,
        "button": button,
        "clicks": clicks,
        "movedCursor": should_move,
        "inPlace": not has_position,
    }
    if has_position and (cursor_x, cursor_y) != (x, y):
        result["warning"] = "the cursor settled away from the requested point (clamped at a display edge?)"
    return result


def do_type(req):
    """Send key combinations and/or Unicode text to the focused window."""
    text = req.get("text")
    keys = req.get("keys")

    if text is not None and not isinstance(text, str):
        raise ValueError("text must be a string")
    if text is not None and len(text) > 20000:
        raise ValueError("text is limited to 20000 characters per call")
    if keys is not None:
        if not isinstance(keys, list) or not all(isinstance(combo, str) for combo in keys):
            raise ValueError('keys must be an array of strings, e.g. ["ctrl+z", "esc"]')
        if len(keys) > 32:
            raise ValueError("at most 32 key combinations per call")
    if not text and not keys:
        raise ValueError("provide text and/or keys")

    enter = bool(req.get("enter"))
    try:
        delay_ms = max(0, min(1000, int(req.get("delayMs") or 0)))
    except (TypeError, ValueError) as exc:
        raise ValueError("delayMs must be an integer") from exc

    # Parse every combination up front: one bad name must abort the whole call
    # before any key reaches the window.
    parsed_keys = [parse_combo(combo) for combo in (keys or [])]

    for modifiers, key in parsed_keys:
        press_parsed(modifiers, key)
        if delay_ms:
            time.sleep(delay_ms / 1000.0)

    count = 0
    unicode_fallbacks = 0
    for char in text or "":
        if char == "\n":
            tap_key(VK_RETURN)
        else:
            mapped = char_to_key(char)
            if mapped is None:
                # No layout mapping (CJK, emoji): Unicode injection is the only
                # channel left. Applications that read scan codes ignore it
                # entirely, so it is counted and reported rather than assumed.
                encoded = char.encode("utf-16-le")
                for offset in range(0, len(encoded), 2):
                    _key_unicode(int.from_bytes(encoded[offset:offset + 2], "little"))
                unicode_fallbacks += 1
            else:
                vk, needs_shift = mapped
                tap_key(vk, (VK_SHIFT,) if needs_shift else ())
        count += 1
        if delay_ms:
            time.sleep(delay_ms / 1000.0)

    if enter:
        tap_key(VK_RETURN)

    return {
        "ok": True,
        "characters": count,
        "enter": enter,
        "keysPressed": len(parsed_keys),
        "unicodeFallbacks": unicode_fallbacks,
    }


def do_windows(req):
    """List visible top-level windows in z-order so callers can pick one."""
    windows = enumerate_windows()
    if not windows:
        return {"ok": True, "count": 0, "lines": ["(no visible top-level windows)"]}

    lines = []
    for index, window in enumerate(windows):
        flags = []
        if window["foreground"]:
            flags.append("FOREGROUND")
        if window["minimized"]:
            flags.append("minimized")
        suffix = f' [{" ".join(flags)}]' if flags else ""
        title = window["title"]
        if len(title) > 90:
            title = title[:87] + "..."
        lines.append(
            f'[{index}] "{title}" {window["width"]}x{window["height"]} '
            f'at ({window["left"]},{window["top"]}) class={window["class"]}{suffix}',
        )
    return {"ok": True, "count": len(windows), "lines": lines, "windows": windows}


def resolve_window(spec):
    """Resolve a window spec (z-order index, title substring, or hwnd) to one window."""
    if isinstance(spec, bool) or spec is None:
        raise ValueError("window is required: pass an index from screen_windows, a title substring, or an hwnd")

    windows = enumerate_windows()
    if isinstance(spec, int) or (isinstance(spec, str) and spec.strip().isdigit()):
        index = int(spec)
        if not 0 <= index < len(windows):
            upper = max(0, len(windows) - 1)
            raise ValueError(
                f"window index {index} is out of range; screen_windows currently lists "
                f"{len(windows)} window(s), so use 0..{upper} or a title substring",
            )
        return windows[index]

    text = str(spec).strip()
    if text.lower().startswith("0x"):
        try:
            handle = int(text, 16)
        except ValueError as exc:
            raise ValueError(f"{spec!r} is not a valid window handle") from exc
        for window in windows:
            if int(window["hwnd"]) == handle:
                return window
        raise ValueError(f"no visible window has handle {text} (it may have closed)")
    if not text:
        raise ValueError("window must not be empty: pass an index, a title substring, or an hwnd")

    needle = text.lower()
    matches = [window for window in windows if needle in window["title"].lower()]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        available = "; ".join(f'[{i}] {w["title"][:40]}' for i, w in enumerate(windows[:8]))
        raise ValueError(f'no visible window title contains {text!r}. Currently open: {available}')
    sample = "; ".join(f'[{i}] {w["title"][:40]}' for i, w in enumerate(matches[:6]))
    raise ValueError(f'{len(matches)} windows match {text!r} ({sample}); use a longer substring or an index')


def do_window(req):
    """Focus one window, optionally click and/or type inside it, then capture it."""
    user32 = ctypes.windll.user32
    previous_foreground = user32.GetForegroundWindow()
    window = resolve_window(req.get("window"))
    assert_not_protected(window)
    hwnd = window["hwnd"]

    result = {
        "ok": True,
        "hwnd": f"0x{int(hwnd):08X}",
        "title": window["title"],
    }

    want_focus = req.get("focus", True) is not False
    if want_focus:
        result["focused"] = focus_window(hwnd)
    else:
        result["focused"] = user32.GetForegroundWindow() == hwnd

    rect = window_rect(hwnd)
    if rect is None:
        raise ValueError("the window disappeared before the action could run")
    width, height = rect.right - rect.left, rect.bottom - rect.top
    result.update({"windowLeft": rect.left, "windowTop": rect.top,
                   "windowWidth": width, "windowHeight": height})

    has_click = req.get("nx") is not None and req.get("ny") is not None
    if has_click:
        # A click is aimed at screen coordinates; if the window never came
        # forward, those coordinates belong to whatever is on top of it.
        if not result["focused"]:
            raise ValueError(
                "refusing to click: the window could not be brought to the foreground, "
                "so the click would land on whichever window is on top of it",
            )
        try:
            nx, ny = float(req["nx"]), float(req["ny"])
        except (TypeError, ValueError) as exc:
            raise ValueError("nx and ny must be numbers") from exc
        if not (0.0 <= nx <= 1.0 and 0.0 <= ny <= 1.0):
            raise ValueError("nx and ny must be between 0 and 1")
        button = str(req.get("button") or "left").lower()
        if button not in BUTTONS:
            raise ValueError("button must be one of: left, right, middle")
        try:
            clicks = max(1, min(10, int(req.get("clicks") or 1)))
        except (TypeError, ValueError) as exc:
            raise ValueError("clicks must be an integer") from exc

        x = rect.left + int(round(nx * max(0, width - 1)))
        y = rect.top + int(round(ny * max(0, height - 1)))
        if not ctypes.windll.user32.SetCursorPos(x, y):
            raise OSError("SetCursorPos rejected the coordinates")
        time.sleep(0.03)
        down, up = BUTTONS[button]
        for _ in range(clicks):
            _mouse(down)
            _mouse(up)
            time.sleep(0.02)
        result["clickedAt"] = {
            "desktopX": x, "desktopY": y, "nx": nx, "ny": ny, "button": button, "clicks": clicks,
        }

    if req.get("text") is not None or req.get("keys") is not None:
        if not result["focused"]:
            raise ValueError(
                "refusing to type: the window could not be brought to the foreground, "
                "so the keystrokes would go to whichever window has focus",
            )
        result["typed"] = do_type({
            "text": req.get("text"),
            "keys": req.get("keys"),
            "enter": req.get("enter"),
            "delayMs": req.get("delayMs"),
        })

    if req.get("capture", True) is not False:
        image, method = capture_window(hwnd)
        # The screen fallback must raise the window. When the caller did not ask
        # for that, hand the foreground back so the desktop is left as found.
        if method == "screen-fallback" and not want_focus and previous_foreground:
            focus_window(previous_foreground)
        source_w, source_h = image.size
        image, scale = fit_within(image, req)
        result.update({
            "captureMethod": method,
            "sourceWidth": source_w,
            "sourceHeight": source_h,
            "imageWidth": image.size[0],
            "imageHeight": image.size[1],
            "scale": scale,
            "lossless": scale == 1.0,
            "dpiAwareness": DPI_AWARENESS,
        })
        return emit_image(image, req, result)

    return result


ACTIONS = {
    "capture": do_capture,
    "zoom": do_zoom,
    "windows": do_windows,
    "window": do_window,
    "elements": do_elements,
    "move": do_move,
    "click": do_click,
    "key": do_key,
    "type": do_type,
    "wait": do_wait,
}


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    # Before any GDI or window call: capture pixels and cursor coordinates must
    # agree under display scaling.
    make_dpi_aware()

    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
        if not isinstance(req, dict):
            raise ValueError("the request must be a JSON object")
        action = req.get("action")
        handler = ACTIONS.get(action)
        if handler is None:
            raise ValueError(f"unknown action: {action!r}; expected one of {sorted(ACTIONS)}")
        result = handler(req)
    except Exception as exc:  # noqa: BLE001 - every failure must return JSON
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 0

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
