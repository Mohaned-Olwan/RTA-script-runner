"""
RTA Script Runner v3 — one app.

The RTA dashboard window IS the app (an Edge app-mode window: no address bar, own taskbar icon).
Its tabs: the dashboard (Overview … Data & Setup), ⚙ Automation (CMS web + Teams web), and the app's own tabs
(Scripts · Teams desktop · Reports). This module is the Python side underneath: script timers, the Teams desktop sender,
LAT / IEX exports + timers, roster auto-load, settings and the log. A hidden Tk root only provides native dialogs
(file pickers, the "close RTA?" question) and keeps the process alive.

Fallback: `RTA_Script_Runner.exe --classic` opens the old v2 window.
"""
from __future__ import annotations

import os
import queue
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import asdict
from datetime import datetime

import rta_runner as RR
import reports as RP
import teams_sender as TS
import web_host as WH
from web_tab import local_dir, merge_lat, ago

JOB_FIELDS = ("name", "path", "every_min", "start_at", "stop_at", "enabled", "target", "link", "hint", "every_status")


class MainThread:
    """Run callables on the Tk main thread (dialogs must live there)."""

    def __init__(self, root):
        self.root = root
        self.q: "queue.Queue" = queue.Queue()
        root.after(100, self._pump)

    def _pump(self):
        while True:
            try:
                fn, box, ev = self.q.get_nowait()
            except queue.Empty:
                break
            try:
                box["v"] = fn()
            except Exception as e:  # noqa: BLE001
                box["e"] = e
            if ev:
                ev.set()
        self.root.after(100, self._pump)

    def call(self, fn, timeout=1800):
        ev, box = threading.Event(), {}
        self.q.put((fn, box, ev))
        ev.wait(timeout)
        if "e" in box:
            raise box["e"]
        return box.get("v")

    def post(self, fn):
        self.q.put((fn, {}, None))


