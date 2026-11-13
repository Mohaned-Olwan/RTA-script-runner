// RTA app shim: gives the dashboard bridge and the automation engine (background.js) the chrome.* APIs they expect,
// backed by the RTA Script Runner app (window.rtaHost, exposed by Playwright). Two sides talk over an in-page bus:
//   window.__rtaBG  → used by background.js (the automation engine)
//   window.chrome   → used by ext_bridge.js (the dashboard's Automation tab)
(() => {
  if (typeof window.rtaHost !== 'function') { console.warn('RTA: not running inside the RTA app'); return; }
  const host = (op, a) => window.rtaHost(JSON.stringify({ op, a: a === undefined ? null : a })).then(r => {
    const o = JSON.parse(r); if (o.err) throw new Error(o.err); return o.v;
  });
  const ev = () => { const L = []; return { addListener: f => L.push(f), removeListener: f => { const i = L.indexOf(f); if (i >= 0) L.splice(i, 1); }, hasListener: f => L.includes(f), _L: L }; };
  const clone = m => JSON.parse(JSON.stringify(m));
  // chrome.runtime.sendMessage semantics: first reply wins; resolves undefined when nobody answers
  const deliver = (L, msg) => new Promise(resolve => {
    let pending = false, done = false;
    const reply = v => { if (!done) { done = true; resolve(v); } };
    for (const f of L.slice()) {
      let r; try { r = f(clone(msg), { id: 'rta-app' }, reply); } catch (e) { console.error(e); }
      if (r === true) pending = true;
      if (done) return;
    }
    if (!pending) resolve(undefined);
  });
  const bgMsg = ev(), uiMsg = ev();
  let bgReadyRes; const bgReady = new Promise(r => { bgReadyRes = r; });
  const bgAdd = bgMsg.addListener; bgMsg.addListener = f => { bgAdd(f); bgReadyRes(); };
  const version = window.RTA_APP_VERSION || '2.0';
  const getURL = p => location.origin + '/' + String(p || '').replace(/^\//, '');
  const port = () => ({ name: 'keepalive', postMessage() { }, disconnect() { }, onDisconnect: ev(), onMessage: ev() });

  const storage = {
    local: {
      get: k => host('storage.get', k === undefined ? null : k),
      set: o => host('storage.set', o),
      remove: k => host('storage.remove', k),
    },
    onChanged: ev(),
  };
  const alarms = (() => {
    const onAlarm = ev(), T = {};
    return {
      onAlarm,
      create(name, o) { name = typeof name === 'string' ? name : ''; clearInterval(T[name]); const ms = Math.max(0.05, (o && (o.periodInMinutes || o.delayInMinutes)) || 1) * 60000; T[name] = setInterval(() => onAlarm._L.forEach(f => { try { f({ name }); } catch (e) { console.error(e); } }), ms); },
      clear(name) { clearInterval(T[name]); delete T[name]; return Promise.resolve(true); },
    };
  })();
  const onStartup = ev();
  const BG = {
    runtime: {
      id: 'rta-app', lastError: undefined, getURL, getManifest: () => ({ version }),
      sendMessage: msg => deliver(uiMsg._L, msg),
      onMessage: bgMsg, onConnect: ev(), onStartup, onInstalled: ev(),
    },
    storage, alarms,
    tabs: {
      create: o => host('tabs.create', o || {}),
      get: id => host('tabs.get', id),
      update: (id, o) => host('tabs.update', [id, o || {}]),
      remove: ids => host('tabs.remove', ids),
      query: o => host('tabs.query', o || {}),
    },
    windows: {
      create: o => host('windows.create', o || {}),
      get: id => host('windows.get', id),
      update: (id, o) => host('windows.update', [id, o || {}]),
      getAll: () => host('windows.getAll', {}),
    },
    scripting: {
      executeScript: o => host('exec', { tabId: o.target.tabId, src: o.func.toString(), args: o.args || [], world: o.world || 'ISOLATED' }).then(v => [{ result: v }]),
      registerContentScripts: () => Promise.resolve(), unregisterContentScripts: () => Promise.resolve(),
      getRegisteredContentScripts: () => Promise.resolve([]),
    },
    declarativeNetRequest: { getSessionRules: () => Promise.resolve([]), updateSessionRules: () => Promise.resolve() },
    downloads: { onCreated: ev(), onDeterminingFilename: ev(), cancel: () => Promise.resolve(), erase: () => Promise.resolve(), search: () => Promise.resolve([]) },
    action: { onClicked: ev() },
  };
  window.__rtaBG = BG;
  const UI = {
    runtime: {
      id: 'rta-app', lastError: undefined, getURL, getManifest: () => ({ version }),
      sendMessage: msg => Promise.race([bgReady, new Promise(r => setTimeout(r, 8000))]).then(() => deliver(bgMsg._L, msg)),
      onMessage: uiMsg, connect: () => port(),
    },
    storage,
  };
  try { Object.defineProperty(window, 'chrome', { configurable: true, writable: true, value: UI }); } catch (e) { window.chrome = UI; }
  window.IS_APP = true;
  // the automation engine treats a fresh page load like a browser start (old tab ids are gone)
  window.addEventListener('load', () => setTimeout(() => onStartup._L.forEach(f => { try { f(); } catch (e) { console.error(e); } }), 0));
  window.rtaApp = { send: m => UI.runtime.sendMessage(m) };   // used by the app (Python) to drive the engine
})();
