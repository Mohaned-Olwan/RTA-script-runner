"""
"Live (web)" tab of RTA Script Runner: the RTA browser (dashboard + CMS web + Teams web automation),
plus automatic LAT / IEX / roster loading into the dashboard.
"""
from __future__ import annotations

import csv
import os
import threading
import time
from datetime import datetime
from pathlib import Path

import web_host as WH


def local_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home() / ".local" / "share")
    d = Path(base) / "RTA Runner" / "web"
    d.mkdir(parents=True, exist_ok=True)
    return d


def merge_lat(paths: list[str], out: str) -> str:
    """Voice + Chat LAT exports → one CSV (columns matched by header name)."""
    header: list[str] = []
    rows: list[dict] = []
    for p in paths:
        with open(p, newline="", encoding="utf-8-sig", errors="replace") as f:
            r = csv.reader(f)
            h = None
            for line in r:
                if h is None:
                    if any(str(c).strip().lower() == "forecast name" for c in line):
                        h = [str(c).strip() for c in line]
                        for c in h:
                            if c and c not in header:
                                header.append(c)
                    continue
                if not any(str(c).strip() for c in line):
                    continue
                rows.append({h[i]: line[i] for i in range(min(len(h), len(line))) if h[i]})
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        for d in rows:
            w.writerow([d.get(c, "") for c in header])
    return out


def ago(t):
    if not t:
        return "never"
    s = int(time.time() - t)
    return f"{s}s ago" if s < 60 else f"{s // 60}m ago" if s < 3600 else f"{s // 3600}h {s % 3600 // 60}m ago"


