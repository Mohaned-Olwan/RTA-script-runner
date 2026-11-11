"""
Teams group-chat sender for RTA Script Runner (Windows, new Teams).

Per send:
  1. wait until the user has been idle for N seconds (so we never steal keystrokes)
  2. check the dashboard pictures are fresh (manifest.json from the dashboard export folder)
  3. open the chat with its msteams: deep link
  4. verify the foreground window is Teams (and, optionally, that its title contains a hint)
  5. Alt+Shift+C (focus compose box) → Ctrl+A, Delete (clear any draft)
  6. paste view picture, paste flags picture, Enter
  7. give focus back to the window the user was in, restore their text clipboard
"""
from __future__ import annotations

import ctypes
import io
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

IS_WIN = sys.platform.startswith("win")


def slug(name: str) -> str:
    return re.sub(r"^_+|_+$", "", re.sub(r"[^A-Za-z0-9]+", "_", str(name)))


def to_msteams(link: str) -> str:
    """https://teams.cloud.microsoft/l/chat/...  →  msteams:/l/chat/...  (opens the desktop app)."""
    link = link.strip()
    if link.startswith("msteams:"):
        return link
    return re.sub(r"^https?://[^/]+/", "msteams:/", link)


def valid_chat_link(link: str) -> bool:
    return "/l/chat/" in (link or "")


# ----------------------------------------------------------------------------- picture checks
def load_manifest(out_dir: str) -> dict:
    try:
        return json.loads((Path(out_dir) / "manifest.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def pictures_for(out_dir: str, target: str, max_age_min: float, now: datetime | None = None):
    """Return (view_path, flags_path, None) or (None, None, reason)."""
    s = slug(target)
    view, flags = Path(out_dir) / f"{s}_view.png", Path(out_dir) / f"{s}_flags.png"
    if not view.exists() or not flags.exists():
        return None, None, f"no pictures for '{target}' in {out_dir} (is the dashboard exporting?)"
    now = now or datetime.now(timezone.utc)
    man = load_manifest(out_dir)
    t = next((x for x in man.get("targets", []) if x.get("slug") == s), None)
    if not t:
        return None, None, f"'{target}' not in manifest (no CMS data for it?)"
    try:
        exported = datetime.fromisoformat(t["exportedAt"].replace("Z", "+00:00"))
        cms = datetime.fromisoformat(t["cmsUpdated"].replace("Z", "+00:00"))
    except Exception:
        return None, None, "manifest unreadable"
    age_exp = (now - exported).total_seconds() / 60
    age_cms = (now - cms).total_seconds() / 60
    if age_exp > max_age_min:
        return None, None, f"pictures are {age_exp:.0f} min old (dashboard closed?)"
    if age_cms > max_age_min:
        return None, None, f"CMS data is {age_cms:.0f} min old (export script stopped?)"
    return str(view), str(flags), None


# ----------------------------------------------------------------------------- Windows plumbing
if IS_WIN:
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalSize.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalSize.restype = ctypes.c_size_t
    user32.GetClipboardData.restype = wintypes.HANDLE
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]

    CF_UNICODETEXT, CF_DIB, GMEM_MOVEABLE = 13, 8, 0x0002
    VK = {"ctrl": 0x11, "alt": 0x12, "shift": 0x10, "enter": 0x0D, "delete": 0x2E, "a": 0x41, "c": 0x43, "v": 0x56}
    KEYUP = 0x0002

    def idle_seconds() -> float:
        lii = LASTINPUTINFO(ctypes.sizeof(LASTINPUTINFO), 0)
        user32.GetLastInputInfo(ctypes.byref(lii))
        return (kernel32.GetTickCount() - lii.dwTime) / 1000.0

    def last_input_tick() -> int:
        lii = LASTINPUTINFO(ctypes.sizeof(LASTINPUTINFO), 0)
        user32.GetLastInputInfo(ctypes.byref(lii))
        return lii.dwTime

    def fg_window():
        return user32.GetForegroundWindow()

    def window_title(hwnd) -> str:
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buf, 512)
        return buf.value

    def window_exe(hwnd) -> str:
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        h = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            n = wintypes.DWORD(1024)
            kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n))
            return os.path.basename(buf.value).lower()
        finally:
            kernel32.CloseHandle(h)

    def is_teams(hwnd) -> bool:
        return window_exe(hwnd) in ("ms-teams.exe", "teams.exe", "msteams.exe")

    def press(*keys):
        codes = [VK[k] for k in keys]
        for c in codes:
            user32.keybd_event(c, 0, 0, 0)
            time.sleep(0.02)
        for c in reversed(codes):
            user32.keybd_event(c, 0, KEYUP, 0)
            time.sleep(0.02)

    def _open_clipboard():
        for _ in range(20):
            if user32.OpenClipboard(None):
                return True
            time.sleep(0.05)
        raise RuntimeError("clipboard busy")

    def get_clip_text():
        try:
            _open_clipboard()
            h = user32.GetClipboardData(CF_UNICODETEXT)
            if not h:
                return None
            p = kernel32.GlobalLock(h)
            try:
                return ctypes.wstring_at(p)
            finally:
                kernel32.GlobalUnlock(h)
        except Exception:
            return None
        finally:
            user32.CloseClipboard()

    def _set_clip(fmt, data: bytes):
        _open_clipboard()
        try:
            user32.EmptyClipboard()
            h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
            p = kernel32.GlobalLock(h)
            ctypes.memmove(p, data, len(data))
            kernel32.GlobalUnlock(h)
            if not user32.SetClipboardData(fmt, h):
                raise RuntimeError("SetClipboardData failed")
        finally:
            user32.CloseClipboard()

    def set_clip_text(text: str):
        _set_clip(CF_UNICODETEXT, (text + "\0").encode("utf-16-le"))

    def set_clip_image(path: str):
        from PIL import Image
        img = Image.open(path).convert("RGB")
        bio = io.BytesIO()
        img.save(bio, "BMP")
        _set_clip(CF_DIB, bio.getvalue()[14:])  # strip BITMAPFILEHEADER → DIB

    def focus(hwnd):
        if not hwnd:
            return
        try:
            user32.keybd_event(VK["alt"], 0, 0, 0)   # lets SetForegroundWindow succeed
            user32.keybd_event(VK["alt"], 0, KEYUP, 0)
            user32.SetForegroundWindow(hwnd)
        except Exception:
            pass


