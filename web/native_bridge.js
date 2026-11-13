// RTA app v4: inside the app's own window (pywebview / WebView2) the bridge to Python is window.pywebview.api.rpc.
// (In the browser-window builds Playwright provides window.rtaHost itself and this file does nothing.)
(() => {
  if (typeof window.rtaHost === 'function') return;
  window.__RTA_NATIVE = true;
  let api = null;
  const ready = new Promise(res => {
    const ok = () => { if (window.pywebview && window.pywebview.api && window.pywebview.api.rpc) { api = window.pywebview.api; res(); return true; } return false; };
    if (!ok()) { window.addEventListener('pywebviewready', ok); const t = setInterval(() => { if (ok()) clearInterval(t); }, 100); }
  });
  window.rtaHost = raw => ready.then(() => api.rpc(raw));
})();
