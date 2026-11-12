"""
RTA Script Runner — runs CMS export scripts (.acsauto, .bat, .ps1, .vbs, .exe …) on a timer.

Each job: script file + every N minutes + optional start time + optional stop time.
Jobs are saved to %APPDATA%\\RTA Runner\\jobs.json and a log is written next to it.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path

APP_NAME = "RTA Script Runner"
APP_VERSION = "1.2"
IS_WIN = sys.platform.startswith("win")


# ----------------------------------------------------------------------------- storage
def data_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    d = Path(base) / "RTA Runner"
    d.mkdir(parents=True, exist_ok=True)
    return d


CONFIG_FILE = data_dir() / "jobs.json"
LOG_FILE = data_dir() / "runner.log"


@dataclass
class Job:
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    name: str = ""
    path: str = ""
    every_min: float = 2.0
    start_at: str = ""          # "HH:MM" (24h) or "" = start immediately
    stop_at: str = ""           # "HH:MM" (24h) or "" = run until stopped
    run_now: bool = True        # first run right when started (else after one interval)
    timeout_sec: int = 120      # kill a run that hangs longer than this
    enabled: bool = True
    kind: str = "script"        # "script" | "teams"
    target: str = ""            # teams: dashboard LOB / group name
    link: str = ""              # teams: group-chat link
    hint: str = ""              # teams: optional text the Teams window title must contain


TEAMS_DEFAULTS = {"out_dir": r"C:\RTA\OUT", "idle_sec": 3, "max_age_min": 10, "max_wait_sec": 90}


def load_config() -> dict:
    try:
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        jobs = [Job(**{k: v for k, v in j.items() if k in Job.__dataclass_fields__}) for j in raw.get("jobs", [])]
        return {"jobs": jobs, "autostart": bool(raw.get("autostart", False)),
                "theme": raw.get("theme", "dark"), "teams": {**TEAMS_DEFAULTS, **raw.get("teams", {})}}
    except Exception:
        return {"jobs": [], "autostart": False, "theme": "dark", "teams": dict(TEAMS_DEFAULTS)}


def save_config(jobs: list[Job], autostart: bool, theme: str, teams: dict | None = None) -> None:
    data = {"version": APP_VERSION, "autostart": autostart, "theme": theme, "teams": teams or TEAMS_DEFAULTS, "jobs": [asdict(j) for j in jobs]}
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(CONFIG_FILE)


# ----------------------------------------------------------------------------- time helpers
def parse_hhmm(s: str):
    s = (s or "").strip()
    if not s:
        return None
    s = s.replace(".", ":")
    try:
        if s.lower().endswith(("am", "pm")):
            t = datetime.strptime(s.upper().replace(" ", ""), "%I:%M%p")
        else:
            t = datetime.strptime(s, "%H:%M")
        return t.hour, t.minute
    except ValueError:
        raise ValueError(f"Time '{s}' must look like 23:00 or 11:00 PM")


def next_clock(hm, now: datetime) -> datetime:
    """Next occurrence of HH:MM at or after now (today, else tomorrow)."""
    h, m = hm
    dt = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if dt <= now:
        dt += timedelta(days=1)
    return dt


def fmt_dt(dt: datetime | None) -> str:
    if not dt:
        return "—"
    today = datetime.now().date()
    return dt.strftime("%I:%M:%S %p").lstrip("0") + ("" if dt.date() == today else " (+1d)")


# ----------------------------------------------------------------------------- launching
def build_command(path: str) -> list[str] | None:
    """Return argv for subprocess, or None to use the Windows file association."""
    ext = Path(path).suffix.lower()
    if ext in (".bat", ".cmd"):
        return ["cmd", "/c", path]
    if ext == ".ps1":
        return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path]
    if ext in (".vbs", ".js"):
        return ["cscript", "//nologo", path]
    if ext == ".exe":
        return [path]
    if ext == ".py":
        return [sys.executable, path]
    if IS_WIN:
        # .acsauto and anything else → run through its association and wait for it to finish
        return ["cmd", "/c", "start", '""', "/wait", path]
    return ["xdg-open", path]


def launch(path: str) -> subprocess.Popen:
    argv = build_command(path)
    flags = 0
    if IS_WIN:
        flags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
    cwd = str(Path(path).parent) if Path(path).parent.exists() else None
    if IS_WIN and argv[:3] == ["cmd", "/c", "start"]:
        # 'start' needs a single command string so the empty title quotes survive
        return subprocess.Popen(f'cmd /c start "" /wait "{path}"', cwd=cwd, creationflags=flags)
    return subprocess.Popen(argv, cwd=cwd, creationflags=flags)


# ----------------------------------------------------------------------------- scheduler
class Runtime:
    def __init__(self):
        self.state = "Stopped"      # Stopped | Waiting | Running | Finished | Error
        self.next_run: datetime | None = None
        self.last_run: datetime | None = None
        self.last_result = "—"
        self.runs = 0
        self.stop_dt: datetime | None = None
        self.proc: subprocess.Popen | None = None
        self.proc_started: float = 0.0
        self.active = False


class Scheduler:
    """Owns the timing loop. Thread-safe; the UI reads snapshots and sends commands."""

    def __init__(self, log_fn, clock=datetime.now, launcher=launch):
        self.jobs: dict[str, Job] = {}
        self.rt: dict[str, Runtime] = {}
        self.lock = threading.RLock()
        self.log = log_fn
        self.clock = clock
        self.launcher = launcher
        self.sender = None
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)

    # -- lifecycle
    def begin(self):
        self.thread.start()

    def shutdown(self):
        self._stop.set()

    # -- job management
    def set_jobs(self, jobs: list[Job]):
        with self.lock:
            ids = {j.id for j in jobs}
            for jid in list(self.jobs):
                if jid not in ids:
                    self.stop(jid, quiet=True)
                    self.jobs.pop(jid, None)
                    self.rt.pop(jid, None)
            for j in jobs:
                self.jobs[j.id] = j
                self.rt.setdefault(j.id, Runtime())

    def validate(self, j: Job) -> str | None:
        if j.kind == "teams":
            from teams_sender import valid_chat_link
            if not j.target:
                return "Pick the dashboard LOB / group to send"
            if not valid_chat_link(j.link):
                return "Paste the group chat link (Teams → chat → ⋯ → Copy link)"
            try:
                if float(j.every_min) <= 0:
                    return "'Every' must be more than 0 minutes"
                parse_hhmm(j.start_at); parse_hhmm(j.stop_at)
            except ValueError as e:
                return str(e)
            return None
        if not j.path:
            return "Choose a script file"
        if not Path(j.path).exists():
            return f"File not found: {j.path}"
        try:
            if float(j.every_min) <= 0:
                return "'Every' must be more than 0 minutes"
        except (TypeError, ValueError):
            return "'Every' must be a number of minutes"
        try:
            parse_hhmm(j.start_at)
            parse_hhmm(j.stop_at)
        except ValueError as e:
            return str(e)
        return None

    def start(self, jid: str) -> str | None:
        with self.lock:
            j, r = self.jobs[jid], self.rt[jid]
            err = self.validate(j)
            if err:
                r.state, r.last_result = "Error", err
                self.log(f"[{j.name or Path(j.path).name}] not started: {err}")
                return err
            now = self.clock()
            start_hm, stop_hm = parse_hhmm(j.start_at), parse_hhmm(j.stop_at)
            first = next_clock(start_hm, now) if start_hm else now
            if not start_hm and not j.run_now:
                first = now + timedelta(minutes=float(j.every_min))
            r.stop_dt = next_clock(stop_hm, first if start_hm else now) if stop_hm else None
            r.next_run, r.active, r.state, r.runs = first, True, "Waiting", 0
            stop_txt = f" until {fmt_dt(r.stop_dt)}" if r.stop_dt else ""
            self.log(f"[{self.label(j)}] started · every {float(j.every_min):g} min{stop_txt} · first run {fmt_dt(first)}")
            return None

    def stop(self, jid: str, quiet=False, reason="Stopped"):
        with self.lock:
            r, j = self.rt.get(jid), self.jobs.get(jid)
            if not r:
                return
            was = r.active
            r.active, r.next_run = False, None
            r.state = "Finished" if reason != "Stopped" else "Stopped"
            if was and not quiet:
                self.log(f"[{self.label(j)}] {reason.lower()}")

    def run_now(self, jid: str):
        with self.lock:
            self._fire(self.jobs[jid], self.rt[jid], manual=True)

    def start_all(self):
        for jid, j in list(self.jobs.items()):
            if j.enabled and not self.rt[jid].active:
                self.start(jid)

    def stop_all(self):
        for jid in list(self.jobs):
            self.stop(jid)

    @staticmethod
    def label(j: Job | None) -> str:
        if not j:
            return "?"
        if j.kind == "teams":
            return f"Teams · {j.target or j.name or 'chat'}"
        return j.name or Path(j.path).name or "job"

    # -- core loop
    def _fire(self, j: Job, r: Runtime, manual=False):
        if j.kind == "teams":
            if not self.sender:
                r.last_result = "Error: sender not available"; return
            def done(res, r=r):
                with self.lock:
                    r.last_result = res
            r.last_result = self.sender.enqueue(j.id, j.target, j.link, j.hint, done)
            r.last_run = self.clock(); r.runs += 1
            return
        if r.proc and r.proc.poll() is None:
            if time.time() - r.proc_started > j.timeout_sec:
                try:
                    r.proc.kill()
                except Exception:
                    pass
                self.log(f"[{self.label(j)}] previous run hung > {j.timeout_sec}s — killed")
            else:
                r.last_result = "Skipped (previous run still going)"
                self.log(f"[{self.label(j)}] skipped — previous run still going")
                return
        try:
            r.proc = self.launcher(j.path)
            r.proc_started = time.time()
            r.last_run = self.clock()
            r.runs += 1
            r.last_result = "Launched"
            if not manual:
                r.state = "Running"
            self.log(f"[{self.label(j)}] run #{r.runs}{' (manual)' if manual else ''}")
        except Exception as e:  # noqa: BLE001
            r.last_result = f"Error: {e}"
            r.state = "Error" if not r.active else r.state
            self.log(f"[{self.label(j)}] failed to launch: {e}")

    def tick(self):
        """One scheduling step (called every ~0.5 s by the loop; callable directly in tests)."""
        now = self.clock()
        with self.lock:
            for jid, j in self.jobs.items():
                r = self.rt[jid]
                # collect finished processes
                if r.proc and r.proc.poll() is not None:
                    code = r.proc.returncode
                    r.last_result = "OK" if code == 0 else f"Exit code {code}"
                    r.proc = None
                    if r.active:
                        r.state = "Waiting"
                if not r.active:
                    continue
                if r.stop_dt and now >= r.stop_dt:
                    self.stop(jid, reason=f"Finished — stop time {r.stop_dt.strftime('%H:%M')} reached")
                    continue
                if r.next_run and now >= r.next_run:
                    self._fire(j, r)
                    step = timedelta(minutes=float(j.every_min))
                    nxt = r.next_run + step
                    while nxt <= now:            # catch up after sleep/hibernate without bursting
                        nxt += step
                    r.next_run = nxt
                    if r.stop_dt and nxt >= r.stop_dt:
                        r.next_run = None if nxt > r.stop_dt else nxt
                    if r.state not in ("Running",):
                        r.state = "Waiting"

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001
                self.log(f"scheduler error: {e}")
            self._stop.wait(0.5)

    def snapshot(self):
        with self.lock:
            return {jid: (r.state, r.next_run, r.last_run, r.last_result, r.runs, r.stop_dt, r.active)
                    for jid, r in self.rt.items()}


# ----------------------------------------------------------------------------- UI
def run_app():
    import customtkinter as ctk
    from tkinter import filedialog, messagebox
    import teams_sender as TS

    cfg = load_config()
    ctk.set_appearance_mode(cfg["theme"])
    ctk.set_default_color_theme("blue")
    teams_cfg = cfg["teams"]

    log_q: "queue.Queue[str]" = queue.Queue()

    def log(msg: str):
        line = f"{datetime.now().strftime('%H:%M:%S')}  {msg}"
        log_q.put(line)
        try:
            with LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(datetime.now().strftime("%Y-%m-%d ") + line + "\n")
        except Exception:
            pass

    def teams_settings():
        return {"out_dir": teams_cfg.get("out_dir", ""), "idle_sec": float(teams_cfg.get("idle_sec", 3)),
                "max_age_min": float(teams_cfg.get("max_age_min", 10)), "max_wait_sec": float(teams_cfg.get("max_wait_sec", 90))}

    sched = Scheduler(log)
    sender = TS.TeamsSender(log, teams_settings)
    sched.sender = sender
    jobs: list[Job] = cfg["jobs"] or [Job(every_min=2.0)]
    sched.set_jobs(jobs)
    sched.begin()
    sender.begin()

    GOOD, WARN, BAD, MUTED = "#34c26f", "#f0b429", "#f0605d", "#8a90a0"
    STATE_COLOR = {"Running": GOOD, "Waiting": GOOD, "Stopped": MUTED, "Finished": WARN, "Error": BAD}
    TARGETS = ["EG TSX 4P", "EG XM BO", "EG Hotline", "EG Fraud", "BSC", "BSD", "CSA (all)", "SMB Voice", "SMB Chat", "MM Care",
               "CSA T1", "CSA T2", "CSA Spanish"]

    root = ctk.CTk()
    root.title(f"{APP_NAME} {APP_VERSION}")
    root.geometry("1380x780")
    root.minsize(1100, 600)

    autostart_var = ctk.BooleanVar(value=cfg["autostart"])
    theme_var = ctk.StringVar(value=cfg["theme"])

    def persist():
        try:
            save_config(jobs, autostart_var.get(), theme_var.get(), teams_cfg)
        except Exception as e:  # noqa: BLE001
            log(f"could not save settings: {e}")

    # ---------- header
    head = ctk.CTkFrame(root, corner_radius=0, fg_color=("gray92", "#15181e"))
    head.pack(fill="x")
    ctk.CTkLabel(head, text="RTA Script Runner", font=ctk.CTkFont(size=18, weight="bold")).pack(side="left", padx=(18, 6), pady=12)
    ctk.CTkLabel(head, text="CMS exports + Teams sending on a timer", text_color=MUTED).pack(side="left", pady=12)
    clock_lbl = ctk.CTkLabel(head, text="", font=ctk.CTkFont(size=14, weight="bold"))
    clock_lbl.pack(side="right", padx=18)
    pause_btn = ctk.CTkButton(head, text="Pause Teams sending  (Ctrl+Alt+P)", width=230, fg_color=("gray75", "#3a4150"))
    pause_btn.pack(side="right", padx=8)

    def toggle_pause():
        sender.paused = not sender.paused
        log("Teams sending PAUSED" if sender.paused else "Teams sending resumed")
    pause_btn.configure(command=toggle_pause)

    tabs = ctk.CTkTabview(root, corner_radius=12)
    tabs.pack(fill="both", expand=True, padx=12, pady=(6, 4))
    tab_s = tabs.add("CMS scripts")
    tab_t = tabs.add("Teams sending")
    tab_r = tabs.add("Reports")

    rows: dict[str, dict] = {}

    def job(jid):
        return next(x for x in jobs if x.id == jid)

    # ---------- generic row helpers
    def apply_row(jid):
        w, j = rows[jid], job(jid)
        j.name = w["name"].get().strip() if "name" in w else j.name
        if j.kind == "script":
            j.path = w["path"].get().strip().strip('"')
        else:
            j.target = w["target"].get().strip()
            j.link = w["link"].get().strip()
            j.hint = w["hint"].get().strip()
        try:
            j.every_min = float(w["every"].get().strip() or 0)
        except ValueError:
            j.every_min = 0
        j.start_at = w["start"].get().strip()
        j.stop_at = w["stop"].get().strip()
        j.enabled = bool(w["en"].get())
        return j

    def on_edit(jid):
        apply_row(jid); persist()

    def toggle(jid):
        j = apply_row(jid); persist()
        if sched.rt[jid].active:
            sched.stop(jid)
        else:
            err = sched.start(jid)
            if err:
                messagebox.showwarning(APP_NAME, f"{Scheduler.label(j)}: {err}")

    def run_once(jid):
        j = apply_row(jid)
        err = sched.validate(j)
        if err and "Every" not in err:
            messagebox.showwarning(APP_NAME, err); return
        sched.run_now(jid)

    def remove(jid):
        j = job(jid)
        if sched.rt[jid].active and not messagebox.askyesno(APP_NAME, f"'{Scheduler.label(j)}' is running. Stop and remove it?"):
            return
        jobs.remove(j)
        rows.pop(jid)["frame"].destroy()
        sched.set_jobs(jobs); persist()

    def common_tail(f, w, j, c):
        w["every"] = ctk.CTkEntry(f, width=70, justify="center"); w["every"].insert(0, f"{j.every_min:g}"); w["every"].grid(row=0, column=c, padx=3); c += 1
        w["start"] = ctk.CTkEntry(f, width=70, justify="center", placeholder_text="now"); w["start"].insert(0, j.start_at); w["start"].grid(row=0, column=c, padx=3); c += 1
        w["stop"] = ctk.CTkEntry(f, width=70, justify="center", placeholder_text="never"); w["stop"].insert(0, j.stop_at); w["stop"].grid(row=0, column=c, padx=3); c += 1
        w["state"] = ctk.CTkLabel(f, text="Stopped", width=105, anchor="w", text_color=MUTED, font=ctk.CTkFont(weight="bold")); w["state"].grid(row=0, column=c, padx=3); c += 1
        w["next"] = ctk.CTkLabel(f, text="—", width=100, anchor="w"); w["next"].grid(row=0, column=c, padx=3); c += 1
        w["last"] = ctk.CTkLabel(f, text="—", width=210 if j.kind == "teams" else 160, anchor="w", text_color=MUTED, wraplength=210 if j.kind == "teams" else 160, justify="left"); w["last"].grid(row=0, column=c, padx=3); c += 1
        bf = ctk.CTkFrame(f, fg_color="transparent"); bf.grid(row=0, column=c, padx=(3, 8))
        w["btn"] = ctk.CTkButton(bf, text="Start", width=62, fg_color="#1f8a4c", hover_color="#187040", command=lambda: toggle(j.id)); w["btn"].pack(side="left")
        ctk.CTkButton(bf, text="Send" if j.kind == "teams" else "Run", width=46, fg_color=("gray75", "#3a4150"), command=lambda: run_once(j.id)).pack(side="left", padx=3)
        ctk.CTkButton(bf, text="✕", width=28, fg_color="transparent", hover_color=("gray80", "#3a2a2a"), text_color=BAD, command=lambda: remove(j.id)).pack(side="left")
        for k in ("name", "path", "link", "hint", "every", "start", "stop"):
            if k in w:
                w[k].bind("<FocusOut>", lambda e, jid=j.id: on_edit(jid))
                w[k].bind("<Return>", lambda e, jid=j.id: on_edit(jid))

    # ---------- CMS scripts tab
    sbar = ctk.CTkFrame(tab_s, fg_color="transparent"); sbar.pack(fill="x", pady=(2, 6))
    shead = ctk.CTkFrame(tab_s, fg_color="transparent"); shead.pack(fill="x", padx=6)
    for i, (t, wd) in enumerate([("", 34), ("Name", 120), ("Script file", 270), ("Every", 70), ("Start", 70), ("Stop", 70),
                                 ("Status", 105), ("Next run", 100), ("Last run · result", 160), ("", 150)]):
        ctk.CTkLabel(shead, text=t, width=wd, anchor="w", text_color=MUTED, font=ctk.CTkFont(size=12)).grid(row=0, column=i, padx=3, sticky="w")
    slist = ctk.CTkScrollableFrame(tab_s, fg_color=("gray95", "#1c2028"), corner_radius=12)
    slist.pack(fill="both", expand=True)

    def browse(jid):
        p = filedialog.askopenfilename(title="Choose CMS export script",
                                       filetypes=[("CMS scripts", "*.acsauto"), ("Scripts", "*.acsauto *.bat *.cmd *.ps1 *.vbs *.exe *.py"), ("All files", "*.*")])
        if p:
            w = rows[jid]
            w["path"].delete(0, "end"); w["path"].insert(0, os.path.normpath(p))
            if not w["name"].get().strip():
                w["name"].insert(0, Path(p).stem)
            on_edit(jid)

    def add_script_row(j: Job):
        f = ctk.CTkFrame(slist, fg_color=("white", "#242935"), corner_radius=10); f.pack(fill="x", pady=4, padx=4)
        en = ctk.BooleanVar(value=j.enabled); w = {"frame": f, "en": en}; c = 0
        ctk.CTkCheckBox(f, text="", variable=en, width=28, command=lambda: on_edit(j.id)).grid(row=0, column=c, padx=(8, 2), pady=8); c += 1
        w["name"] = ctk.CTkEntry(f, width=120, placeholder_text="e.g. TSX"); w["name"].insert(0, j.name); w["name"].grid(row=0, column=c, padx=3); c += 1
        pf = ctk.CTkFrame(f, fg_color="transparent"); pf.grid(row=0, column=c, padx=3); c += 1
        w["path"] = ctk.CTkEntry(pf, width=228, placeholder_text="C:\\RTA\\Scripts\\TSX.acsauto"); w["path"].insert(0, j.path); w["path"].pack(side="left")
        ctk.CTkButton(pf, text="…", width=34, command=lambda: browse(j.id)).pack(side="left", padx=(4, 0))
        rows[j.id] = w
        common_tail(f, w, j, c)

    # ---------- Teams tab
    tset = ctk.CTkFrame(tab_t, fg_color=("gray93", "#1c2028"), corner_radius=10); tset.pack(fill="x", pady=(2, 6))
    def labeled(parent, text, width, value, ph=""):
        ctk.CTkLabel(parent, text=text, text_color=MUTED).pack(side="left", padx=(10, 4), pady=8)
        e = ctk.CTkEntry(parent, width=width, placeholder_text=ph); e.insert(0, str(value)); e.pack(side="left"); return e
    out_e = labeled(tset, "Dashboard export folder", 220, teams_cfg.get("out_dir", ""), r"C:\RTA\OUT")
    def pick_out():
        d = filedialog.askdirectory(title="Dashboard picture export folder")
        if d:
            out_e.delete(0, "end"); out_e.insert(0, os.path.normpath(d)); save_tset()
    ctk.CTkButton(tset, text="…", width=34, command=pick_out).pack(side="left", padx=4)
    idle_e = labeled(tset, "Wait until idle (s)", 50, teams_cfg.get("idle_sec", 3))
    age_e = labeled(tset, "Skip if data older than (min)", 50, teams_cfg.get("max_age_min", 10))
    wait_e = labeled(tset, "Give up waiting after (s)", 50, teams_cfg.get("max_wait_sec", 90))

    def save_tset(*_):
        teams_cfg["out_dir"] = out_e.get().strip()
        for k, e, dflt in (("idle_sec", idle_e, 3), ("max_age_min", age_e, 10), ("max_wait_sec", wait_e, 90)):
            try:
                teams_cfg[k] = float(e.get())
            except ValueError:
                teams_cfg[k] = dflt
        persist()
    for e in (out_e, idle_e, age_e, wait_e):
        e.bind("<FocusOut>", save_tset); e.bind("<Return>", save_tset)

    tbar = ctk.CTkFrame(tab_t, fg_color="transparent"); tbar.pack(fill="x", pady=(0, 6))
    thead = ctk.CTkFrame(tab_t, fg_color="transparent"); thead.pack(fill="x", padx=6)
    for i, (t, wd) in enumerate([("", 34), ("Dashboard LOB", 130), ("Group chat link", 200), ("Title contains", 110), ("Every", 70), ("Start", 70),
                                 ("Stop", 70), ("Status", 105), ("Next send", 100), ("Last send · result", 210), ("", 150)]):
        ctk.CTkLabel(thead, text=t, width=wd, anchor="w", text_color=MUTED, font=ctk.CTkFont(size=12)).grid(row=0, column=i, padx=3, sticky="w")
    tlist = ctk.CTkScrollableFrame(tab_t, fg_color=("gray95", "#1c2028"), corner_radius=12)
    tlist.pack(fill="both", expand=True)

    def add_teams_row(j: Job):
        f = ctk.CTkFrame(tlist, fg_color=("white", "#242935"), corner_radius=10); f.pack(fill="x", pady=4, padx=4)
        en = ctk.BooleanVar(value=j.enabled); w = {"frame": f, "en": en}; c = 0
        ctk.CTkCheckBox(f, text="", variable=en, width=28, command=lambda: on_edit(j.id)).grid(row=0, column=c, padx=(8, 2), pady=8); c += 1
        w["target"] = ctk.CTkComboBox(f, width=130, values=TARGETS, command=lambda _v: on_edit(j.id)); w["target"].set(j.target or ""); w["target"].grid(row=0, column=c, padx=3); c += 1
        w["link"] = ctk.CTkEntry(f, width=200, placeholder_text="https://teams…/l/chat/…"); w["link"].insert(0, j.link); w["link"].grid(row=0, column=c, padx=3); c += 1
        w["hint"] = ctk.CTkEntry(f, width=110, placeholder_text="optional"); w["hint"].insert(0, j.hint); w["hint"].grid(row=0, column=c, padx=3); c += 1
        rows[j.id] = w
        common_tail(f, w, j, c)

    def new_job(kind):
        j = Job(every_min=2.0 if kind == "script" else 3.0, kind=kind)
        jobs.append(j); sched.set_jobs(jobs)
        (add_script_row if kind == "script" else add_teams_row)(j)
        persist()

    def paste_chats():
        dlg = ctk.CTkToplevel(root); dlg.title("Paste chat list"); dlg.geometry("720x420"); dlg.grab_set()
        ctk.CTkLabel(dlg, text="One per line:   TSX: https://teams.cloud.microsoft/l/chat/…   (labels like TSX, XMBO, CSA, SMB Voice are mapped to dashboard LOBs)",
                     wraplength=680, justify="left").pack(padx=12, pady=(12, 6), anchor="w")
        box = ctk.CTkTextbox(dlg, height=280); box.pack(fill="both", expand=True, padx=12)
        def go():
            items = TS.parse_chat_list(box.get("1.0", "end"))
            have = {(x.target, x.link) for x in jobs if x.kind == "teams"}
            n = 0
            for label, link in items:
                tgt = TS.target_for(label)
                if (tgt, link) in have:
                    continue
                j = Job(kind="teams", target=tgt, link=link, every_min=3.0, name=label)
                jobs.append(j); add_teams_row(j); n += 1
            sched.set_jobs(jobs); persist(); log(f"added {n} Teams chat(s)"); dlg.destroy()
        ctk.CTkButton(dlg, text="Add chats", command=go).pack(pady=10)

    for j in jobs:
        (add_teams_row if j.kind == "teams" else add_script_row)(j)

    # ---------- toolbars
    def start_kind(kind):
        for jid in rows:
            apply_row(jid)
        persist()
        for j in jobs:
            if j.kind == kind and j.enabled and not sched.rt[j.id].active:
                sched.start(j.id)

    def stop_kind(kind):
        for j in jobs:
            if j.kind == kind:
                sched.stop(j.id)

    def set_stop(kind, entry):
        t = entry.get().strip()
        try:
            parse_hhmm(t)
        except ValueError as e:
            messagebox.showwarning(APP_NAME, str(e)); return
        for jid, w in rows.items():
            if job(jid).kind == kind:
                w["stop"].delete(0, "end"); w["stop"].insert(0, t); apply_row(jid)
        persist(); log(f"stop time {t or '(none)'} applied — restart running rows to use it")

    for bar_, kind, addtxt in ((sbar, "script", "+ Add script"), (tbar, "teams", "+ Add chat")):
        ctk.CTkButton(bar_, text=addtxt, width=110, command=lambda k=kind: new_job(k)).pack(side="left")
        if kind == "teams":
            ctk.CTkButton(bar_, text="Paste chat list", width=120, fg_color=("gray75", "#3a4150"), command=paste_chats).pack(side="left", padx=(8, 0))
        ctk.CTkButton(bar_, text="Start all", width=96, fg_color="#1f8a4c", hover_color="#187040", command=lambda k=kind: start_kind(k)).pack(side="left", padx=8)
        ctk.CTkButton(bar_, text="Stop all", width=96, fg_color="#b23b3b", hover_color="#8f2f2f", command=lambda k=kind: stop_kind(k)).pack(side="left")
        ctk.CTkLabel(bar_, text="   Stop all at", text_color=MUTED).pack(side="left")
        se = ctk.CTkEntry(bar_, width=76, justify="center", placeholder_text="23:00"); se.pack(side="left", padx=6)
        ctk.CTkButton(bar_, text="Apply", width=60, fg_color=("gray75", "#3a4150"), command=lambda k=kind, e=se: set_stop(k, e)).pack(side="left")

    def toggle_theme():
        theme_var.set("light" if theme_var.get() == "dark" else "dark")
        ctk.set_appearance_mode(theme_var.get()); persist()
    ctk.CTkButton(sbar, text="◐", width=34, fg_color=("gray75", "#3a4150"), command=toggle_theme).pack(side="right")
    ctk.CTkCheckBox(sbar, text="Start all rows (both tabs) when the app opens", variable=autostart_var, command=persist).pack(side="right", padx=12)
    ctk.CTkLabel(tbar, text="Sends view + flags pictures in one message. Keep Teams signed in. Test with 'Send' first.",
                 text_color=MUTED).pack(side="right", padx=8)

    # ---------- Reports tab (LAT + IEX exporters)
    import reports as RP
    RFONT = ctk.CTkFont(size=15, weight="bold")

    def rcard(parent, title, sub):
        f = ctk.CTkFrame(parent, fg_color=("white", "#242935"), corner_radius=12)
        f.pack(fill="x", padx=6, pady=6)
        ctk.CTkLabel(f, text=title, font=RFONT).grid(row=0, column=0, columnspan=8, sticky="w", padx=14, pady=(10, 0))
        ctk.CTkLabel(f, text=sub, text_color=MUTED).grid(row=1, column=0, columnspan=8, sticky="w", padx=14, pady=(0, 8))
        return f

    def rfield(f, r, c, label, width, value="", show=None, ph=""):
        ctk.CTkLabel(f, text=label, text_color=MUTED).grid(row=r, column=c, sticky="e", padx=(14, 4), pady=4)
        e = ctk.CTkEntry(f, width=width, show=show, placeholder_text=ph); e.insert(0, value); e.grid(row=r, column=c + 1, sticky="w", pady=4)
        return e

    def open_folder(path):
        path = path.strip()
        if not path:
            return
        os.makedirs(path, exist_ok=True)
        if IS_WIN:
            os.startfile(path)

    def pick_dir(entry):
        d = filedialog.askdirectory(title="Choose folder")
        if d:
            entry.delete(0, "end"); entry.insert(0, os.path.normpath(d)); save_rset()

    def save_rset(*_):
        teams_cfg["lat_dir"] = lat_dir.get().strip(); teams_cfg["iex_dir"] = iex_dir.get().strip(); persist()

    def run_bg(btn, label, fn):
        def worker():
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                log(f"{label}: ✗ {e}")
                root.after(0, lambda: messagebox.showerror(APP_NAME, f"{label} failed:\n{e}"))
            finally:
                root.after(0, lambda: btn.configure(state="normal", text=btn._orig))
        btn._orig = btn.cget("text"); btn.configure(state="disabled", text="Running…")
        threading.Thread(target=worker, daemon=True).start()

    # LAT
    lu, lp = RP.cred_get("RTA Runner/LAT")
    lat = rcard(tab_r, "LAT export (cmclineadherence)", "Detailed Dashboard (Voice) and Chat Dashboard → CSV. Default date = today (EST).")
    lat_user = rfield(lat, 2, 0, "Username", 160, lu)
    lat_pw = rfield(lat, 2, 2, "Password", 160, lp, show="•")
    lat_date = rfield(lat, 3, 0, "Date (MM/DD/YYYY)", 160, RP.today_est())
    ctk.CTkButton(lat, text="Today", width=60, fg_color=("gray75", "#3a4150"), command=lambda: (lat_date.delete(0, "end"), lat_date.insert(0, RP.today_est()))).grid(row=3, column=2, sticky="w", padx=4)
    lat_dir = rfield(lat, 4, 0, "Save to", 360, teams_cfg.get("lat_dir", r"C:\EG WFM Setup\Dumb_data\LAT_Realtime"))
    ctk.CTkButton(lat, text="…", width=34, command=lambda: pick_dir(lat_dir)).grid(row=4, column=2, sticky="w", padx=4)
    lat_v, lat_c = ctk.BooleanVar(value=True), ctk.BooleanVar(value=True)
    kf = ctk.CTkFrame(lat, fg_color="transparent"); kf.grid(row=5, column=1, columnspan=3, sticky="w", pady=4)
    ctk.CTkCheckBox(kf, text="Voice", variable=lat_v).pack(side="left", padx=(0, 12))
    ctk.CTkCheckBox(kf, text="Chat", variable=lat_c).pack(side="left")
    lbf = ctk.CTkFrame(lat, fg_color="transparent"); lbf.grid(row=6, column=0, columnspan=6, sticky="w", padx=14, pady=(6, 12))

    def do_lat():
        kinds = [k for k, v in (("Voice", lat_v), ("Chat", lat_c)) if v.get()]
        if not kinds:
            messagebox.showwarning(APP_NAME, "Tick Voice and/or Chat"); return
        try:
            d = RP.norm_date(lat_date.get())
        except ValueError as e:
            messagebox.showwarning(APP_NAME, str(e)); return
        u, pw_ = lat_user.get().strip(), lat_pw.get()
        if not u or not pw_:
            messagebox.showwarning(APP_NAME, "Enter the LAT username and password"); return
        try:
            RP.cred_set("RTA Runner/LAT", u, pw_)
        except Exception as e:  # noqa: BLE001
            log(f"could not save LAT login: {e}")
        save_rset()
        run_bg(lat_btn, "LAT export", lambda: RP.run_lat(kinds, d, lat_dir.get().strip(), u, pw_, log))
    lat_btn = ctk.CTkButton(lbf, text="Run LAT export", width=140, fg_color="#1f8a4c", hover_color="#187040", command=do_lat); lat_btn.pack(side="left")
    ctk.CTkButton(lbf, text="Open folder", width=110, fg_color=("gray75", "#3a4150"), command=lambda: open_folder(lat_dir.get())).pack(side="left", padx=8)

    # IEX
    iu, ip = RP.cred_get("RTA Runner/IEX")
    iex = rcard(tab_r, "IEX Agent Schedules (EG_MU · 1000 COMCAST_EG)", "NICE WFM webstation → schedule file for the dashboard. The site is slow: 2–5 min is normal.")
    iex_user = rfield(iex, 2, 0, "Username", 160, iu)
    iex_pw = rfield(iex, 2, 2, "Password", 160, ip, show="•")
    iex_from = rfield(iex, 3, 0, "From (MM/DD/YYYY)", 160, RP.today_est())
    iex_to = rfield(iex, 3, 2, "To", 160, RP.today_est())
    ctk.CTkButton(iex, text="Today", width=60, fg_color=("gray75", "#3a4150"),
                  command=lambda: [(e.delete(0, "end"), e.insert(0, RP.today_est())) for e in (iex_from, iex_to)]).grid(row=3, column=4, sticky="w", padx=4)
    iex_dir = rfield(iex, 4, 0, "Save to", 360, teams_cfg.get("iex_dir", r"C:\EG WFM Setup\Dumb_data\SKD_Realtime"))
    ctk.CTkButton(iex, text="…", width=34, command=lambda: pick_dir(iex_dir)).grid(row=4, column=2, sticky="w", padx=4)
    ibf = ctk.CTkFrame(iex, fg_color="transparent"); ibf.grid(row=5, column=0, columnspan=6, sticky="w", padx=14, pady=(6, 12))

    def do_iex():
        try:
            a, b = RP.norm_date(iex_from.get()), RP.norm_date(iex_to.get())
        except ValueError as e:
            messagebox.showwarning(APP_NAME, str(e)); return
        u, pw_ = iex_user.get().strip(), iex_pw.get()
        if not u or not pw_:
            messagebox.showwarning(APP_NAME, "Enter the IEX username and password"); return
        try:
            RP.cred_set("RTA Runner/IEX", u, pw_)
        except Exception as e:  # noqa: BLE001
            log(f"could not save IEX login: {e}")
        save_rset()
        run_bg(iex_btn, "IEX export", lambda: RP.run_iex(a, b, iex_dir.get().strip(), u, pw_, log))
    iex_btn = ctk.CTkButton(ibf, text="Run IEX export", width=140, fg_color="#1f8a4c", hover_color="#187040", command=do_iex); iex_btn.pack(side="left")
    ctk.CTkButton(ibf, text="Open folder", width=110, fg_color=("gray75", "#3a4150"), command=lambda: open_folder(iex_dir.get())).pack(side="left", padx=8)
    for e in (lat_dir, iex_dir):
        e.bind("<FocusOut>", save_rset)
    ctk.CTkLabel(tab_r, text="Logins are saved in Windows Credential Manager (not in any file). Uses the Edge already installed on this PC.",
                 text_color=MUTED).pack(anchor="w", padx=12, pady=6)

    # ---------- log
    logf = ctk.CTkFrame(root, fg_color="transparent"); logf.pack(fill="x", padx=16, pady=(0, 4))
    ctk.CTkLabel(logf, text="Log", text_color=MUTED).pack(side="left")
    ctk.CTkButton(logf, text="Open log file", width=100, fg_color=("gray75", "#3a4150"),
                  command=lambda: os.startfile(LOG_FILE) if IS_WIN else None).pack(side="right")
    logbox = ctk.CTkTextbox(root, height=140, font=ctk.CTkFont(family="Consolas", size=12))
    logbox.pack(fill="x", padx=16, pady=(0, 8)); logbox.configure(state="disabled")
    ctk.CTkLabel(root, text="Times = this PC's clock (Cairo). Every = minutes (0.5 = 30 s). Start/Stop = 23:00 or 11:00 PM; earlier than now = tomorrow.",
                 text_color=MUTED, font=ctk.CTkFont(size=11)).pack(fill="x", padx=18, pady=(0, 6))

    # ---------- global pause hotkey (Ctrl+Alt+P)
    if IS_WIN:
        def hotkey_thread():
            import ctypes
            from ctypes import wintypes
            u = ctypes.windll.user32
            if not u.RegisterHotKey(None, 1, 0x0002 | 0x0001 | 0x4000, 0x50):   # CTRL|ALT|NOREPEAT, 'P'
                log("note: Ctrl+Alt+P hotkey unavailable (used by another app) — use the Pause button")
                return
            msg = wintypes.MSG()
            while u.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
                if msg.message == 0x0312:
                    root.after(0, toggle_pause)
        threading.Thread(target=hotkey_thread, daemon=True).start()

    # ---------- refresh UI
    def refresh():
        while not log_q.empty():
            line = log_q.get_nowait()
            logbox.configure(state="normal"); logbox.insert("end", line + "\n")
            if int(logbox.index("end-1c").split(".")[0]) > 800:
                logbox.delete("1.0", "200.0")
            logbox.see("end"); logbox.configure(state="disabled")
        snap = sched.snapshot()
        for jid, w in rows.items():
            if jid not in snap:
                continue
            state, nxt, last, res, runs, stop_dt, active = snap[jid]
            label = state + (f" · {runs}" if runs and state in ("Running", "Waiting") else "")
            w["state"].configure(text=label, text_color=STATE_COLOR.get(state, MUTED))
            w["next"].configure(text=fmt_dt(nxt) if active else "—")
            bad = res.startswith(("Error", "Exit"))
            good = res.startswith("Sent")
            w["last"].configure(text=(fmt_dt(last) + " · " + res) if last else res,
                                text_color=BAD if bad else GOOD if good else WARN if res.startswith("Skipped") else MUTED)
            if active:
                w["btn"].configure(text="Stop", fg_color="#b23b3b", hover_color="#8f2f2f")
            else:
                w["btn"].configure(text="Start", fg_color="#1f8a4c", hover_color="#187040")
        pause_btn.configure(text=("RESUME Teams sending" if sender.paused else "Pause Teams sending  (Ctrl+Alt+P)"),
                            fg_color=("#e0a000" if sender.paused else ("gray75", "#3a4150")))
        clock_lbl.configure(text=datetime.now().strftime("%I:%M:%S %p").lstrip("0") + ("  · sending…" if sender.busy else ""))
        root.after(500, refresh)

    def on_close():
        active = [jid for jid, s_ in sched.snapshot().items() if s_[6]]
        if active and not messagebox.askyesno(APP_NAME, f"{len(active)} row(s) are running. Closing stops them. Close anyway?"):
            return
        for jid in rows:
            apply_row(jid)
        save_tset(); persist()
        sched.shutdown(); sender.shutdown(); root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    log(f"{APP_NAME} {APP_VERSION} ready · settings: {CONFIG_FILE}")
    if autostart_var.get():
        root.after(800, lambda: (start_kind("script"), start_kind("teams")))
    refresh()
    root.mainloop()


if __name__ == "__main__":
    run_app()
