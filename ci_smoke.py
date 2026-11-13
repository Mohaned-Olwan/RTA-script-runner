"""CI smoke test on the Windows build machine: open the RTA window with the bundled browser and talk to the dashboard."""
import os, sys, tempfile, time
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = "0"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import web_host as W

logs = []
h = W.WebHost(tempfile.mkdtemp(prefix="rta_ci_"), log=lambda m: (logs.append(m), print("HOST:", m, flush=True)), app_mode=True)
h.app_handler = lambda op, a: {"version": "ci"} if op == "app.state" else None
h.open()
t0 = time.time()
while time.time() - t0 < 120 and not (h.state == "open" and h.dash is not None):
    time.sleep(1)
print("state:", h.state, h.error, "dash:", h.dash.url if h.dash else None, flush=True)
ok = False
if h.dash is not None:
    async def probe():
        return await h.dash.evaluate("async () => [location.pathname, typeof window.rtaHost, JSON.stringify(await window.rtaApp.call('app.state', {})), document.querySelectorAll('.tab').length]")
    for _ in range(20):
        try:
            r = h.call(probe(), timeout=30)
            print("probe:", r, flush=True)
            ok = r[0] == "/dashboard.html" and r[1] == "function" and "ci" in r[2] and r[3] >= 8
            if ok:
                break
        except Exception as e:  # noqa: BLE001
            print("probe error:", e, flush=True)
        time.sleep(2)
h.shutdown()
print("SMOKE", "PASS" if ok else "FAIL", flush=True)
sys.exit(0 if ok else 1)
