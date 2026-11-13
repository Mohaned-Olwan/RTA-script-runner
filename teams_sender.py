"""
Teams group-chat sender for RTA Script Runner — Teams DESKTOP app (new Teams), backup to the web sender.

v2.0: no blind keyboard shortcuts any more. It reads the Teams window through Windows UI Automation:
  1. wait until you've been idle for N seconds (never steals your keystrokes)
  2. check the dashboard pictures are fresh AND from the current 30-min interval (EST)
  3. open the chat (msteams: link) and confirm Teams is in front (+ optional title check)
  4. find the real "Type a message" box, put the cursor in it and CONFIRM the cursor is there (no Alt+Shift+C, no Ctrl+A)
  5. clear an old draft only inside that box, confirm it is empty (Send button greyed out)
  6. paste the pictures one by one, re-confirming the cursor is still in the box before each paste
  7. re-check the interval, then press the real Send button (Invoke — no Enter / Ctrl+Enter)
  8. confirm: the box is empty again, no "failed to send", and a NEW picture appeared in the chat
  9. give focus back to your window and restore your copied text
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
    """Return (list_of_paths, None, None) or (None, None, reason). Uses the file list the dashboard wrote,
    so 1 or 2+ flag pages, legacy view etc. are picked up automatically and stale extra pages are never sent."""
    s = slug(target)
    now = now or datetime.now(timezone.utc)
    man = load_manifest(out_dir)
    t = next((x for x in man.get("targets", []) if x.get("slug") == s), None)
    if not t:
        return None, None, f"'{target}' not in manifest (no CMS data for it, or the dashboard isn't exporting)"
    names = t.get("files") or [f"{s}_view.png", f"{s}_flags.png"]
    paths = [Path(out_dir) / n for n in names]
    missing = [p.name for p in paths if not p.exists()]
    if missing:
        return None, None, f"missing picture(s): {', '.join(missing)}"
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
    why = interval_problem(t)
    if why:
        return None, None, why
    return [str(p) for p in paths], None, None


def interval_problem(t: dict, tail_min: float = 0.75) -> str | None:
    """Pictures must belong to the current EST interval, and we must not be in its last 45 s."""
    from sched_util import est_parts
    est = est_parts()
    if t.get("interval") is not None and (int(t["interval"]) != est["idx"] or (t.get("estDate") and t["estDate"] != est["est_date"])):
        return "pictures are from the previous interval (dashboard hasn't refreshed yet)"
    if est["est_min"] - est["idx"] * 30 > 30 - tail_min:
        return "end of the interval — next send in the new interval"
    return None


def target_value(out_dir: str, target: str):
    """Worst LOB value (projection, else LA) for a target from the dashboard manifest — drives failing/tight/passing."""
    t = next((x for x in load_manifest(out_dir).get("targets", []) if x.get("slug") == slug(target)), None)
    if not t:
        return None
    vals = [(l.get("proj") if l.get("proj") is not None else l.get("la")) for l in t.get("lobs", [])]
    vals = [v for v in vals if isinstance(v, (int, float))]
    return min(vals) if vals else None


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
    VK = {"ctrl": 0x11, "alt": 0x12, "shift": 0x10, "enter": 0x0D, "delete": 0x2E, "a": 0x41, "c": 0x43, "v": 0x56, "home": 0x24, "end": 0x23}
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


# ----------------------------------------------------------------------------- UI Automation (reads the Teams window)
UIA_ERR = None
auto = None
if IS_WIN:
    try:
        import uiautomation as auto
    except Exception as e:  # noqa: BLE001
        auto = None
        UIA_ERR = str(e)

CT_BUTTON, CT_EDIT, CT_IMAGE, CT_TEXT, CT_DOCUMENT, CT_GROUP, CT_CUSTOM = 50000, 50004, 50006, 50020, 50030, 50026, 50025
COMPOSE_RE = re.compile(r"(?i)^(type a (new )?message|type a reply|type your message|reply|message|send a message|start a new message|اكتب رسالة)")
SEND_RE = re.compile(r"(?i)^send(\b|$)|^إرسال")
FAILED_RE = re.compile(r"(?i)failed to send|couldn.?t (be )?sen[dt]|not sent|message failed|retry|try again")


class TeamsUI:
    """Thin, defensive wrapper over IUIAutomation for one Teams window (call from one thread)."""

    def __init__(self, hwnd):
        self.iu = auto._AutomationClient.instance().IUIAutomation
        self.root = self.iu.ElementFromHandle(hwnd)

    # --- generic helpers
    def find(self, ctype, under=None):
        cond = self.iu.CreatePropertyCondition(auto.PropertyId.ControlTypeProperty, ctype)
        arr = (under or self.root).FindAll(4, cond)   # TreeScope_Descendants
        return [arr.GetElement(i) for i in range(arr.Length)]

    @staticmethod
    def name(e):
        try:
            return e.CurrentName or ""
        except Exception:
            return ""

    @staticmethod
    def rect(e):
        try:
            r = e.CurrentBoundingRectangle
            return (r.left, r.top, r.right, r.bottom)
        except Exception:
            return (0, 0, 0, 0)

    @staticmethod
    def rid(e):
        try:
            return tuple(e.GetRuntimeId())
        except Exception:
            return None

    @staticmethod
    def offscreen(e):
        try:
            return bool(e.CurrentIsOffscreen)
        except Exception:
            return False

    def same(self, a, b):
        try:
            return bool(self.iu.CompareElements(a, b))
        except Exception:
            return False

    def inside(self, e, container, depth=8):
        walker = self.iu.ControlViewWalker
        x = e
        for _ in range(depth):
            if x is None:
                return False
            if self.same(x, container):
                return True
            try:
                x = walker.GetParentElement(x)
            except Exception:
                return False
        return False

    # --- Teams parts
    def compose(self):
        """The 'Type a message' box of the open chat (lowest one on screen if several)."""
        cands = []
        for ct in (CT_EDIT, CT_DOCUMENT, CT_GROUP, CT_CUSTOM):
            for e in self.find(ct):
                n = self.name(e)
                if COMPOSE_RE.search(n) and not self.offscreen(e):
                    l, t, r, b = self.rect(e)
                    if r - l > 150:
                        cands.append((b, ct == CT_EDIT, e))
            if cands:
                break
        if not cands:
            return None
        cands.sort(key=lambda x: (x[1], x[0]))
        return cands[-1][2]

    def send_button(self, ed):
        """The Send button next to the box (closest 'Send…' button)."""
        el, et, er, eb = self.rect(ed)
        best = None
        for e in self.find(CT_BUTTON):
            if not SEND_RE.search(self.name(e)) or self.offscreen(e):
                continue
            l, t, r, b = self.rect(e)
            cx, cy = (l + r) / 2, (t + b) / 2
            d = max(0, el - cx, cx - er - 400) + max(0, et - 150 - cy, cy - eb - 150)
            if best is None or d < best[0]:
                best = (d, e)
        return best[1] if best and best[0] < 600 else None

    def enabled(self, e):
        try:
            return bool(e.CurrentIsEnabled)
        except Exception:
            return True

    def focused_in(self, ed):
        try:
            f = self.iu.GetFocusedElement()
        except Exception:
            return False
        return self.inside(f, ed)

    def box_images(self, ed):
        """Pictures waiting in the box (pasted images show inside the editor or right above it)."""
        el, et, er, eb = self.rect(ed)
        n = 0
        for e in self.find(CT_IMAGE):
            l, t, r, b = self.rect(e)
            if r - l < 30 or self.offscreen(e):
                continue
            if self.inside(e, ed) or (l >= el - 20 and r <= er + 400 and t >= et - 260 and b <= eb + 20):
                n += 1
        return n

    def chat_images(self, ed):
        """Runtime ids of the big pictures in the conversation (above the box)."""
        el, et, er, eb = self.rect(ed)
        out = set()
        for e in self.find(CT_IMAGE):
            l, t, r, b = self.rect(e)
            if r - l < 120 or b - t < 60 or self.offscreen(e) or b > et - 5:
                continue
            k = self.rid(e)
            if k:
                out.add(k)
        return out

    def failure_marks(self):
        out = set()
        for ct in (CT_TEXT, CT_BUTTON):
            for e in self.find(ct):
                if FAILED_RE.search(self.name(e)) and not self.offscreen(e):
                    out.add(self.rid(e) or self.name(e))
        return out

    def box_text(self, ed):
        """Text typed in the box, or None if Teams doesn't expose it."""
        c = auto.Control.CreateControlFromElement(ed)
        for get in (lambda: c.GetValuePattern().Value, lambda: c.GetTextPattern().DocumentRange.GetText(-1)):
            try:
                v = get()
                if v is not None:
                    return re.sub(r"[\s\u200b\u200c\u200d\ufeff]+", "", str(v))
            except Exception:
                continue
        return None

    def is_empty(self, ed, btn):
        if self.box_images(ed) > 0:
            return False
        t = self.box_text(ed)
        if t is not None:
            return t == ""
        return btn is None or not self.enabled(btn)

    def invoke(self, e):
        try:
            auto.Control.CreateControlFromElement(e).GetInvokePattern().Invoke()
            return True
        except Exception:
            return False

    def focus_box(self, ed):
        try:
            ed.SetFocus()
        except Exception:
            pass
        time.sleep(0.3)
        if self.focused_in(ed):
            return True
        # click inside the box (then put the mouse back)
        l, t, r, b = self.rect(ed)
        if r - l > 0:
            pt = wintypes.POINT(); user32.GetCursorPos(ctypes.byref(pt))
            user32.SetCursorPos(int(l + min(60, (r - l) / 2)), int((t + b) / 2))
            user32.mouse_event(0x0002, 0, 0, 0, 0); user32.mouse_event(0x0004, 0, 0, 0, 0)
            time.sleep(0.25)
            user32.SetCursorPos(pt.x, pt.y)
        time.sleep(0.3)
        return self.focused_in(ed)