# ----------------------------------------------------------------------------- sender
class TeamsSender:
    """One worker thread, one send at a time, FIFO queue. Never sends while paused."""

    def __init__(self, log, settings_getter):
        self.log = log
        self.settings = settings_getter        # -> dict(out_dir, idle_sec, max_age_min, max_wait_sec)
        self.q: list[tuple] = []
        self.cv = threading.Condition()
        self.paused = False
        self.busy = False
        self.results: dict[str, str] = {}
        self.thread = threading.Thread(target=self._worker, daemon=True)
        self._stop = False

    def begin(self):
        self.thread.start()

    def shutdown(self):
        with self.cv:
            self._stop = True
            self.cv.notify_all()

    def enqueue(self, jid: str, target: str, link: str, title_hint: str, done_cb):
        with self.cv:
            if any(x[0] == jid for x in self.q):
                return "Already queued"
            self.q.append((jid, target, link, title_hint, done_cb))
            self.cv.notify_all()
            return "Queued"

    def _worker(self):
        while True:
            with self.cv:
                while (not self.q or self.paused) and not self._stop:
                    self.cv.wait(1)
                if self._stop:
                    return
                item = self.q.pop(0)
            jid, target, link, hint, cb = item
            self.busy = True
            try:
                res = self.send(target, link, hint)
            except Exception as e:  # noqa: BLE001
                res = f"Error: {e}"
            self.busy = False
            self.log(f"[Teams · {target}] {res}")
            try:
                cb(res)
            except Exception:
                pass

    # the actual send ------------------------------------------------------
    def send(self, target: str, link: str, hint: str = "") -> str:
        st = self.settings()
        if not IS_WIN:
            return "Skipped (Windows only)"
        if not valid_chat_link(link):
            return "Error: chat link must contain /l/chat/ (Teams → chat → ⋯ → Copy link)"
        view, flags, why = pictures_for(st["out_dir"], target, st["max_age_min"])
        if why:
            return f"Skipped: {why}"
        # 1) wait for the user to be idle
        t0 = time.time()
        while idle_seconds() < st["idle_sec"]:
            if self.paused:
                return "Skipped: paused"
            if time.time() - t0 > st["max_wait_sec"]:
                return f"Skipped: you were busy for {st['max_wait_sec']}s (will try next round)"
            time.sleep(0.25)
        prev = fg_window()
        prev_clip = get_clip_text()
        try:
            # 2) open the chat
            os.startfile(to_msteams(link))
            ok = False
            for _ in range(40):                       # up to ~10 s
                time.sleep(0.25)
                h = fg_window()
                if is_teams(h) and (not hint or hint.lower() in window_title(h).lower()):
                    ok = True
                    break
            if not ok:
                h = fg_window()
                return f"Error: Teams didn't come to the front (front window: '{window_title(h)[:60]}') — nothing pasted"
            time.sleep(1.6)                           # let the chat load
            teams_hwnd = fg_window()
            mark = last_input_tick()
            # 3) focus compose box and clear any draft
            press("alt", "shift", "c"); time.sleep(0.5)
            press("ctrl", "a"); time.sleep(0.1)
            press("delete"); time.sleep(0.2)
            # 4) paste both pictures
            for pth in (view, flags):
                if fg_window() != teams_hwnd:
                    return "Error: focus left Teams before paste — aborted (nothing sent)"
                set_clip_image(pth)
                time.sleep(0.15)
                press("ctrl", "v")
                time.sleep(1.4)
            # 5) final safety check, then send
            if fg_window() != teams_hwnd:
                return "Error: focus left Teams before Enter — draft left in chat, not sent"
            time.sleep(0.8)
            press("enter")
            time.sleep(0.6)
            return f"Sent ✓ (view + flags) at {datetime.now().strftime('%I:%M:%S %p').lstrip('0')}"
        finally:
            focus(prev)
            if prev_clip is not None:
                try:
                    set_clip_text(prev_clip)
                except Exception:
                    pass


def parse_chat_list(text: str):
    """'TSX: https://…' lines → [(label, link)]."""
    out = []
    for line in text.splitlines():
        m = re.match(r"\s*([^:]+?)\s*:\s*(\S*(?:https?://|msteams:)\S+)", line)
        if m:
            label, link = m.group(1).strip(), m.group(2).strip()
            if not link.startswith(("http", "msteams")):
                link = link[link.find("http"):]
            out.append((label, link))
    return out


# friendly labels → dashboard target names
ALIASES = {
    "tsx": "EG TSX 4P", "tsx 4p": "EG TSX 4P", "eg tsx 4p": "EG TSX 4P",
    "xmbo": "EG XM BO", "xm bo": "EG XM BO", "eg xm bo": "EG XM BO",
    "hotline": "EG Hotline", "eg hotline": "EG Hotline",
    "fraud": "EG Fraud", "eg fraud": "EG Fraud",
    "bsc": "BSC", "bsd": "BSD",
    "csa": "CSA (all)", "csa (all)": "CSA (all)",
    "smb voice": "SMB Voice", "smb chat": "SMB Chat", "mm care": "MM Care",
}


def target_for(label: str) -> str:
    return ALIASES.get(label.strip().lower(), label.strip())