class AppCore:
    def __init__(self, root):
        self.root = root
        self.main = MainThread(root)
        cfg = RR.load_config()
        self.jobs: list[RR.Job] = cfg["jobs"]
        self.autostart: bool = cfg["autostart"]
        self.theme: str = cfg["theme"]
        self.tcfg: dict = cfg["teams"]           # Teams desktop settings + reports/roster settings live here (jobs.json)
        self.logs: deque = deque(maxlen=800)
        self.seq = 0
        self.lock = threading.RLock()
        self.sched = RR.Scheduler(self.log)
        self.sender = TS.TeamsSender(self.log, self.teams_settings)
        self.sched.sender = self.sender
        self.sched.set_jobs(self.jobs)
        self.host = WH.WebHost(local_dir(), log=lambda m: self.log("[RTA] " + m), app_mode=True)
        self.host.app_handler = self.rpc
        self.host.dialog_handler = self.on_dialog
        self.host.on_user_close = lambda: self.main.post(self.quit)
        self.host.on_ready.append(self._browser_ready)
        self.busy = {"lat": False, "iex": False, "roster": False}
        self.last = {"lat": float(self.tcfg.get("rep_last_lat", 0) or 0), "iex": float(self.tcfg.get("rep_last_iex", 0) or 0), "roster": 0.0}
        self.rep_msg = {"lat": "", "iex": "", "roster": ""}
        self.roster_sig = None
        self.roster_day = None
        self.quitting = False

    # ------------------------------------------------------------------ basics
    def log(self, msg: str):
        line = f"{datetime.now().strftime('%H:%M:%S')}  {msg}"
        with self.lock:
            self.seq += 1
            self.logs.append((self.seq, line))
        try:
            with RR.LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(datetime.now().strftime("%Y-%m-%d ") + line + "\n")
        except Exception:
            pass

    def teams_settings(self):
        t = self.tcfg
        return {"out_dir": t.get("out_dir", ""), "idle_sec": float(t.get("idle_sec", 3)), "max_age_min": float(t.get("max_age_min", 10)),
                "max_wait_sec": float(t.get("max_wait_sec", 90))}

    def persist(self):
        try:
            self.tcfg["rep_last_lat"], self.tcfg["rep_last_iex"] = self.last["lat"], self.last["iex"]
            RR.save_config(self.jobs, self.autostart, self.theme, self.tcfg)
        except Exception as e:  # noqa: BLE001
            self.log(f"could not save settings: {e}")

    def job(self, jid):
        return next((j for j in self.jobs if j.id == jid), None)

    # ------------------------------------------------------------------ lifecycle
    def start(self):
        self.sched.begin()
        self.sender.begin()
        self.host.open()
        threading.Thread(target=self._auto_loop, name="rta-dayfiles", daemon=True).start()
        if RR.IS_WIN:
            threading.Thread(target=self._hotkey, name="rta-hotkey", daemon=True).start()
        self.log(f"{RR.APP_NAME} {RR.APP_VERSION} ready · settings: {RR.CONFIG_FILE}")
        if self.autostart:
            def go():
                time.sleep(2)
                self.start_kind("script"); self.start_kind("teams")
            threading.Thread(target=go, daemon=True).start()
        self.root.after(1000, self._watch)

    def _watch(self):
        """Edge could not start → tell the user once and offer the classic window."""
        if self.quitting:
            return
        if self.host.state == "error" and not getattr(self, "_warned", False):
            self._warned = True
            from tkinter import messagebox
            if self._ask(lambda p: messagebox.askyesno(RR.APP_NAME, f"The RTA window (Edge) could not open:\n{self.host.error}\n\n"
                                                                    "Open the classic RTA Script Runner window instead?", parent=p)):
                self.open_classic()
                return
        self.root.after(2000, self._watch)

    def open_classic(self):
        try:
            cmd = [sys.executable, "--classic"] if getattr(sys, "frozen", False) else [sys.executable, os.path.abspath(RR.__file__), "--classic"]
            subprocess.Popen(cmd)
        except Exception as e:  # noqa: BLE001
            self.log(f"could not open the classic window: {e}")
        self.quit()

    def quit(self):
        if self.quitting:
            return
        self.quitting = True
        self.persist()
        self.sched.shutdown(); self.sender.shutdown()
        try:
            self.host.shutdown()
        except Exception:
            pass
        try:
            self.root.quit()
        except Exception:
            pass

    def _ask(self, fn):
        """Show a native dialog on top of the RTA window (main thread only)."""
        import tkinter as tk
        top = tk.Toplevel(self.root)
        top.overrideredirect(True); top.geometry("1x1+300+300"); top.attributes("-topmost", True)
        top.lift(); top.focus_force(); top.update()
        try:
            return fn(top)
        finally:
            top.destroy()

    def on_dialog(self, kind, message, default=""):
        """JS dialogs from the dashboard (runs in a worker thread). Returns True/False (or text for prompt)."""
        from tkinter import messagebox, simpledialog
        if kind == "beforeunload":
            return self.main.call(lambda: self._ask(lambda p: messagebox.askyesno(
                RR.APP_NAME, "Automation is running (CMS / Teams / scripts / report timers).\n\nClose RTA anyway? Everything stops until you open it again.", parent=p)))
        if kind == "confirm":
            return self.main.call(lambda: self._ask(lambda p: messagebox.askokcancel(RR.APP_NAME, message, parent=p)))
        if kind == "prompt":
            return self.main.call(lambda: self._ask(lambda p: simpledialog.askstring(RR.APP_NAME, message, initialvalue=default, parent=p)))
        self.main.call(lambda: self._ask(lambda p: messagebox.showinfo(RR.APP_NAME, message, parent=p)))
        return True

    def _hotkey(self):
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        if not u.RegisterHotKey(None, 1, 0x0002 | 0x0001 | 0x4000, 0x50):   # CTRL|ALT|NOREPEAT, 'P'
            self.log("note: Ctrl+Alt+P hotkey unavailable (used by another app) — use the Pause buttons")
            return
        msg = wintypes.MSG()
        while u.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            if msg.message == 0x0312:
                self.set_paused(not self.sender.paused)

    def set_paused(self, on: bool):
        self.sender.paused = bool(on)
        self.log("Teams sending PAUSED (desktop + web)" if on else "Teams sending resumed (desktop + web)")
        if self.host.state == "open":
            try:
                self.host.send({"type": "auto:pause", "on": bool(on)}, timeout=15)
            except Exception:
                pass

    # ------------------------------------------------------------------ jobs
    def start_kind(self, kind):
        for j in self.jobs:
            if j.kind == kind and j.enabled and not self.sched.rt[j.id].active:
                self.sched.start(j.id)

    def stop_kind(self, kind):
        for j in self.jobs:
            if j.kind == kind:
                self.sched.stop(j.id)

    def _job_dict(self, j, snap):
        d = asdict(j)
        s = snap.get(j.id)
        if s:
            state, nxt, last, res, runs, stop_dt, active, stat = s
            d.update(state=state, runs=runs, active=active, status=stat, next=RR.fmt_dt(nxt) if active else "—",
                     last=(RR.fmt_dt(last) + " · " + res) if last else res, result=res)
        return d

    def _apply_job(self, j, d):
        for k in JOB_FIELDS:
            if k in d:
                setattr(j, k, d[k])
        if j.kind == "teams":
            ev = str(d.get("every", j.every_status or j.every_min)).strip()
            if "/" in ev:
                from sched_util import parse_every
                try:
                    j.every_min, parts = parse_every(ev)
                    j.every_status = "/".join(f"{x:g}" for x in parts)
                except ValueError:
                    j.every_status, j.every_min = ev, 0
            else:
                j.every_status = ""
                try:
                    j.every_min = float(ev or 0)
                except ValueError:
                    j.every_min = 0
        elif "every" in d:
            try:
                j.every_min = float(str(d["every"]).strip() or 0)
            except ValueError:
                j.every_min = 0
        j.path = (j.path or "").strip().strip('"')

    # ------------------------------------------------------------------ reports / day files
    def creds(self, which):
        return RP.cred_get(f"RTA Runner/{which}")

    def rp(self):
        t = self.tcfg
        return {"kinds": [k for k in ("Voice", "Chat") if t.get("lat_" + k.lower(), True)], "lat_dir": t.get("lat_dir", r"C:\EG WFM Setup\Dumb_data\LAT_Realtime"),
                "iex_dir": t.get("iex_dir", r"C:\EG WFM Setup\Dumb_data\SKD_Realtime"), "lat_on": bool(t.get("rep_lat_on", False)),
                "iex_on": bool(t.get("rep_iex_on", False)), "lat_every_h": float(t.get("rep_lat_every_h", 1) or 1), "iex_every_h": float(t.get("rep_iex_every_h", 2) or 2),
                "load_dash": bool(t.get("rep_load_dash", True)), "roster_on": bool(t.get("live_roster_on", False)), "roster": t.get("live_roster", "")}

    def _every(self, kind):
        return max(0.25, float(self.rp()[kind + "_every_h"])) * 3600

    def load_files(self, kind, paths):
        if not paths or not self.rp()["load_dash"] or self.host.state != "open":
            return False
        if kind == "lat" and len(paths) > 1:
            paths = [merge_lat(paths, str(local_dir() / "LAT_for_dashboard.csv"))]
        try:
            self.host.load_day_files(kind, list(paths))
            self.log(f"[Day files] {'LAT' if kind == 'lat' else 'IEX schedules' if kind == 'sched' else 'roster'} loaded into the dashboard")
            return True
        except Exception as e:  # noqa: BLE001
            self.log(f"[Day files] couldn't load into the dashboard: {e}")
            return False

    def run_report(self, kind, params=None, manual=False):
        """kind lat | iex | roster. Runs in the calling thread."""
        if self.busy[kind]:
            return
        self.busy[kind] = True
        self.rep_msg[kind] = "running…"
        params = params or {}
        try:
            r = self.rp()
            if kind == "lat":
                kinds = params.get("kinds") or r["kinds"]
                date = RP.norm_date(params.get("date") or RP.today_est())
                folder = params.get("dir") or r["lat_dir"]
                user, pw = self.creds("LAT")
                if not kinds or not user or not pw:
                    raise RuntimeError("tick Voice/Chat and save the LAT login first")
                paths = RP.run_lat(kinds, date, folder, user, pw, self.log)
                if date == RP.today_est():
                    self.last["lat"] = time.time()
                    self.load_files("lat", paths)
                self.rep_msg[kind] = f"✓ {len(paths)} file(s) · {datetime.now().strftime('%I:%M %p').lstrip('0')}"
            elif kind == "iex":
                a = RP.norm_date(params.get("from") or RP.today_est()); b = RP.norm_date(params.get("to") or a)
                folder = params.get("dir") or r["iex_dir"]
                user, pw = self.creds("IEX")
                if not user or not pw:
                    raise RuntimeError("save the IEX login first")
                path = RP.run_iex(a, b, folder, user, pw, self.log)
                if a == b == RP.today_est():
                    self.last["iex"] = time.time()
                    self.load_files("sched", [path])
                self.rep_msg[kind] = f"✓ saved · {datetime.now().strftime('%I:%M %p').lstrip('0')}"
            else:
                p = r["roster"]
                if not p or not os.path.exists(p):
                    raise RuntimeError("roster file not found")
                if self.host.state != "open":
                    raise RuntimeError("the RTA window is not open")
                self.host.load_day_files("roster", [p])
                st = os.stat(p)
                self.roster_sig, self.roster_day = (p, st.st_mtime, st.st_size), datetime.now().date()
                self.last["roster"] = time.time()
                self.log("[Day files] roster loaded into the dashboard")
                self.rep_msg[kind] = f"✓ loaded · {datetime.now().strftime('%I:%M %p').lstrip('0')}"
        except Exception as e:  # noqa: BLE001
            self.rep_msg[kind] = f"✗ {e}"
            self.log(f"[{kind.upper()}] ✗ {e}")
            if kind != "roster" and not manual:
                self.last[kind] = time.time() - max(0, self._every(kind) - 900)   # retry in ~15 min
        finally:
            self.busy[kind] = False
            self.persist()

    def _browser_ready(self):
        self.roster_sig = None
        if self.rp()["iex_on"]:
            self.last["iex"] = 0

    def _auto_loop(self):
        while not self.quitting:
            time.sleep(15)
            try:
                r, now = self.rp(), time.time()
                for k in ("lat", "iex"):
                    if r[k + "_on"] and not self.busy[k] and now - self.last[k] >= self._every(k):
                        threading.Thread(target=self.run_report, args=(k,), daemon=True).start()
                if r["roster_on"] and not self.busy["roster"] and self.host.state == "open":
                    p = r["roster"]
                    if p and os.path.exists(p):
                        st = os.stat(p)
                        if self.roster_sig != (p, st.st_mtime, st.st_size) or self.roster_day != datetime.now().date():
                            threading.Thread(target=self.run_report, args=("roster",), daemon=True).start()
            except Exception:
                pass

    def timer_text(self, kind):
        if self.busy[kind]:
            return "running…" + (" (IEX takes 2–5 min)" if kind == "iex" else "")
        r = self.rp()
        if not r[kind + "_on"]:
            return f"last: {ago(self.last[kind])}"
        nxt = self.last[kind] + self._every(kind)
        return f"last: {ago(self.last[kind])} · next: {'now' if nxt <= time.time() else datetime.fromtimestamp(nxt).strftime('%I:%M %p').lstrip('0')}"

    # ------------------------------------------------------------------ state for the UI
    def state(self, since=0):
        snap = self.sched.snapshot()
        with self.lock:
            logs = [l for s, l in self.logs if s > since]
            seq = self.seq
        lu, lp = self.creds("LAT")
        iu, ip = self.creds("IEX")
        running_jobs = any(s[6] for s in snap.values())
        return {
            "version": RR.APP_VERSION, "isWin": RR.IS_WIN, "autostart": self.autostart, "seq": seq, "logs": logs,
            "jobs": [self._job_dict(j, snap) for j in self.jobs],
            "teams": dict(self.teams_settings()), "paused": self.sender.paused, "sending": self.sender.busy, "uia": TS.UIA_ERR,
            "reports": {**self.rp(), "lat_user": lu or "", "lat_has_pw": bool(lp), "iex_user": iu or "", "iex_has_pw": bool(ip),
                        "today": RP.today_est(), "lat_timer": self.timer_text("lat"), "iex_timer": self.timer_text("iex"),
                        "busy": dict(self.busy), "msg": dict(self.rep_msg), "roster_last": ago(self.last["roster"])},
            "busyAny": running_jobs or any(self.busy.values()) or self.rp()["lat_on"] or self.rp()["iex_on"],
        }

    # ------------------------------------------------------------------ RPC from the dashboard (worker thread)
    def rpc(self, op, a):
        a = a or {}
        op = op[4:]   # strip "app."
        if op == "state":
            return self.state(int(a.get("since") or 0))
        if op == "saveJob":
            j = self.job(a.get("id"))
            if j:
                self._apply_job(j, a); self.sched.set_jobs(self.jobs); self.persist()
            return True
        if op == "addJob":
            kind = a.get("kind", "script")
            j = RR.Job(every_min=2.0 if kind == "script" else 3.0, kind=kind)
            self.jobs.append(j); self.sched.set_jobs(self.jobs); self.persist()
            return j.id
        if op == "removeJob":
            self.sched.stop(a["id"], quiet=True)
            self.jobs[:] = [j for j in self.jobs if j.id != a["id"]]
            self.sched.set_jobs(self.jobs); self.persist()
            return True
        if op == "toggleJob":
            j = self.job(a["id"])
            if not j:
                return "not found"
            if self.sched.rt[j.id].active:
                self.sched.stop(j.id); return None
            return self.sched.start(j.id)
        if op == "runJob":
            j = self.job(a["id"])
            err = self.sched.validate(j) if j else "not found"
            if err and "Every" not in err:
                return err
            self.sched.run_now(j.id)
            return None
        if op == "startKind":
            self.start_kind(a["kind"]); return True
        if op == "stopKind":
            self.stop_kind(a["kind"]); return True
        if op == "stopAllAt":
            t = (a.get("time") or "").strip()
            RR.parse_hhmm(t)
            for j in self.jobs:
                if j.kind == a["kind"]:
                    j.stop_at = t
            self.sched.set_jobs(self.jobs); self.persist()
            self.log(f"stop time {t or '(none)'} applied — restart running rows to use it")
            return True
        if op == "pasteChats":
            have = {(x.target, x.link) for x in self.jobs if x.kind == "teams"}
            n = 0
            for label, link in TS.parse_chat_list(a.get("text", "")):
                tgt = TS.target_for(label)
                if (tgt, link) in have:
                    continue
                self.jobs.append(RR.Job(kind="teams", target=tgt, link=link, every_min=3.0, name=label)); n += 1
            self.sched.set_jobs(self.jobs); self.persist(); self.log(f"added {n} Teams chat(s)")
            return n
        if op == "saveTeams":
            for k in ("out_dir", "idle_sec", "max_age_min", "max_wait_sec"):
                if k in a:
                    self.tcfg[k] = a[k]
            self.persist(); return True
        if op == "pause":
            self.set_paused(bool(a.get("on"))); return True
        if op == "setAutostart":
            self.autostart = bool(a.get("on")); self.persist(); return True
        if op == "pickFile":
            from tkinter import filedialog
            ft = [("Scripts", "*.acsauto *.bat *.cmd *.ps1 *.vbs *.exe *.py"), ("All files", "*.*")] if a.get("type") == "script" else \
                 [("Excel / CSV", "*.xlsx *.xlsb *.xls *.csv"), ("All files", "*.*")]
            p = self.main.call(lambda: self._ask(lambda top: filedialog.askopenfilename(parent=top, title=a.get("title", "Choose a file"), filetypes=ft)))
            return os.path.normpath(p) if p else ""
        if op == "pickDir":
            from tkinter import filedialog
            p = self.main.call(lambda: self._ask(lambda top: filedialog.askdirectory(parent=top, title=a.get("title", "Choose folder"))))
            return os.path.normpath(p) if p else ""
        if op == "openFolder":
            p = (a.get("path") or "").strip()
            if p:
                os.makedirs(p, exist_ok=True)
                if RR.IS_WIN:
                    os.startfile(p)
            return True
        if op == "openLog":
            if RR.IS_WIN:
                os.startfile(RR.LOG_FILE)
            return True
        if op == "saveReports":
            for k in ("lat_dir", "iex_dir", "rep_lat_on", "rep_iex_on", "rep_load_dash", "live_roster", "live_roster_on", "lat_voice", "lat_chat"):
                if k in a:
                    self.tcfg[k] = a[k]
            for k in ("rep_lat_every_h", "rep_iex_every_h"):
                if k in a:
                    try:
                        self.tcfg[k] = max(0.25, float(a[k]))
                    except (TypeError, ValueError):
                        pass
            for which in ("LAT", "IEX"):
                u, p = a.get(which.lower() + "_user"), a.get(which.lower() + "_pw")
                if u is not None and (p or u != (self.creds(which)[0] or "")):
                    old_u, old_p = self.creds(which)
                    try:
                        RP.cred_set(f"RTA Runner/{which}", u.strip(), p or old_p or "")
                    except Exception as e:  # noqa: BLE001
                        self.log(f"could not save {which} login: {e}")
            self.persist(); return True
        if op == "runReport":
            kind = a.get("kind")
            if self.busy.get(kind):
                return "already running"
            threading.Thread(target=self.run_report, args=(kind, a, True), daemon=True).start()
            return None
        if op == "classic":
            self.main.post(self.open_classic); return True
        raise RuntimeError(f"unknown app op {op}")


def port_free() -> bool:
    """True if no other RTA is answering on the dashboard port."""
    s = socket.socket()
    s.settimeout(1.5)
    try:
        s.connect(("127.0.0.1", WH.PORT))
        return False
    except OSError:
        return True
    finally:
        s.close()


def main():
    import tkinter as tk
    from tkinter import messagebox
    root = tk.Tk()
    root.withdraw()
    root.title(RR.APP_NAME)
    if not port_free():
        messagebox.showinfo(RR.APP_NAME, "RTA is already running (look for the RTA window on the taskbar).")
        root.destroy()
        return
    try:
        core = AppCore(root)
        core.start()
    except Exception as e:  # noqa: BLE001
        if messagebox.askyesno(RR.APP_NAME, f"RTA could not start:\n{e}\n\nOpen the classic window instead?"):
            root.destroy()
            RR.run_app()
            return
        root.destroy()
        return
    root.mainloop()
    try:
        root.destroy()
    except Exception:
        pass
