"""
Report exporters for RTA Script Runner (Reports tab).

- LAT export (Voice "Detailed Dashboard" / Chat "Chat Dashboard") from cmclineadherence.com → CSV
- IEX "Agent Schedules" (EG_MU set) from the VXI NICE WFM webstation

Uses the Microsoft Edge already installed on the PC (Playwright channel="msedge"), headless.
Logins are kept in Windows Credential Manager (never in code / config files).
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

IS_WIN = sys.platform.startswith("win")

LAT_URL = "https://cmclineadherence.com"
IEX_LOGIN_URL = "https://vxiwebstation03.vxi.com.ph/wfm/login"
IEX_REPORT_VIEW_URL = "https://vxiwebstation03.vxi.com.ph/wfm/supervisor/reports-view"
IEX_REPORT_URL = "https://vxiwebstation03.vxi.com.ph/supv/reportAction.mvc?schRptOid=8aed82559bc72bc9019c7b14052a1f79"
IEX_MU_CODE = "1000 COMCAST_EG"


# ----------------------------------------------------------------------------- credentials
if IS_WIN:
    import ctypes
    from ctypes import wintypes

    class CREDENTIAL(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
                    ("Comment", wintypes.LPWSTR), ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                    ("CredentialBlob", ctypes.POINTER(ctypes.c_char)), ("Persist", wintypes.DWORD),
                    ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
                    ("UserName", wintypes.LPWSTR)]

    _adv = ctypes.WinDLL("advapi32", use_last_error=True)
    _adv.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(CREDENTIAL))]
    _adv.CredWriteW.argtypes = [ctypes.POINTER(CREDENTIAL), wintypes.DWORD]
    _adv.CredFree.argtypes = [ctypes.c_void_p]

    def cred_get(target: str):
        p = ctypes.POINTER(CREDENTIAL)()
        if not _adv.CredReadW(target, 1, 0, ctypes.byref(p)):
            return "", ""
        try:
            c = p.contents
            pw = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize).decode("utf-16-le") if c.CredentialBlobSize else ""
            return c.UserName or "", pw
        finally:
            _adv.CredFree(p)

    def cred_set(target: str, user: str, pw: str):
        blob = pw.encode("utf-16-le")
        c = CREDENTIAL()
        c.Type = 1                      # CRED_TYPE_GENERIC
        c.TargetName = target
        c.UserName = user
        c.CredentialBlobSize = len(blob)
        c.CredentialBlob = ctypes.cast(ctypes.create_string_buffer(blob, len(blob)), ctypes.POINTER(ctypes.c_char))
        c.Persist = 2                   # CRED_PERSIST_LOCAL_MACHINE
        if not _adv.CredWriteW(ctypes.byref(c), 0):
            raise OSError(ctypes.get_last_error(), "CredWrite failed")
else:  # test fallback (Linux/macOS): plain JSON in the config dir
    _CRED_FILE = Path(os.environ.get("APPDATA") or Path.home() / ".config") / "RTA Runner" / "creds_test.json"

    def cred_get(target: str):
        try:
            d = json.loads(_CRED_FILE.read_text())
            return tuple(d.get(target, ["", ""]))
        except Exception:
            return "", ""

    def cred_set(target: str, user: str, pw: str):
        _CRED_FILE.parent.mkdir(parents=True, exist_ok=True)
        try:
            d = json.loads(_CRED_FILE.read_text())
        except Exception:
            d = {}
        d[target] = [user, pw]
        _CRED_FILE.write_text(json.dumps(d))


# ----------------------------------------------------------------------------- dates
def today_est() -> str:
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York")).strftime("%m/%d/%Y")
    except Exception:
        return (datetime.utcnow() - timedelta(hours=5)).strftime("%m/%d/%Y")


def norm_date(s: str) -> str:
    """Accepts 11/12/2026, 11/12/26, 2026-11-12, 12-11-2026? (no) → MM/DD/YYYY."""
    s = (s or "").strip()
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%m-%d-%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%m/%d/%Y")
        except ValueError:
            pass
    raise ValueError(f"Date '{s}' must look like 11/12/2026")


def short_date(mmddyyyy: str) -> str:
    m, d, y = mmddyyyy.split("/")
    return f"{int(m)}/{int(d)}/{y[-2:]}"


def date_range(start: str, end: str) -> list[str]:
    a, b = datetime.strptime(norm_date(start), "%m/%d/%Y"), datetime.strptime(norm_date(end), "%m/%d/%Y")
    if b < a:
        a, b = b, a
    out = []
    while a <= b:
        out.append(a.strftime("%m/%d/%Y")); a += timedelta(days=1)
    return out


def xlsx_to_csv(xlsx: str, csv_path: str):
    import openpyxl
    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        for row in ws.iter_rows(values_only=True):
            w.writerow(["" if v is None else v for v in row])
    wb.close()


def _browser(p, headless=True):
    try:
        return p.chromium.launch(channel="msedge", headless=headless)
    except Exception:
        return p.chromium.launch(headless=headless)   # dev fallback (bundled chromium)


# ----------------------------------------------------------------------------- LAT
def run_lat(kinds: list[str], date: str, folder: str, user: str, pw: str, log, headless=True) -> list[str]:
    """kinds ⊂ {"Voice","Chat"}. Returns the CSV paths written."""
    from playwright.sync_api import sync_playwright
    date = norm_date(date)
    os.makedirs(folder, exist_ok=True)
    is_today = date == today_est()
    out = []
    with sync_playwright() as p:
        log("LAT: opening Edge…")
        br = _browser(p, headless)
        ctx = br.new_context(accept_downloads=True)
        page = ctx.new_page()
        try:
            page.goto(LAT_URL, timeout=90000)
            page.fill("input[name='userName']", user)
            page.fill("input[name='passWord']", pw)
            page.click("input[value='Login']")
            page.wait_for_load_state("networkidle", timeout=90000)
            if page.locator("input[name='passWord']").count():
                raise RuntimeError("LAT login failed — check username/password")
            log("LAT: logged in")
            for kind in kinds:
                page.goto(LAT_URL + "/index.jsp", timeout=90000)
                page.wait_for_load_state("networkidle")
                tab = page.locator("#tabGeamReports"); tab.wait_for(state="visible", timeout=60000); tab.click()
                page.wait_for_load_state("networkidle")
                menu = page.locator("div.menu:has-text('Realtime')"); menu.wait_for(state="visible"); menu.hover()
                page.wait_for_timeout(300)
                link = page.locator(f"a:has-text('{'Chat Dashboard' if kind == 'Chat' else 'Detailed Dashboard'}')")
                link.wait_for(state="visible"); link.click()
                page.wait_for_load_state("networkidle")
                for dd in ("division", "supplier", "staffgroup", "forecast"):
                    d = page.locator(f"#ddcl-{dd}-select"); d.wait_for(state="visible"); d.scroll_into_view_if_needed()
                    box = d.bounding_box()
                    if box:
                        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                    page.wait_for_timeout(300)
                    cb = page.locator(f"#ddcl-{dd}-select-i0")
                    if cb.count() and not cb.is_checked():
                        cb.check()
                page.locator("#export-select").select_option("2")      # Detailed
                page.fill("#_startDate", date); page.fill("#_endDate", date)
                with page.expect_download(timeout=180000) as dl:
                    btn = page.locator("#divExport"); btn.scroll_into_view_if_needed(); btn.click()
                name = f"LAT_Export_{kind}" + ("" if is_today else "_" + date.replace("/", "-"))
                xlsx = os.path.join(folder, name + ".xlsx")
                dl.value.save_as(xlsx)
                csv_path = xlsx[:-5] + ".csv"
                xlsx_to_csv(xlsx, csv_path); os.remove(xlsx)
                out.append(csv_path)
                log(f"LAT {kind}: ✓ {csv_path}")
        finally:
            br.close()
    return out


# ----------------------------------------------------------------------------- IEX
def run_iex(start: str, end: str, folder: str, user: str, pw: str, log, headless=True) -> str:
    from playwright.sync_api import sync_playwright
    start, end = norm_date(start), norm_date(end)
    os.makedirs(folder, exist_ok=True)
    t_start, t_end = short_date(start), short_date(end)
    single_today = start == end == today_est()
    with sync_playwright() as p:
        log("IEX: opening Edge…")
        br = _browser(p, headless)
        ctx = br.new_context(ignore_https_errors=True, accept_downloads=True)
        page = ctx.new_page()
        try:
            page.goto(IEX_LOGIN_URL, wait_until="domcontentloaded", timeout=120000)
            page.wait_for_selector("#username", timeout=120000)
            page.fill("#username", user); page.fill("#password", pw); page.click("#btnLogin")
            log("IEX: logging in (this site is slow)…")
            for _ in range(60):                                   # up to ~2 min
                page.wait_for_timeout(2000)
                if "login" not in page.url.lower():
                    break
            else:
                raise RuntimeError("IEX login did not finish — check username/password")
            log("IEX: logged in, requesting report…")
            page.goto(IEX_REPORT_URL, timeout=120000)
            page.wait_for_selector("#stAbsDate", timeout=60000)
            page.fill("#stAbsDate", start); page.fill("#endAbsDate", end)
            page.click("input[type='submit'][value='Generate']")
            page.wait_for_timeout(2000); page.keyboard.press("Enter")
            requested = datetime.now()
            log("IEX: generating… checking Reports View every 20 s")
            for attempt in range(12):                             # up to ~4 min
                page.wait_for_timeout(20000 if attempt else 30000)
                page.goto(IEX_REPORT_VIEW_URL, timeout=120000)
                page.wait_for_selector("iframe.legacy-wrapper", timeout=60000)
                frame = page.query_selector("iframe.legacy-wrapper").content_frame()
                frame.wait_for_selector("tr", state="attached", timeout=60000)
                best, best_t = None, datetime.min
                for row in frame.query_selector_all("tr"):
                    s_td, e_td = row.query_selector("td.startColumn_N"), row.query_selector("td.endColumn_N")
                    subj, tm, a = row.query_selector("td.subjectColumn_N div"), row.query_selector("td.generatedTimeColumn_N"), row.query_selector("td.reportColumn_N a")
                    if not (s_td and e_td and subj and tm and a):
                        continue
                    st = (subj.get_attribute("title") or subj.inner_text()).strip()
                    if t_start in s_td.inner_text() and t_end in e_td.inner_text() and IEX_MU_CODE in st:
                        gt = _parse_gen_time(tm.inner_text())
                        if gt > best_t:
                            best, best_t = a, gt
                if best:
                    name = "EG_MU_Agent_Schedules" + ("" if single_today else f"_{start.replace('/', '-')}_to_{end.replace('/', '-')}")
                    path = os.path.join(folder, name)
                    if os.path.exists(path):
                        os.remove(path)
                    with page.expect_download(timeout=120000) as dl:
                        best.click()
                    dl.value.save_as(path)
                    log(f"IEX: ✓ {path}")
                    return path
                log(f"IEX: not ready yet (attempt {attempt + 1}/12)")
            raise RuntimeError("IEX report did not show up in Reports View after ~4 min")
        finally:
            br.close()


def _parse_gen_time(s: str) -> datetime:
    for fmt in ("%m/%d/%Y %I:%M:%S %p", "%b %d, %Y %I:%M:%S %p", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S",
                "%m/%d/%y %H:%M:%S", "%m/%d/%y %I:%M %p", "%m/%d/%Y %I:%M %p"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return datetime.min
