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
APP_VERSION = "1.0"
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


def load_config() -> dict:
    try:
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        jobs = [Job(**{k: v for k, v in j.items() if k in Job.__dataclass_fields__}) for j in raw.get("jobs", [])]
        return {"jobs": jobs, "autostart": bool(raw.get("autostart", False)),
                "theme": raw.get("theme", "dark")}
    except Exception:
        return {"jobs": [], "autostart": False, "theme": "dark"}


def save_config(jobs: list[Job], autostart: bool, theme: str) -> None:
    data = {"version": APP_VERSION, "autostart": autostart, "theme": theme, "jobs": [asdict(j) for j in jobs]}
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
        return j.name or Path(j.path).name or "job"

    # -- core loop
    def _fire(self, j: Job, r: Runtime, manual=False):
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

    cfg = load_config()
    ctk.set_appearance_mode(cfg["theme"])
    ctk.set_default_color_theme("blue")

    log_q: "queue.Queue[str]" = queue.Queue()

    def log(msg: str):
        line = f"{datetime.now().strftime('%H:%M:%S')}  {msg}"
        log_q.put(line)
        try:
            with LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(datetime.now().strftime("%Y-%m-%d ") + line + "\n")
        except Exception:
            pass

    sched = Scheduler(log)
    jobs: list[Job] = cfg["jobs"] or [Job(name="", every_min=2.0)]
    sched.set_jobs(jobs)
    sched.begin()

    GOOD, WARN, BAD, MUTED = "#34c26f", "#f0b429", "#f0605d", "#8a90a0"
    STATE_COLOR = {"Running": GOOD, "Waiting": GOOD, "Stopped": MUTED, "Finished": WARN, "Error": BAD}

    root = ctk.CTk()
    root.title(f"{APP_NAME}")
    root.geometry("1340x740")
    root.minsize(980, 560)

    # ---------- header
    head = ctk.CTkFrame(root, corner_radius=0, fg_color=("gray92", "#15181e"))
    head.pack(fill="x")
    ctk.CTkLabel(head, text="RTA Script Runner", font=ctk.CTkFont(size=18, weight="bold")).pack(side="left", padx=(18, 6), pady=12)
    ctk.CTkLabel(head, text="runs your CMS export scripts on a timer", text_color=MUTED).pack(side="left", pady=12)
    clock_lbl = ctk.CTkLabel(head, text="", font=ctk.CTkFont(size=14, weight="bold"))
    clock_lbl.pack(side="right", padx=18)

    bar = ctk.CTkFrame(root, fg_color="transparent")
    bar.pack(fill="x", padx=16, pady=(12, 6))

    autostart_var = ctk.BooleanVar(value=cfg["autostart"])
    theme_var = ctk.StringVar(value=cfg["theme"])

    def persist():
        try:
            save_config(jobs, autostart_var.get(), theme_var.get())
        except Exception as e:  # noqa: BLE001
            log(f"could not save settings: {e}")

    # ---------- job list
    cols = ctk.CTkFrame(root, fg_color="transparent")
    cols.pack(fill="x", padx=22)
    header_cols = [("", 34), ("Name", 130), ("Script file", 270), ("Every (min)", 80), ("Start at", 78),
                   ("Stop at", 78), ("Status", 110), ("Next run", 110), ("Last run · result", 160), ("", 160)]
    for i, (t, w) in enumerate(header_cols):
        ctk.CTkLabel(cols, text=t, width=w, anchor="w", text_color=MUTED, font=ctk.CTkFont(size=12)).grid(row=0, column=i, padx=3, sticky="w")

    listf = ctk.CTkScrollableFrame(root, fg_color=("gray95", "#1c2028"), corner_radius=12)
    listf.pack(fill="both", expand=True, padx=16, pady=(2, 8))

    rows: dict[str, dict] = {}

    def apply_row(jid):
        """Copy widget values into the Job object."""
        w, j = rows[jid], next(x for x in jobs if x.id == jid)
        j.name = w["name"].get().strip()
        j.path = w["path"].get().strip().strip('"')
        try:
            j.every_min = float(w["every"].get().strip() or 0)
        except ValueError:
            j.every_min = 0
        j.start_at = w["start"].get().strip()
        j.stop_at = w["stop"].get().strip()
        j.enabled = bool(w["en"].get())
        return j

    def on_edit(jid):
        apply_row(jid)
        persist()

    def browse(jid):
        p = filedialog.askopenfilename(title="Choose CMS export script",
                                       filetypes=[("CMS scripts", "*.acsauto"), ("Scripts", "*.acsauto *.bat *.cmd *.ps1 *.vbs *.exe *.py"), ("All files", "*.*")])
        if p:
            w = rows[jid]
            w["path"].delete(0, "end")
            w["path"].insert(0, os.path.normpath(p))
            if not w["name"].get().strip():
                w["name"].insert(0, Path(p).stem)
            on_edit(jid)

    def toggle(jid):
        j = apply_row(jid)
        persist()
        if sched.rt[jid].active:
            sched.stop(jid)
        else:
            err = sched.start(jid)
            if err:
                messagebox.showwarning(APP_NAME, f"{Sched_label(j)}: {err}")

    def Sched_label(j):  # noqa: N802
        return Scheduler.label(j)

    def run_once(jid):
        j = apply_row(jid)
        err = sched.validate(j)
        if err and "Every" not in err:
            messagebox.showwarning(APP_NAME, err)
            return
        sched.run_now(jid)

    def remove(jid):
        j = next(x for x in jobs if x.id == jid)
        if sched.rt[jid].active and not messagebox.askyesno(APP_NAME, f"'{Sched_label(j)}' is running. Stop and remove it?"):
            return
        jobs.remove(j)
        rows.pop(jid)["frame"].destroy()
        sched.set_jobs(jobs)
        persist()

    def add_row(j: Job):
        f = ctk.CTkFrame(listf, fg_color=("white", "#242935"), corner_radius=10)
        f.pack(fill="x", pady=4, padx=4)
        en = ctk.BooleanVar(value=j.enabled)
        w = {"frame": f, "en": en}
        c = 0
        ctk.CTkCheckBox(f, text="", variable=en, width=28, command=lambda: on_edit(j.id)).grid(row=0, column=c, padx=(8, 2), pady=8); c += 1
        w["name"] = ctk.CTkEntry(f, width=130, placeholder_text="e.g. TSX"); w["name"].insert(0, j.name); w["name"].grid(row=0, column=c, padx=3); c += 1
        pf = ctk.CTkFrame(f, fg_color="transparent"); pf.grid(row=0, column=c, padx=3); c += 1
        w["path"] = ctk.CTkEntry(pf, width=228, placeholder_text="C:\\RTA\\Scripts\\TSX.acsauto"); w["path"].insert(0, j.path); w["path"].pack(side="left")
        ctk.CTkButton(pf, text="…", width=34, command=lambda: browse(j.id)).pack(side="left", padx=(4, 0))
        w["every"] = ctk.CTkEntry(f, width=80, justify="center"); w["every"].insert(0, f"{j.every_min:g}"); w["every"].grid(row=0, column=c, padx=3); c += 1
        w["start"] = ctk.CTkEntry(f, width=78, justify="center", placeholder_text="now"); w["start"].insert(0, j.start_at); w["start"].grid(row=0, column=c, padx=3); c += 1
        w["stop"] = ctk.CTkEntry(f, width=78, justify="center", placeholder_text="never"); w["stop"].insert(0, j.stop_at); w["stop"].grid(row=0, column=c, padx=3); c += 1
        w["state"] = ctk.CTkLabel(f, text="Stopped", width=110, anchor="w", text_color=MUTED, font=ctk.CTkFont(weight="bold")); w["state"].grid(row=0, column=c, padx=3); c += 1
        w["next"] = ctk.CTkLabel(f, text="—", width=110, anchor="w"); w["next"].grid(row=0, column=c, padx=3); c += 1
        w["last"] = ctk.CTkLabel(f, text="—", width=160, anchor="w", text_color=MUTED); w["last"].grid(row=0, column=c, padx=3); c += 1
        bf = ctk.CTkFrame(f, fg_color="transparent"); bf.grid(row=0, column=c, padx=(3, 8))
        w["btn"] = ctk.CTkButton(bf, text="▶ Start", width=74, fg_color="#1f8a4c", hover_color="#187040", command=lambda: toggle(j.id)); w["btn"].pack(side="left")
        ctk.CTkButton(bf, text="Run", width=40, fg_color=("gray75", "#3a4150"), command=lambda: run_once(j.id)).pack(side="left", padx=3)
        ctk.CTkButton(bf, text="✕", width=28, fg_color="transparent", hover_color=("gray80", "#3a2a2a"), text_color=BAD, command=lambda: remove(j.id)).pack(side="left")
        for k in ("name", "path", "every", "start", "stop"):
            w[k].bind("<FocusOut>", lambda e, jid=j.id: on_edit(jid))
            w[k].bind("<Return>", lambda e, jid=j.id: on_edit(jid))
        rows[j.id] = w

    def new_job():
        j = Job(every_min=2.0)
        jobs.append(j)
        sched.set_jobs(jobs)
        add_row(j)
        persist()

    for j in jobs:
        add_row(j)

    # ---------- toolbar
    def start_all():
        for jid in rows:
            apply_row(jid)
        persist()
        sched.start_all()

    def stop_all():
        sched.stop_all()

    def set_all_stop():
        t = stop_all_entry.get().strip()
        try:
            parse_hhmm(t)
        except ValueError as e:
            messagebox.showwarning(APP_NAME, str(e)); return
        for jid, w in rows.items():
            w["stop"].delete(0, "end"); w["stop"].insert(0, t); apply_row(jid)
        persist()
        log(f"stop time {t or '(none)'} applied to all jobs — restart running jobs to use it")

    ctk.CTkButton(bar, text="＋ Add script", width=120, command=new_job).pack(side="left")
    ctk.CTkButton(bar, text="▶ Start all", width=110, fg_color="#1f8a4c", hover_color="#187040", command=start_all).pack(side="left", padx=8)
    ctk.CTkButton(bar, text="■ Stop all", width=110, fg_color="#b23b3b", hover_color="#8f2f2f", command=stop_all).pack(side="left")
    ctk.CTkLabel(bar, text="   Stop all at", text_color=MUTED).pack(side="left")
    stop_all_entry = ctk.CTkEntry(bar, width=80, justify="center", placeholder_text="23:00")
    stop_all_entry.pack(side="left", padx=6)
    ctk.CTkButton(bar, text="Apply", width=60, fg_color=("gray75", "#3a4150"), command=set_all_stop).pack(side="left")

    def toggle_theme():
        theme_var.set("light" if theme_var.get() == "dark" else "dark")
        ctk.set_appearance_mode(theme_var.get()); persist()

    ctk.CTkButton(bar, text="◐", width=34, fg_color=("gray75", "#3a4150"), command=toggle_theme).pack(side="right")
    ctk.CTkCheckBox(bar, text="Start all jobs when the app opens", variable=autostart_var, command=persist).pack(side="right", padx=12)

    # ---------- log
    logf = ctk.CTkFrame(root, fg_color="transparent")
    logf.pack(fill="x", padx=16, pady=(0, 6))
    ctk.CTkLabel(logf, text="Log", text_color=MUTED).pack(side="left")
    ctk.CTkButton(logf, text="Open log file", width=100, fg_color=("gray75", "#3a4150"),
                  command=lambda: os.startfile(LOG_FILE) if IS_WIN else None).pack(side="right")
    logbox = ctk.CTkTextbox(root, height=150, font=ctk.CTkFont(family="Consolas", size=12))
    logbox.pack(fill="x", padx=16, pady=(0, 10))
    logbox.configure(state="disabled")

    foot = ctk.CTkLabel(root, text="Times are this PC's clock (Cairo). Every = minutes, decimals allowed (0.5 = 30 s). "
                                   "Start/Stop at = 24h HH:MM or 11:00 PM; a stop time earlier than now means tomorrow.",
                        text_color=MUTED, font=ctk.CTkFont(size=11))
    foot.pack(fill="x", padx=18, pady=(0, 8))

    # ---------- refresh UI
    def refresh():
        while not log_q.empty():
            line = log_q.get_nowait()
            logbox.configure(state="normal"); logbox.insert("end", line + "\n")
            if int(logbox.index("end-1c").split(".")[0]) > 600:
                logbox.delete("1.0", "100.0")
            logbox.see("end"); logbox.configure(state="disabled")
        snap = sched.snapshot()
        for jid, w in rows.items():
            if jid not in snap:
                continue
            state, nxt, last, res, runs, stop_dt, active = snap[jid]
            label = state + (f" · {runs} run{'s' if runs!=1 else ''}" if runs and state in ("Running", "Waiting") else "")
            w["state"].configure(text=label, text_color=STATE_COLOR.get(state, MUTED))
            w["next"].configure(text=fmt_dt(nxt) if active else "—")
            w["last"].configure(text=(fmt_dt(last) + " · " + res) if last else res, text_color=BAD if res.startswith(("Error", "Exit")) else MUTED)
            if active:
                w["btn"].configure(text="■ Stop", fg_color="#b23b3b", hover_color="#8f2f2f")
            else:
                w["btn"].configure(text="▶ Start", fg_color="#1f8a4c", hover_color="#187040")
        clock_lbl.configure(text=datetime.now().strftime("%I:%M:%S %p").lstrip("0"))
        root.after(500, refresh)

    def on_close():
        active = [jid for jid, s in sched.snapshot().items() if s[6]]
        if active and not messagebox.askyesno(APP_NAME, f"{len(active)} job(s) are running. Closing stops them. Close anyway?"):
            return
        for jid in rows:
            apply_row(jid)
        persist()
        sched.shutdown()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    log(f"{APP_NAME} {APP_VERSION} ready · settings: {CONFIG_FILE}")
    if autostart_var.get():
        root.after(800, start_all)
    refresh()
    root.mainloop()


if __name__ == "__main__":
    run_app()
