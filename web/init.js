// RTA app init script (all pages of the RTA browser except the dashboard)
if (location.origin !== 'http://127.0.0.1:47811') {
(() => { try {
  if (/\/dl\/launcher\//i.test(location.pathname)) {
    const r = new URLSearchParams(location.search).get('url') || '';
    if (r.startsWith('/') && !r.startsWith('//')) location.replace(location.origin + r);
  } } catch (e) { } })();
(() => { const isApp = u => /^(msteams|ms-teams|ms-teams-launcher|ms-launcher):/i.test(String(u || ''));
  if (window.navigation) navigation.addEventListener('navigate', e => { if (isApp(e.destination && e.destination.url)) e.preventDefault(); }); })();
// RTA worker-window guard (page world): same as teams_guard.js for launch attempts made through iframes / window.open.
(() => {
  if (window.__rtaGuardMain) return; window.__rtaGuardMain = true;
  const de = document.documentElement;
  const isApp = u => /^(msteams|ms-teams|ms-teams-launcher|ms-launcher):/i.test(String(u || ''));
  const active = () => !de || de.getAttribute('data-rta-worker') !== '0';     // block unless we know it's NOT the worker window
  const note = () => { if (de) de.setAttribute('data-rta-blocked', String(+(de.getAttribute('data-rta-blocked') || 0) + 1)); };
  try {
    const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', { configurable: true, enumerable: d.enumerable, get: d.get,
      set(v) { if (isApp(v) && active()) { note(); return; } return d.set.call(this, v); } });
    const sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) { if (this instanceof HTMLIFrameElement && /^src$/i.test(n) && isApp(v) && active()) { note(); return; } return sa.call(this, n, v); };
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) {
      if (!active() || !n || n.nodeType !== 1) continue;
      for (const e of [n, ...(n.querySelectorAll ? n.querySelectorAll('iframe,meta') : [])]) {
        if (e.tagName === 'IFRAME' && isApp(e.getAttribute('src'))) { e.removeAttribute('src'); e.remove(); note(); }
        if (e.tagName === 'META' && /refresh/i.test(e.httpEquiv || '') && /url\s*=\s*['"]?(msteams|ms-teams)/i.test(e.content || '')) { e.remove(); note(); }
      }
    } }).observe(document, { childList: true, subtree: true });
    const wo = window.open;
    window.open = function (u) { if (isApp(u) && active()) { note(); return null; } return wo.apply(this, arguments); };
  } catch (e) { }
})();

// RTA "act as if on top" (page world, Teams tabs of the RTA worker window only).
// Edge hides tabs whose window is behind other windows or minimised: it reports document.hidden, pauses
// requestAnimationFrame and slows timers — Teams then drops pasted pictures. Here we make the page see itself
// as visible and run its timers/animation callbacks from a worker thread that Edge doesn't slow down.
(() => {
  if (window.__rtaAwake) return; window.__rtaAwake = true;
  const de = document.documentElement;
  const on = () => !de || de.getAttribute('data-rta-worker') !== '0';           // off as soon as we know it's a normal tab
  const D = Document.prototype;
  const realHidden = Object.getOwnPropertyDescriptor(D, 'hidden').get;
  const realVis = Object.getOwnPropertyDescriptor(D, 'visibilityState').get;
  const realFocus = D.hasFocus;
  const isHidden = () => realHidden.call(document);
  try {
    Object.defineProperty(D, 'hidden', { configurable: true, get() { return on() ? false : realHidden.call(this); } });
    Object.defineProperty(D, 'visibilityState', { configurable: true, get() { return on() ? 'visible' : realVis.call(this); } });
    D.hasFocus = function () { return on() ? true : realFocus.call(this); };
    if ('webkitHidden' in D) Object.defineProperty(D, 'webkitHidden', { configurable: true, get() { return on() ? false : realHidden.call(this); } });
    if ('webkitVisibilityState' in D) Object.defineProperty(D, 'webkitVisibilityState', { configurable: true, get() { return on() ? 'visible' : realVis.call(this); } });
  } catch (e) { }
  for (const t of ['visibilitychange', 'webkitvisibilitychange', 'freeze'])
    window.addEventListener(t, e => { if (on()) e.stopImmediatePropagation(); }, true);
  window.addEventListener('blur', e => { if (on() && e.target === window) e.stopImmediatePropagation(); }, true);

  // ---- worker-thread clock (falls back to normal timers if the site forbids blob workers)
  let W = null;
  try {
    W = new Worker(URL.createObjectURL(new Blob([`const T={};onmessage=e=>{const m=e.data;if(m.op==='set'){T[m.id]=(m.rep?setInterval:setTimeout)(()=>{postMessage(m.id);if(!m.rep)delete T[m.id];},m.d);}else{clearTimeout(T[m.id]);clearInterval(T[m.id]);delete T[m.id];}};`], { type: 'text/javascript' })));
  } catch (e) { W = null; }
  if (de) de.setAttribute('data-rta-awake', W ? 'worker' : 'basic');
  if (!W) return;
  const rST = window.setTimeout, rCT = window.clearTimeout, rSI = window.setInterval, rCI = window.clearInterval;
  const rRAF = window.requestAnimationFrame, rCAF = window.cancelAnimationFrame;
  const timers = new Map(); let nid = 2e9;
  W.onmessage = e => {
    const t = timers.get(e.data); if (!t) return;
    if (!t.rep) timers.delete(e.data);
    try { t.raf ? t.fn(performance.now()) : t.fn.apply(window, t.a); } catch (err) { rST(() => { throw err; }); }
  };
  const viaWorker = () => on() && isHidden();
  window.setTimeout = function (fn, d, ...a) {
    if (typeof fn !== 'function' || !viaWorker()) return rST.apply(window, arguments);
    const id = nid++; timers.set(id, { fn, a, rep: false }); W.postMessage({ op: 'set', id, d: Math.max(0, +d || 0), rep: false }); return id;
  };
  window.setInterval = function (fn, d, ...a) {
    if (typeof fn !== 'function' || !viaWorker()) return rSI.apply(window, arguments);
    const id = nid++; timers.set(id, { fn, a, rep: true }); W.postMessage({ op: 'set', id, d: Math.max(4, +d || 0), rep: true }); return id;
  };
  window.clearTimeout = function (id) { if (timers.has(id)) { timers.delete(id); W.postMessage({ op: 'clear', id }); } else rCT.call(window, id); };
  window.clearInterval = function (id) { if (timers.has(id)) { timers.delete(id); W.postMessage({ op: 'clear', id }); } else rCI.call(window, id); };
  window.requestAnimationFrame = function (cb) {
    if (typeof cb !== 'function' || !viaWorker()) return rRAF.call(window, cb);
    const id = nid++; timers.set(id, { fn: cb, raf: true, rep: false }); W.postMessage({ op: 'set', id, d: 16, rep: false }); return id;
  };
  window.cancelAnimationFrame = function (id) { if (timers.has(id)) { timers.delete(id); W.postMessage({ op: 'clear', id }); } else rCAF.call(window, id); };
})();

}