class LiveTab:
    def __init__(self, ctk, root, parent, cfg: dict, persist, log, RP, messagebox, filedialog, lat_params, iex_params, colors):
        self.ctk, self.root, self.cfg, self.persist, self.log, self.RP = ctk, root, cfg, persist, log, RP
        self.mb, self.fd = messagebox, filedialog
        self.lat_params, self.iex_params = lat_params, iex_params      # callables → (kinds, folder, user, pw) / (folder, user, pw)
        self.GOOD, self.WARN, self.BAD, self.MUTED = colors
        self.host = WH.WebHost(local_dir(), log=lambda m: log("[RTA browser] " + m))
        self.host.on_ready.append(self._on_browser_ready)
        self.busy = {"lat": False, "iex": False, "roster": False}
        self.last = {"lat": cfg.get("live_last_lat", 0), "iex": cfg.get("live_last_iex", 0), "roster": 0}
        self.roster_sig = None
        self.roster_day = None
        self.flags = {"lat": False, "iex": False, "roster": False, "roster_path": ""}   # plain copies for worker threads
        self._build(parent)
        self._sync_flags()
        threading.Thread(target=self._auto_loop, name="rta-dayfiles", daemon=True).start()

    # ------------------------------------------------------------------ UI
    def _card(self, parent, title, sub):
        ctk = self.ctk
        f = ctk.CTkFrame(parent, fg_color=("white", "#242935"), corner_radius=12)
        f.pack(fill="x", padx=6, pady=6)
        ctk.CTkLabel(f, text=title, font=ctk.CTkFont(size=15, weight="bold")).grid(row=0, column=0, columnspan=10, sticky="w", padx=14, pady=(10, 0))
        ctk.CTkLabel(f, text=sub, text_color=self.MUTED, justify="left").grid(row=1, column=0, columnspan=10, sticky="w", padx=14, pady=(0, 8))
        return f

    def _btn(self, parent, text, cmd, color=None, width=130):
        kw = {"fg_color": color} if color else {"fg_color": ("gray75", "#3a4150")}
        if color == "green":
            kw = {"fg_color": "#1f8a4c", "hover_color": "#187040"}
        if color == "red":
            kw = {"fg_color": "#b23b3b", "hover_color": "#8f2f2f"}
        return self.ctk.CTkButton(parent, text=text, width=width, command=cmd, **kw)

    def _build(self, parent):
        ctk, cfg = self.ctk, self.cfg
        sc = ctk.CTkScrollableFrame(parent, fg_color="transparent")
        sc.pack(fill="both", expand=True)

        # --- browser
        b = self._card(sc, "RTA browser", "Its own Edge window: the dashboard (same tabs + ⚙ Automation) and the CMS web / Teams web tabs it works in.\n"
                                           "Sign in to Teams there once — it stays signed in. It can sit behind other windows; just don't minimise it.")
        self.b_state = ctk.CTkLabel(b, text="● Closed", text_color=self.MUTED, font=ctk.CTkFont(size=14, weight="bold"))
        self.b_state.grid(row=2, column=0, sticky="w", padx=14, pady=(0, 6))
        bf = ctk.CTkFrame(b, fg_color="transparent"); bf.grid(row=3, column=0, columnspan=10, sticky="w", padx=14, pady=(0, 6))
        self.open_btn = self._btn(bf, "Open RTA browser", self.open_browser, "green", 150); self.open_btn.pack(side="left")
        self._btn(bf, "Show dashboard", lambda: self.host.show_dashboard("overview"), None, 130).pack(side="left", padx=6)
        self._btn(bf, "⚙ Automation settings", lambda: self.host.show_dashboard("auto"), None, 170).pack(side="left", padx=6)
        self._btn(bf, "Close browser", self.close_browser, "red", 120).pack(side="left", padx=6)
        self.autostart = ctk.BooleanVar(value=bool(cfg.get("live_autostart", True)))
        ctk.CTkCheckBox(b, text="Open the RTA browser when this app starts (automation that was running resumes by itself)",
                        variable=self.autostart, command=self._save).grid(row=4, column=0, columnspan=10, sticky="w", padx=14, pady=(2, 12))

        # --- automation
        a = self._card(sc, "Live automation", "CMS report links, CMS logins and Teams chats are set in the dashboard → ⚙ Automation tab.")
        ctk.CTkLabel(a, text="CMS web collector", font=ctk.CTkFont(weight="bold")).grid(row=2, column=0, sticky="w", padx=14)
        self.cms_state = ctk.CTkLabel(a, text="—", text_color=self.MUTED); self.cms_state.grid(row=2, column=1, sticky="w", padx=8)
        cf = ctk.CTkFrame(a, fg_color="transparent"); cf.grid(row=2, column=2, sticky="e", padx=14, pady=4)
        self._btn(cf, "Start", lambda: self._engine({"type": "auto:start", "what": "cms"}), "green", 80).pack(side="left")
        self._btn(cf, "Stop", lambda: self._engine({"type": "auto:stop", "what": "cms"}), "red", 80).pack(side="left", padx=6)
        ctk.CTkLabel(a, text="Teams web sender", font=ctk.CTkFont(weight="bold")).grid(row=3, column=0, sticky="w", padx=14)
        self.tm_state = ctk.CTkLabel(a, text="—", text_color=self.MUTED); self.tm_state.grid(row=3, column=1, sticky="w", padx=8)
        tf = ctk.CTkFrame(a, fg_color="transparent"); tf.grid(row=3, column=2, sticky="e", padx=14, pady=(4, 12))
        self._btn(tf, "Start", lambda: self._engine({"type": "auto:start", "what": "teams"}), "green", 80).pack(side="left")
        self._btn(tf, "Stop", lambda: self._engine({"type": "auto:stop", "what": "teams"}), "red", 80).pack(side="left", padx=6)
        self.pause_btn = self._btn(tf, "Pause", self.toggle_pause, None, 90); self.pause_btn.pack(side="left")
        a.grid_columnconfigure(1, weight=1)

        # --- day files
        d = self._card(sc, "Day files → dashboard (automatic)", "Pulls the files with the logins saved in the Reports tab and loads them into the dashboard. "
                                                                 "LAT = Voice/Chat as ticked in the Reports tab, today (EST).")
        self.lat_on = ctk.BooleanVar(value=bool(cfg.get("live_lat_on", False)))
        ctk.CTkCheckBox(d, text="LAT: pull every", variable=self.lat_on, command=self._save).grid(row=2, column=0, sticky="w", padx=14, pady=4)
        self.lat_every = ctk.CTkEntry(d, width=60, justify="center"); self.lat_every.insert(0, str(cfg.get("live_lat_every", 30)))
        self.lat_every.grid(row=2, column=1, sticky="w"); self.lat_every.bind("<FocusOut>", self._save)
        ctk.CTkLabel(d, text="min", text_color=self.MUTED).grid(row=2, column=2, sticky="w", padx=4)
        self.lat_lbl = ctk.CTkLabel(d, text="", text_color=self.MUTED); self.lat_lbl.grid(row=2, column=3, sticky="w", padx=10)
        self.lat_now = self._btn(d, "Pull now", lambda: self._start_job("lat"), None, 100); self.lat_now.grid(row=2, column=4, sticky="e", padx=14)

        self.iex_on = ctk.BooleanVar(value=bool(cfg.get("live_iex_on", False)))
        ctk.CTkCheckBox(d, text="IEX schedules: pull when the browser opens, then every", variable=self.iex_on, command=self._save).grid(row=3, column=0, sticky="w", padx=14, pady=4)
        self.iex_every = ctk.CTkEntry(d, width=60, justify="center"); self.iex_every.insert(0, str(cfg.get("live_iex_every", 4)))
        self.iex_every.grid(row=3, column=1, sticky="w"); self.iex_every.bind("<FocusOut>", self._save)
        ctk.CTkLabel(d, text="h", text_color=self.MUTED).grid(row=3, column=2, sticky="w", padx=4)
        self.iex_lbl = ctk.CTkLabel(d, text="", text_color=self.MUTED); self.iex_lbl.grid(row=3, column=3, sticky="w", padx=10)
        self.iex_now = self._btn(d, "Pull now", lambda: self._start_job("iex"), None, 100); self.iex_now.grid(row=3, column=4, sticky="e", padx=14)

        self.ros_on = ctk.BooleanVar(value=bool(cfg.get("live_roster_on", False)))
        ctk.CTkCheckBox(d, text="Roster file: load at start, each new day and when the file changes", variable=self.ros_on, command=self._save).grid(row=4, column=0, sticky="w", padx=14, pady=4)
        rf = ctk.CTkFrame(d, fg_color="transparent"); rf.grid(row=5, column=0, columnspan=4, sticky="w", padx=40, pady=(0, 12))
        self.ros_path = ctk.CTkEntry(rf, width=420, placeholder_text=r"C:\...\Roster.xlsx"); self.ros_path.insert(0, cfg.get("live_roster", ""))
        self.ros_path.pack(side="left"); self.ros_path.bind("<FocusOut>", self._save)
        self._btn(rf, "…", self._pick_roster, None, 34).pack(side="left", padx=4)
        self.ros_lbl = ctk.CTkLabel(d, text="", text_color=self.MUTED); self.ros_lbl.grid(row=4, column=3, sticky="w", padx=10)
        self.ros_now = self._btn(d, "Load now", lambda: self._start_job("roster"), None, 100); self.ros_now.grid(row=4, column=4, sticky="e", padx=14)
        d.grid_columnconfigure(3, weight=1)

        # --- engine log
        lg = self._card(sc, "Automation log", "What the CMS collector and Teams sender did (newest at the bottom).")
        self.logbox = ctk.CTkTextbox(lg, height=230, font=ctk.CTkFont(family="Consolas", size=12))
        self.logbox.grid(row=2, column=0, columnspan=10, sticky="ew", padx=14, pady=(0, 12)); self.logbox.configure(state="disabled")
        lg.grid_columnconfigure(0, weight=1)
        self._last_log = None

    # ------------------------------------------------------------------ actions
    def _sync_flags(self):   # UI thread only
        self.flags = {"lat": bool(self.lat_on.get()), "iex": bool(self.iex_on.get()), "roster": bool(self.ros_on.get()),
                      "roster_path": self.ros_path.get().strip().strip('"')}

    def _save(self, *_):
        c = self.cfg
        c["live_autostart"] = bool(self.autostart.get())
        c["live_lat_on"], c["live_iex_on"], c["live_roster_on"] = bool(self.lat_on.get()), bool(self.iex_on.get()), bool(self.ros_on.get())
        for k, e, dflt in (("live_lat_every", self.lat_every, 30), ("live_iex_every", self.iex_every, 4)):
            try:
                c[k] = max(5 if k == "live_lat_every" else 1, float(e.get().strip()))
            except ValueError:
                c[k] = dflt
        c["live_roster"] = self.ros_path.get().strip().strip('"')
        c["live_last_lat"], c["live_last_iex"] = self.last["lat"], self.last["iex"]
        self.persist()

    def _pick_roster(self):
        p = self.fd.askopenfilename(title="Roster file", filetypes=[("Excel / CSV", "*.xlsx *.xlsb *.xls *.csv"), ("All files", "*.*")])
        if p:
            self.ros_path.delete(0, "end"); self.ros_path.insert(0, os.path.normpath(p)); self._save()

    def open_browser(self):
        self.host.open()

    def close_browser(self):
        st = self.host.status()
        running = (st["cfg"].get("running") or {})
        if (running.get("cms") or running.get("teams")) and not self.mb.askyesno("RTA Script Runner", "CMS/Teams automation is running in the RTA browser.\n"
                                                                                  "Closing the browser pauses it until you open it again. Close?"):
            return
        self.host.close()

    def _engine(self, msg):
        if self.host.state != "open":
            self.mb.showinfo("RTA Script Runner", "Open the RTA browser first."); return

        def go():
            try:
                self.host.send(msg, timeout=30)
            except Exception as e:  # noqa: BLE001
                self.log(f"[RTA browser] {e}")
        threading.Thread(target=go, daemon=True).start()

    def toggle_pause(self):
        st = self.host.status()
        self.set_paused(not (st["cfg"].get("teams") or {}).get("paused", False))

    def set_paused(self, on: bool):
        if self.host.state == "open":
            self._engine({"type": "auto:pause", "on": bool(on)})

    def start(self):
        if self.autostart.get():
            self.root.after(600, self.host.open)

    def shutdown(self):
        self._save()
        self.host.shutdown()

    # ------------------------------------------------------------------ day files
    def _on_browser_ready(self):          # host thread — new browser session: IEX + roster right away
        self.roster_sig = None
        if self.flags["iex"]:
            self.last["iex"] = 0

    def _start_job(self, kind):
        if self.busy[kind]:
            return
        if self.host.state != "open":
            self.mb.showinfo("RTA Script Runner", "Open the RTA browser first."); return
        threading.Thread(target=self._job, args=(kind, True), daemon=True).start()

    def _job(self, kind, manual=False):
        if self.busy[kind]:
            return
        self.busy[kind] = True
        try:
            if kind == "lat":
                kinds, folder, user, pw = self.lat_params()
                if not kinds or not user or not pw:
                    raise RuntimeError("tick Voice/Chat and save the LAT login in the Reports tab first")
                paths = self.RP.run_lat(kinds, self.RP.today_est(), folder, user, pw, self.log)
                merged = merge_lat(paths, str(local_dir() / "LAT_for_dashboard.csv")) if len(paths) > 1 else paths[0]
                self.host.load_day_files("lat", [merged])
                self.log(f"[Day files] LAT loaded into the dashboard ({', '.join(kinds)})")
            elif kind == "iex":
                folder, user, pw = self.iex_params()
                if not user or not pw:
                    raise RuntimeError("save the IEX login in the Reports tab first")
                d = self.RP.today_est()
                path = self.RP.run_iex(d, d, folder, user, pw, self.log)
                self.host.load_day_files("sched", [path])
                self.log("[Day files] IEX schedules loaded into the dashboard")
            else:
                p = self.flags["roster_path"]
                if not p or not os.path.exists(p):
                    raise RuntimeError("roster file not found")
                self.host.load_day_files("roster", [p])
                st = os.stat(p)
                self.roster_sig = (p, st.st_mtime, st.st_size)
                self.roster_day = datetime.now().date()
                self.log("[Day files] roster loaded into the dashboard")
            self.last[kind] = time.time()
            self.cfg["live_last_" + kind] = self.last[kind]
            self.err = None
        except Exception as e:  # noqa: BLE001
            self.log(f"[Day files] {kind.upper()} ✗ {e}")
            if kind != "roster":
                self.last[kind] = time.time() - max(0, self._every(kind) - 600)   # retry in ~10 min
        finally:
            self.busy[kind] = False

    def _every(self, kind):
        try:
            return float(self.cfg.get("live_lat_every", 30)) * 60 if kind == "lat" else float(self.cfg.get("live_iex_every", 4)) * 3600
        except Exception:
            return 1800

    def _auto_loop(self):
        while True:
            time.sleep(15)
            try:
                if self.host.state != "open":
                    continue
                now = time.time()
                f = self.flags
                if f["lat"] and not self.busy["lat"] and now - self.last["lat"] >= self._every("lat"):
                    threading.Thread(target=self._job, args=("lat",), daemon=True).start()
                if f["iex"] and not self.busy["iex"] and now - self.last["iex"] >= self._every("iex"):
                    threading.Thread(target=self._job, args=("iex",), daemon=True).start()
                if f["roster"] and not self.busy["roster"]:
                    p = f["roster_path"]
                    if p and os.path.exists(p):
                        st = os.stat(p)
                        if self.roster_sig != (p, st.st_mtime, st.st_size) or self.roster_day != datetime.now().date():
                            threading.Thread(target=self._job, args=("roster",), daemon=True).start()
            except Exception:
                pass

    # ------------------------------------------------------------------ refresh (UI thread)
    def refresh(self):
        self._sync_flags()
        st = self.host.status()
        s = st["state"]
        txt = {"open": f"● Open · {st['tabs']} tabs", "starting": "● Starting Edge…", "closed": "● Closed", "error": f"● Error: {st['error']}"}.get(s, s)
        self.b_state.configure(text=txt, text_color={"open": self.GOOD, "starting": self.WARN, "error": self.BAD}.get(s, self.MUTED))
        cfg, rt = st["cfg"], st["rt"]
        running = cfg.get("running") or {}
        reps = [r for r in ((cfg.get("cms") or {}).get("reports") or []) if r.get("enabled")]
        exp = rt.get("exp") or {}
        ok = sum(1 for r in reps if (exp.get(r["id"]) or {}).get("state") == "ok")
        bad = sum(1 for r in reps if (exp.get(r["id"]) or {}).get("state") in ("error", "logged out"))
        last_at = max([(exp.get(r["id"]) or {}).get("at") or 0 for r in reps] or [0]) / 1000
        self.cms_state.configure(text=("Running" if running.get("cms") else "Stopped") + f" · {len(reps)} report(s) · ✓ {ok}" + (f" · ✗ {bad}" if bad else "")
                                 + (f" · last data {ago(last_at)}" if last_at else ""),
                                 text_color=(self.BAD if bad else self.GOOD) if running.get("cms") else self.MUTED)
        tms = [t for t in ((cfg.get("teams") or {}).get("targets") or []) if t.get("enabled", True)]
        paused = (cfg.get("teams") or {}).get("paused")
        send = rt.get("send") or {}
        lasts = sorted([(v.get("tried") or 0, v.get("result") or "") for v in send.values()], reverse=True)
        lr = lasts[0][1] if lasts else ""
        self.tm_state.configure(text=("PAUSED" if paused and running.get("teams") else "Running" if running.get("teams") else "Stopped") + f" · {len(tms)} chat(s)"
                                + (f" · last: {lr[:70]}" if lr else ""),
                                text_color=self.WARN if paused else (self.BAD if lr.startswith("Error") else self.GOOD) if running.get("teams") else self.MUTED)
        self.pause_btn.configure(text="Resume" if paused else "Pause", fg_color="#e0a000" if paused else ("gray75", "#3a4150"))
        self.lat_lbl.configure(text="pulling…" if self.busy["lat"] else f"last: {ago(self.last['lat'])}")
        self.iex_lbl.configure(text="pulling… (2–5 min)" if self.busy["iex"] else f"last: {ago(self.last['iex'])}")
        self.ros_lbl.configure(text="loading…" if self.busy["roster"] else f"last: {ago(self.last['roster'])}")
        lines = st["log"]
        key = (len(lines), lines[-1]["t"] if lines else 0)
        if key != self._last_log:
            self._last_log = key
            self.logbox.configure(state="normal"); self.logbox.delete("1.0", "end")
            for l in lines:
                t = datetime.fromtimestamp(l["t"] / 1000).strftime("%H:%M:%S")
                self.logbox.insert("end", f"{t}  {l['msg']}\n")
            self.logbox.see("end"); self.logbox.configure(state="disabled")
