"""
RTA Script Runner — live web automation host.

Opens ONE Edge window with its own profile (driven by Playwright) that holds:
  * the RTA dashboard (same tabs as the HTML/extension, incl. the ⚙ Automation tab) — served from 127.0.0.1
  * the CMS web report tabs and the Teams web chat tabs the automation engine opens

The automation engine is the same JavaScript as the Edge extension (background.js); this module provides the
browser services it needs (tabs, running code in pages, storage) through window.rtaHost.
Pages are kept "awake" (no background throttling) so sending works while the window is behind other windows.
"""
from __future__ import annotations

import asyncio
import fnmatch
import http.server
import json
import os
import sys
import threading
import time
from pathlib import Path

PORT = 47811
ORIGIN = f"http://127.0.0.1:{PORT}"
DASH_URL = ORIGIN + "/dashboard.html"


def web_dir() -> Path:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return Path(base) / "web"


# ----------------------------------------------------------------------------- local web server for the dashboard
LAST_BYE = [0.0]      # time the dashboard page said goodbye (window closing or reloading)


class _Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {"": "application/octet-stream", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                      ".mjs": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
                      ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon"}

    def log_message(self, *a):
        pass

    def do_POST(self):
        if self.path.startswith("/bye"):
            LAST_BYE[0] = time.time()
            self.send_response(204); self.end_headers()
            return
        self.send_response(404); self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def start_server(root: Path) -> http.server.ThreadingHTTPServer:
    handler = lambda *a, **k: _Handler(*a, directory=str(root), **k)   # noqa: E731
    class _Srv(http.server.ThreadingHTTPServer):
        allow_reuse_address = not sys.platform.startswith("win")   # on Windows it would let two copies share the port
    srv = _Srv(("127.0.0.1", PORT), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ----------------------------------------------------------------------------- storage (chrome.storage.local)
class Store:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        try:
            self.data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            self.data = {}
        self.dirty = False

    def get(self, keys):
        with self.lock:
            if keys is None:
                return dict(self.data)
            if isinstance(keys, str):
                keys = [keys]
            if isinstance(keys, dict):
                return {k: self.data.get(k, v) for k, v in keys.items()}
            return {k: self.data[k] for k in keys if k in self.data}

    def set(self, obj: dict):
        with self.lock:
            self.data.update(obj or {})
            self.dirty = True

    def remove(self, keys):
        with self.lock:
            for k in ([keys] if isinstance(keys, str) else keys or []):
                self.data.pop(k, None)
            self.dirty = True

    def flush(self):
        with self.lock:
            if not self.dirty:
                return
            raw = json.dumps(self.data)
            self.dirty = False
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(raw, encoding="utf-8")
        tmp.replace(self.path)


# ----------------------------------------------------------------------------- the host
class WebHost:
    def __init__(self, data_dir: Path, log=print, browser_exe: str | None = None, app_mode: bool = False):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.profile = self.data_dir / "BrowserProfile"
        self.store = Store(self.data_dir / "web_store.json")
        self.log = log
        self.browser_exe = browser_exe or os.environ.get("RTA_BROWSER_EXE")
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.pw = None
        self.ctx = None
        self.dash = None
        self.pages: dict[int, object] = {}
        self.meta: dict[int, dict] = {}
        self.ids: dict[int, int] = {}          # id(page) -> tab id
        self.next_id = 100
        self.want_open = False
        self.quit = False
        self.state = "closed"                  # closed | starting | open | error
        self.error = ""
        self.server = None
        self.allow_front = False               # bring tabs to front when the engine asks (off: never steal focus)
        self.on_ready = []                     # callbacks (in host thread) after the dashboard is up
        self.app_mode = app_mode               # the dashboard window is the app (Edge --app window)
        self.app_handler = None                # callable(op, args) for "app.*" calls from the dashboard (runs in a worker thread)
        self.dialog_handler = None             # callable(kind, message, default) → bool / text, for dialogs on the dashboard
        self.on_user_close = None              # called when the user closed the app window
        self._internal = False                 # we are closing pages ourselves

    # ---------- thread plumbing
    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._run, name="rta-web", daemon=True)
        self.thread.start()

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._main())
        except Exception as e:  # noqa: BLE001
            self.state, self.error = "error", str(e)
            self.log(f"Web host stopped: {e}")

    def call(self, coro, timeout=60):
        """Run a coroutine in the host thread and wait for its result (from any thread)."""
        if not self.loop:
            raise RuntimeError("web host not started")
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def submit(self, coro):
        if self.loop:
            return asyncio.run_coroutine_threadsafe(coro, self.loop)

    # ---------- public API (thread-safe)
    def open(self):
        self.want_open = True
        self.start()

    def close(self):
        self.want_open = False
        if self.loop:
            self.submit(self._close_ctx())

    def shutdown(self):
        self.want_open = False
        self.quit = True
        try:
            self.store.flush()
        except Exception:
            pass
        if self.loop:
            try:
                self.call(self._close_ctx(), timeout=15)
            except Exception:
                pass

    def send(self, msg: dict, timeout=60):
        """Message to the automation engine (same messages the Automation tab sends)."""
        return self.call(self._send(msg), timeout=timeout)

    def show_dashboard(self, page_id: str | None = None):
        if self.loop:
            self.submit(self._show_dash(page_id))

    def load_day_files(self, kind: str, paths: list[str], timeout=120):
        return self.call(self._load_files(kind, paths), timeout=timeout)

    def status(self) -> dict:
        d = self.store.get(["rta_cfg_auto", "rta_rt", "rta_log"])
        return {"state": self.state, "error": self.error, "tabs": len(self.pages),
                "cfg": d.get("rta_cfg_auto") or {}, "rt": d.get("rta_rt") or {}, "log": (d.get("rta_log") or [])[-40:]}

    # ---------- main loop
    async def _main(self):
        from playwright.async_api import async_playwright
        self.server = start_server(web_dir())
        self.pw = await async_playwright().start()
        last_flush = 0.0
        while not self.quit:
            try:
                if self.want_open and self.ctx is None:
                    await self._launch()
                if self.ctx is not None and (self.dash is None or self.dash.is_closed()):
                    if self.app_mode:
                        if not self._user_closed():     # the app window vanished without the user closing it → restart the browser
                            self.log("RTA window lost — restarting it")
                            await self._close_ctx()
                    else:
                        await self._open_dash(restart=True)
            except Exception as e:  # noqa: BLE001  — never let the host stop; reset and try again
                self.log(f"browser problem: {str(e).splitlines()[0][:200]} — restarting it in 10 s")
                try:
                    await self._close_ctx()
                except Exception:
                    pass
                self.ctx, self.dash = None, None
                await asyncio.sleep(10)
            if time.time() - last_flush > 3:
                last_flush = time.time()
                try:
                    self.store.flush()
                except Exception as e:  # noqa: BLE001
                    self.log(f"could not save web state: {e}")
            await asyncio.sleep(1.5)
        await self._close_ctx()
        await self.pw.stop()
        self.server.shutdown()

    async def _launch(self):
        self.state, self.error = "starting", ""
        try:
            args = ["--start-maximized", "--no-default-browser-check"]
            if os.environ.get("RTA_DEBUG_PORT"):      # tests only
                args.append(f"--remote-debugging-port={os.environ['RTA_DEBUG_PORT']}")
            ignore = ["--enable-automation"]
            kw = dict(user_data_dir=str(self.profile), headless=False, no_viewport=True, accept_downloads=True,
                      args=args, ignore_default_args=ignore,
                      chromium_sandbox=sys.platform.startswith("win"))   # keep the sandbox on Windows (no "--no-sandbox" warning bar)
            import browser_util
            kw.update(browser_util.launch_kwargs())
            self.ctx = await self.pw.chromium.launch_persistent_context(**kw)
        except Exception as e:  # noqa: BLE001
            self.ctx = None
            self.state, self.error = "error", str(e).splitlines()[0][:300]
            self.log(f"RTA browser: could not open the browser — {self.error}")
            await asyncio.sleep(10)
            return
        self.ctx.on("close", lambda *_: self._on_ctx_close())
        self.ctx.on("page", self._register)
        await self.ctx.add_init_script(path=str(web_dir() / "init.js"))
        self.pages.clear(); self.meta.clear(); self.ids.clear()
        # the dashboard ↔ app bridge, for every page of OUR origin only (CMS / Teams pages are refused)
        await self.ctx.expose_binding("rtaHost", self._rpc_binding)
        if self.app_mode:
            await self._open_app_window()
        else:
            first = self.ctx.pages[0] if self.ctx.pages else None
            await self._open_dash(reuse=first)
        self.state = "open"
        self.log("RTA browser open — sign in to Teams there once (it stays signed in)")
        for cb in list(self.on_ready):
            try:
                cb()
            except Exception:
                pass

    def _on_ctx_close(self):
        self.ctx, self.dash = None, None
        self.pages.clear(); self.meta.clear(); self.ids.clear()
        self.state = "closed"
        if self._internal or self.quit:
            return
        if self.app_mode and self._user_closed():
            self.want_open = False
            if self.on_user_close:
                self.on_user_close()
            return
        if self.want_open:
            self.log("RTA browser was closed — reopening it (use 'Close browser' in the app to stop)")

    def _user_closed(self):
        return time.time() - LAST_BYE[0] < 10

    def _on_dash_close(self, page):
        if self._internal or self.quit or page is not self.dash:
            return
        if self.app_mode and self._user_closed():      # the user closed the RTA window → quit the app
            self.want_open = False
            if self.on_user_close:
                self.on_user_close()

    async def _close_ctx(self):
        self._internal = True
        ctx, self.ctx = self.ctx, None
        self.dash = None
        if ctx:
            try:
                await ctx.close()
            except Exception:
                pass
        self.state = "closed"
        self._internal = False

    async def _rpc_binding(self, source, raw):
        try:
            url = source["frame"].url
        except Exception:
            url = ""
        if not url.startswith(ORIGIN + "/"):
            return json.dumps({"err": "not allowed"})
        return await self._rpc(raw)

    async def _open_app_window(self):
        """App mode: the first (normal) window becomes the worker window (CMS / Teams tabs); the RTA window is a popup
        window (no tabs, no address bar to type in) opened from it by a real click, so Edge doesn't block it."""
        p0 = self.ctx.pages[0] if self.ctx.pages else await self.ctx.new_page()
        try:
            await p0.goto(ORIGIN + "/worker.html", wait_until="load", timeout=30000)
            await p0.evaluate("""() => { const b = document.createElement('button'); b.id = '__rta_open'; b.textContent = 'Open the RTA window';
              b.style.cssText = 'position:fixed;left:24px;top:24px;z-index:99999;padding:14px 22px;font:16px Segoe UI,Arial;border-radius:10px;border:0;background:#2a78d6;color:#fff;cursor:pointer';
              b.onclick = () => { window.open('/dashboard.html', 'rta_app', 'popup=yes,left=0,top=0,width=' + screen.availWidth + ',height=' + screen.availHeight); };
              document.body.appendChild(b); }""")
            async with p0.expect_popup(timeout=20000) as pi:
                await p0.click("#__rta_open", timeout=10000)
            dash = await pi.value
            try:
                await dash.wait_for_load_state("load", timeout=30000)
            except Exception:
                pass
            self._adopt_dash(dash, already_loaded=True)
            self.log("RTA window open (the other window holds the CMS / Teams tabs — keep it open, it can sit behind)")
            return
        except Exception as e:  # noqa: BLE001
            self.log(f"couldn't open the RTA popup window ({str(e).splitlines()[0][:120]}) — using a normal window")
        try:
            await p0.goto(DASH_URL, wait_until="load", timeout=60000)
            self._adopt_dash(p0, already_loaded=True)
        except Exception as e:  # noqa: BLE001
            self.log(f"dashboard did not load: {e}")

    async def _attach_app_window(self):
        """App mode: Edge opened ONE app window on loading.html; that page switches itself to the dashboard as soon as the
        bridge exists. Find that page (whenever Edge reports it) and adopt it as the dashboard."""
        end = time.time() + 45
        nudged = False
        while time.time() < end and self.ctx is not None:
            pages = [p for p in self.ctx.pages if not p.is_closed()]
            dash = next((p for p in pages if p.url.startswith(DASH_URL)), None)
            if dash:
                try:
                    await dash.wait_for_load_state("load", timeout=30000)
                except Exception:
                    pass
                self._adopt_dash(dash, already_loaded=True)
                return
            if not nudged and time.time() > end - 30:      # 15 s and still on the loading page → push it
                for p in pages:
                    if p.url.startswith(ORIGIN + "/loading"):
                        nudged = True
                        try:
                            await p.goto(DASH_URL, wait_until="load", timeout=30000)
                        except Exception:
                            pass
            await asyncio.sleep(0.4)
        self.log("RTA window did not show up — opening the dashboard in a normal window")
        await self._open_dash()

    def _adopt_dash(self, p, already_loaded=False):
        tid = self._register(p)
        self.meta[tid]["pinned"] = True
        self.meta[tid]["status"] = "complete"
        self.dash = p
        loads = {"n": 1 if already_loaded else 0}

        def on_dash_load(*_):   # the dashboard was reloaded (F5) → the engine restarts → drop its old tabs
            loads["n"] += 1
            LAST_BYE[0] = 0.0
            if loads["n"] > 1:
                asyncio.ensure_future(self._close_others())
        p.on("domcontentloaded", on_dash_load)
        p.on("dialog", lambda d: asyncio.ensure_future(self._dialog(d)))
        p.on("close", lambda pg: self._on_dash_close(pg))
        LAST_BYE[0] = 0.0

    async def _open_dash(self, reuse=None, restart=False):
        if restart:   # engine restarts with a fresh page → its old tabs are unknown to it: close them
            if self.app_mode and self._user_closed():
                return
            for tid, p in list(self.pages.items()):
                try:
                    await p.close()
                except Exception:
                    pass
            self.pages.clear(); self.meta.clear(); self.ids.clear()
            self.log("Dashboard page reopened — automation restarted")
        p = reuse if reuse and not reuse.is_closed() else await self.ctx.new_page()
        self._adopt_dash(p)
        try:
            await p.goto(DASH_URL, wait_until="load", timeout=60000)
        except Exception as e:  # noqa: BLE001
            self.log(f"dashboard did not load: {e}")

    async def _dialog(self, d):
        try:
            if not self.dialog_handler:
                await (d.accept() if d.type == "beforeunload" else d.dismiss())
                return
            loop = asyncio.get_running_loop()
            res = await loop.run_in_executor(None, self.dialog_handler, d.type, d.message, d.default_value)
            if d.type == "prompt":
                await (d.accept(res) if res is not None else d.dismiss())
            else:
                await (d.accept() if res else d.dismiss())
        except Exception:
            try:
                await d.dismiss()
            except Exception:
                pass

    async def _close_others(self):
        for tid, p in list(self.pages.items()):
            if p is not self.dash:
                try:
                    await p.close()
                except Exception:
                    pass
        self.log("Dashboard reloaded — automation restarted with fresh tabs")

    # ---------- tabs
    def _register(self, page):
        key = id(page)
        if key in self.ids:
            return self.ids[key]
        tid = self.next_id; self.next_id += 1
        self.ids[key] = tid
        self.pages[tid] = page
        self.meta[tid] = {"status": "loading", "title": "", "nav": 0, "pinned": False}

        def on_load(*_):
            m = self.meta.get(tid)
            if m is not None:
                m["status"] = "complete"

        def on_close(*_):
            self.pages.pop(tid, None); self.meta.pop(tid, None); self.ids.pop(key, None)
        page.on("load", on_load)
        page.on("close", on_close)
        return tid

    def _page(self, tid):
        p = self.pages.get(int(tid)) if tid is not None else None
        if not p or p.is_closed():
            raise RuntimeError(f"No tab with id: {tid}.")
        return p

    async def _tab(self, tid):
        p = self._page(tid)
        m = self.meta[int(tid)]
        try:
            m["title"] = await asyncio.wait_for(p.title(), 2)
        except Exception:
            pass
        return {"id": int(tid), "windowId": 1, "status": m["status"], "url": p.url, "title": m.get("title", ""),
                "active": p is self.dash, "discarded": False, "pinned": m.get("pinned", False), "index": 0}

    async def _goto(self, tid, url):
        p = self._page(tid)
        m = self.meta[tid]
        m["status"] = "loading"; m["nav"] += 1; n = m["nav"]
        try:
            await p.goto(url, wait_until="load", timeout=90000)
        except Exception:
            pass
        if tid in self.meta and self.meta[tid]["nav"] == n:
            self.meta[tid]["status"] = "complete"

    async def _new_tab(self, url):
        if self.ctx is None:
            raise RuntimeError("No window with id: 1.")
        p = await self.ctx.new_page()
        tid = self._register(p)
        if url and url != "about:blank":
            self.meta[tid]["status"] = "loading"
            asyncio.ensure_future(self._goto(tid, url))
        else:
            self.meta[tid]["status"] = "complete"
        if self.dash and not self.dash.is_closed():   # keep the dashboard in front, not the new tab
            try:
                await self.dash.bring_to_front()
            except Exception:
                pass
        return tid

    # ---------- RPC from the page
    async def _rpc(self, raw: str) -> str:
        try:
            m = json.loads(raw)
            v = await self._op(m.get("op"), m.get("a"))
            return json.dumps({"v": v})
        except Exception as e:  # noqa: BLE001
            return json.dumps({"err": str(e).splitlines()[0][:400] if str(e) else e.__class__.__name__})

    async def _op(self, op, a):
        if op == "storage.get":
            return self.store.get(a)
        if op == "storage.set":
            self.store.set(a); return None
        if op == "storage.remove":
            self.store.remove(a); return None
        if op == "tabs.create":
            return await self._tab(await self._new_tab((a or {}).get("url")))
        if op == "tabs.get":
            return await self._tab(a)
        if op == "tabs.update":
            tid, props = a
            self._page(tid)
            if props.get("url"):
                self.meta[int(tid)]["status"] = "loading"
                asyncio.ensure_future(self._goto(int(tid), props["url"]))
            if props.get("pinned") is not None:
                self.meta[int(tid)]["pinned"] = bool(props["pinned"])
            if props.get("active") and self.allow_front:
                try:
                    await self._page(tid).bring_to_front()
                except Exception:
                    pass
            return await self._tab(tid)
        if op == "tabs.remove":
            for tid in (a if isinstance(a, list) else [a]):
                p = self.pages.get(int(tid))
                if p and p is not self.dash:
                    try:
                        await p.close()
                    except Exception:
                        pass
            return None
        if op == "tabs.query":
            q = a or {}
            out = []
            for tid in list(self.pages):
                try:
                    t = await self._tab(tid)
                except Exception:
                    continue
                if q.get("url") and not fnmatch.fnmatch(t["url"], q["url"]):
                    continue
                out.append(t)
            return out
        if op == "windows.create":
            tid = await self._new_tab((a or {}).get("url"))
            return {"id": 1, "state": "normal", "focused": False, "tabs": [await self._tab(tid)]}
        if op == "windows.get":
            if self.ctx is None:
                raise RuntimeError("No window with id: 1.")
            return {"id": 1, "state": "normal", "focused": False}
        if op == "windows.getAll":
            return [{"id": 1, "state": "normal"}] if self.ctx else []
        if op == "windows.update":
            wid, props = a
            if props.get("focused"):   # "Show worker window": bring a CMS/Teams tab to the front
                for tid, p in self.pages.items():
                    if p is not self.dash and not p.is_closed():
                        try:
                            await p.bring_to_front()
                        except Exception:
                            pass
                        break
            return {"id": 1, "state": "normal"}
        if op.startswith("app."):
            if not self.app_handler:
                raise RuntimeError("not running inside the RTA app")
            return await asyncio.get_running_loop().run_in_executor(None, self.app_handler, op, a)
        if op == "exec":
            p = self._page(a["tabId"])
            expr = f"({a['src']})(...{json.dumps(a.get('args') or [])})"
            return await asyncio.wait_for(p.evaluate(expr), 60)
        raise RuntimeError(f"unknown op {op}")

    # ---------- app → dashboard
    async def _send(self, msg):
        if not self.dash or self.dash.is_closed():
            raise RuntimeError("the RTA browser is not open")
        return await self.dash.evaluate("m => window.rtaApp ? window.rtaApp.send(m) : null", msg)

    async def _show_dash(self, page_id=None):
        if not self.dash or self.dash.is_closed():
            return
        try:
            await self.dash.bring_to_front()
            if page_id:
                await self.dash.evaluate("id => { const t = document.querySelector(`.tab[data-page=${id}]`); if (t) t.click(); }", page_id)
        except Exception:
            pass

    async def _load_files(self, kind, paths):
        if not self.dash or self.dash.is_closed():
            raise RuntimeError("the RTA browser is not open")
        await self.dash.set_input_files(f"input[type=file][data-kind={kind}]", paths)
        await asyncio.sleep(2.5)
        return True