def wait_until(fn, timeout, every=0.4):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(every)
    return None


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
        if IS_WIN and auto is not None:
            try:
                self._uia_init = auto.UIAutomationInitializerInThread()
            except Exception as e:  # noqa: BLE001
                self.log(f"Teams desktop: UI Automation init failed: {e}")
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
        pics, _, why = pictures_for(st["out_dir"], target, st["max_age_min"])
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
        if auto is None:
            return f"Error: Windows UI Automation not available ({UIA_ERR}) — use the Live (web) sender"
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
            teams_hwnd = fg_window()
            ui = TeamsUI(teams_hwnd)
            # 3) find the real "Type a message" box (the chat may still be loading)
            ed = wait_until(ui.compose, 15, 0.6)
            if ed is None:
                return "Error: couldn't find the 'Type a message' box — nothing pasted"
            if not ui.focus_box(ed):
                return "Error: couldn't put the cursor in the 'Type a message' box — nothing pasted"
            btn = ui.send_button(ed)
            # 4) clear an old draft — only inside the box (cursor confirmed there), never Ctrl+A
            for _ in range(2):
                if ui.is_empty(ed, btn):
                    break
                if not ui.focused_in(ed) or fg_window() != teams_hwnd:
                    return "Error: cursor left the message box while clearing — aborted (nothing sent)"
                press("ctrl", "end"); time.sleep(0.1)
                press("ctrl", "shift", "home"); time.sleep(0.1)
                press("delete"); time.sleep(0.5)
            if not ui.is_empty(ed, btn):
                return "Error: an old draft in the box couldn't be cleared — nothing sent (check the chat)"
            before_imgs = ui.chat_images(ed)
            before_fail = ui.failure_marks()
            # 5) paste the pictures, re-confirming the cursor before each one
            for i, pth in enumerate(pics, 1):
                if fg_window() != teams_hwnd or not ui.focused_in(ed):
                    if not (fg_window() == teams_hwnd and ui.focus_box(ed)):
                        return "Error: focus left the message box before paste — aborted (draft may be left, nothing sent)"
                set_clip_image(pth)
                time.sleep(0.15)
                press("ctrl", "v")
                if not wait_until(lambda: ui.box_images(ed) >= i or (btn is not None and ui.enabled(btn)), 12, 0.4):
                    return f"Error: picture {i} didn't appear in the box — not sent (draft left)"
                time.sleep(1.0)
            # pictures upload: wait until the Send button is usable
            btn = ui.send_button(ed) or btn
            if btn is None or not wait_until(lambda: ui.enabled(btn), 30, 0.5):
                return "Error: Send button not found / not ready — draft left in the chat, not sent"
            time.sleep(1.0)
            # 6) last checks: still Teams, still this interval
            if fg_window() != teams_hwnd:
                return "Error: focus left Teams before sending — draft left in the chat, not sent"
            man_t = next((x for x in load_manifest(st["out_dir"]).get("targets", []) if x.get("slug") == slug(target)), {})
            why = interval_problem(man_t)
            if why:
                return f"Skipped: {why} — draft left in the chat, not sent"
            # 7) press the real Send button (no Enter / Ctrl+Enter)
            if not ui.invoke(btn):
                l, t, r, b = ui.rect(btn)
                pt = wintypes.POINT(); user32.GetCursorPos(ctypes.byref(pt))
                user32.SetCursorPos(int((l + r) / 2), int((t + b) / 2))
                user32.mouse_event(0x0002, 0, 0, 0, 0); user32.mouse_event(0x0004, 0, 0, 0, 0)
                time.sleep(0.2); user32.SetCursorPos(pt.x, pt.y)
            # 8) confirm it went out
            cleared = wait_until(lambda: ui.is_empty(ed, btn), 20, 0.5)
            if not cleared:
                return "Error: pressed Send but the box didn't clear — check the chat"
            new_imgs = wait_until(lambda: ui.chat_images(ed) - before_imgs, 20, 0.8)
            fails = ui.failure_marks() - before_fail
            if fails:
                return "Error: Teams shows 'failed to send' — check the chat"
            stamp = datetime.now().strftime('%I:%M:%S %p').lstrip('0')
            if new_imgs:
                return f"Sent ✓ {len(pics)} picture(s) at {stamp} — confirmed in the chat"
            return f"Sent ✓ {len(pics)} picture(s) at {stamp} (box cleared; couldn't see the picture in the chat to double-check)"
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
