const chrome = window.__rtaBG;   // RTA app: chrome.* APIs provided by host_shim.js
// RTA Realtime — service worker: CMS web collector + Teams web sender.
// Everything that touches a website runs here, step by step, with timeouts and recovery.
import { estParts, inWindow, statusOf, isDue, webChatLink, serverOf, loginUrlFor, looksLikeCmsCsv, countCmsRows } from './schedule.js';

const DASH = chrome.runtime.getURL('dashboard.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();

// ------------------------------------------------------------------ config & state
const DEFAULT_CFG = {
  cms: {
    reports: [],                 // {id, lob, url, everySec, enabled}
    creds: {},                   // origin -> {user, pass}
    concurrency: 3,
    activateBeforeExport: false, // bring the tab to front (inside the worker window) before exporting
    saveCopies: false,           // also save the CSV to Downloads\RTA_CMS (file mode only)
    exportMode: 'clipboard',     // 'clipboard' = read the export in memory (no file, no download prompt) · 'file' = Export to File
    staleReloadMin: 6,           // no good export for this long → reopen the tab
  },
  teams: {
    targets: [],                 // {id, target, link, views[], mode, every, fail, tight, pass, start, stop, enabled, offsetMin}
    maxAgeMin: 10,
    paused: false,
    tabPerChat: true,            // one Teams tab per group chat, opened once and kept (no reloading between sends)
    holdSec: 20,                 // after a send, leave that chat's tab alone this long so the pictures finish posting
    gapSec: 3,                   // pause between two different chats
    blockAppPrompt: true,
    restoreToRetry: true,
    pretendVisible: true,        // worker-window Teams tabs act as if on top (visible, unthrottled timers) even behind other windows
    activateTab: true,           // make the chat tab the front tab of the worker window before sending        // if pictures don't attach in a minimised worker window: un-minimise it for that send, retry, minimise again        // stop Teams' launcher from trying to open the desktop app in the worker window
    selectors: {
      compose: ['[data-tid="ckeditor"]', 'div[role="textbox"][contenteditable="true"]', '[contenteditable="true"][aria-label*="message" i]', '[contenteditable="true"][aria-label*="reply" i]'],
      send: ['button[data-tid="newMessageCommands-send"]', 'button[name="send"]', 'button[aria-label^="Send" i]', 'button[title^="Send" i]'],
      launcher: ['Use the web app instead', 'Continue on this browser', 'Use the web app', 'Continue in this browser'],
    },
  },
  running: { cms: false, teams: false },
};
let CFG = null;
let RT = null;           // runtime: {tabs, teamsTab, workerWin, exp:{}, send:{}, login:{}, statusPrev:{}}
const BUSY = { cms: new Set(), teams: false, login: new Set(), cmsCycle: false };
const PENDING = new Map(); // slug -> {resolve, until}

async function load() {
  if (CFG && RT) return;
  const d = await chrome.storage.local.get(['rta_cfg_auto', 'rta_rt']);
  CFG = deepMerge(structuredClone(DEFAULT_CFG), d.rta_cfg_auto || {});
  RT = Object.assign({ tabs: {}, teamsTab: null, chatTabs: {}, teamsHoldUntil: 0, workerWin: null, exp: {}, send: {}, login: {}, statusPrev: {}, lobStatus: {} }, d.rta_rt || {});
}
function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}
const saveCfg = () => chrome.storage.local.set({ rta_cfg_auto: CFG });
let rtTimer = null;
const saveRt = () => { clearTimeout(rtTimer); rtTimer = setTimeout(() => chrome.storage.local.set({ rta_rt: RT }), 300); };

let LOGS = null;
async function log(msg, level = 'info') {
  if (!LOGS) LOGS = (await chrome.storage.local.get('rta_log')).rta_log || [];
  const line = { t: now(), level, msg };
  LOGS.push(line); if (LOGS.length > 500) LOGS.splice(0, LOGS.length - 500);
  chrome.storage.local.set({ rta_log: LOGS });
  broadcast({ type: 'auto:log', line });
}
function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }
const pushState = () => broadcast({ type: 'auto:update' });

// ------------------------------------------------------------------ tab helpers
async function tabAlive(id) { if (!id) return null; try { return await chrome.tabs.get(id); } catch { return null; } }
async function exec(tabId, func, args = [], world = 'ISOLATED', timeoutMs = 20000) {
  const p = chrome.scripting.executeScript({ target: { tabId }, func, args, world }).then(r => r && r[0] ? r[0].result : undefined);
  return Promise.race([p, sleep(timeoutMs).then(() => { throw new Error('page did not answer'); })]);
}
async function waitComplete(tabId, timeoutMs = 60000) {
  const end = now() + timeoutMs;
  while (now() < end) { const t = await tabAlive(tabId); if (!t) throw new Error('tab closed'); if (t.status === 'complete') return t; await sleep(500); }
  throw new Error('page load timed out');
}
async function waitFor(fn, timeoutMs, everyMs = 700) {
  const end = now() + timeoutMs; let last;
  while (now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = null; } await sleep(everyMs); }
  return null;
}
let workerLock = null;
async function workerWindow() {
  if (workerLock) return workerLock;            // one window, even when many tabs ask at once
  workerLock = (async () => {
    if (RT.workerWin) { try { await chrome.windows.get(RT.workerWin); return RT.workerWin; } catch { RT.workerWin = null; } }
    const w = await chrome.windows.create({ url: chrome.runtime.getURL('worker.html'), focused: false, state: 'normal', width: 1280, height: 860 });
    try { const [t0] = await chrome.tabs.query({ windowId: w.id }); if (t0) await chrome.tabs.update(t0.id, { pinned: true, autoDiscardable: false }); } catch { }
    RT.workerWin = w.id; saveRt();
    log('Opened the CMS + Teams tabs in the RTA browser window (keep it open; it can sit behind other windows)');
    return w.id;
  })();
  try { return await workerLock; } finally { workerLock = null; }
}
async function openTab(url, active = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const windowId = await workerWindow();
    try {
      const t = await chrome.tabs.create({ windowId, url, active });
      try { await chrome.tabs.update(t.id, { autoDiscardable: false }); } catch { }
      return t;
    } catch (e) {
      if (/no window/i.test(e.message)) { RT.workerWin = null; saveRt(); continue; }   // window vanished → recreate
      throw e;
    }
  }
  throw new Error('could not open a tab in the worker window');
}
async function closeTab(id) { try { await chrome.tabs.remove(id); } catch { } }

// ------------------------------------------------------------------ injected page functions (must be self-contained)
function pgCmsDetect() {
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const user = document.querySelector("input[name='userName']"), pass = document.querySelector("input[name='password']");
  const btns = [...document.querySelectorAll('button')];
  const exportBtn = btns.find(b => b.querySelector('i.fa-file-export'));
  const txt = (document.body && document.body.innerText || '').slice(0, 5000);
  return {
    loginForm: vis(user) && vis(pass),
    ready: vis(exportBtn),
    expired: /session (has )?(expired|timed out)|logged out|not logged in|sign in again|invalid session|log in again/i.test(txt),
    okBtn: !!btns.find(b => /^\s*ok\s*$/i.test(b.textContent) && vis(b)),
    refreshed: (txt.match(/refreshed report data on ([^\n]+)/i) || [])[1] || null,
    url: location.href,
  };
}
function pgClickOk() {
  const b = [...document.querySelectorAll('button')].find(b => /^\s*ok\s*$/i.test(b.textContent) && (b.offsetWidth || b.offsetHeight));
  if (b) { b.click(); return true; } return false;
}
function pgCmsLogin(user, pass) {
  const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const u = document.querySelector("input[name='userName']"), p = document.querySelector("input[name='password']");
  if (!u || !p) return 'no-form';
  set(u, user); set(p, pass);
  const b = document.querySelector('#loginButton') || [...document.querySelectorAll('button')].find(b => /log\s*in|sign\s*in/i.test(b.textContent));
  if (!b) return 'no-button';
  b.click(); return 'clicked';
}
function pgHook(suppress) {   // MAIN world: catch the CSV the page hands to the clipboard or to a download
  const H = window.__rtaHook || (window.__rtaHook = { caps: [], suppress: false, armUntil: 0 });
  const push = (text, via) => { H.caps.push({ at: Date.now(), text: String(text), via }); if (H.caps.length > 5) H.caps.shift(); };
  const decode = b => {
    let enc = 'utf-8', off = 0;
    if (b[0] === 0xFF && b[1] === 0xFE) { enc = 'utf-16le'; off = 2; }
    else if (b[0] === 0xFE && b[1] === 0xFF) { enc = 'utf-16be'; off = 2; }
    else if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) { off = 3; }
    else { let odd = 0, even = 0; const n = Math.min(b.length, 4000); for (let i = 0; i < n; i++) if (b[i] === 0) (i % 2 ? odd++ : even++);
           if (odd > n * 0.3) enc = 'utf-16le'; else if (even > n * 0.3) enc = 'utf-16be'; }
    return new TextDecoder(enc).decode(b.subarray(off));
  };
  if (!H.v2) {
    H.v2 = true;
    // a) "Export to Clipboard" → navigator.clipboard.writeText(csv). While armed we keep the text and do NOT touch the real clipboard.
    const wrap = orig => function (text) {
      if (Date.now() < H.armUntil) { push(text, 'clipboard'); return Promise.resolve(); }
      return orig ? orig.apply(this, arguments) : Promise.reject(new DOMException('Clipboard unavailable', 'NotAllowedError'));
    };
    try {
      if (window.Clipboard && Clipboard.prototype.writeText) { const o = Clipboard.prototype.writeText; Clipboard.prototype.writeText = wrap(o); }
      if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: wrap(null) } });
    } catch (e) { }
    // b) "Export to File" → Blob → object URL → <a download> click
    const oc = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = oc.apply(this, arguments);
      try { if (obj instanceof Blob && Date.now() < H.armUntil) obj.arrayBuffer().then(buf => push(decode(new Uint8Array(buf)), 'blob')); } catch (e) { }
      return url;
    };
    const block = a => {
      const h = a.href || '';
      if (h.startsWith('data:') && Date.now() < H.armUntil) { const i = h.indexOf(','); push(/;base64/i.test(h.slice(0, i)) ? atob(h.slice(i + 1)) : decodeURIComponent(h.slice(i + 1)), 'data'); }
      return H.suppress && Date.now() < H.armUntil && a.hasAttribute('download') && (h.startsWith('blob:') || h.startsWith('data:'));
    };
    const ac = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { try { if (block(this)) return; } catch (e) { } return ac.apply(this, arguments); };
    const ad = EventTarget.prototype.dispatchEvent;   // FileSaver (used by CMS web) clicks via dispatchEvent(new MouseEvent('click'))
    HTMLAnchorElement.prototype.dispatchEvent = function (ev) { try { if (ev && ev.type === 'click' && block(this)) return true; } catch (e) { } return ad.call(this, ev); };
  }
  H.suppress = !!suppress;
  H.armUntil = Date.now() + 70000;
  return true;
}
function pgCaptured(since) {  // MAIN world
  const H = window.__rtaHook; if (!H) return null;
  const c = H.caps.filter(x => x.at >= since).pop();
  if (c) H.armUntil = 0;
  return c ? c.text : null;
}
function pgCmsExportStep(o) {
  // Drives CMS web's "Export Data" form. Every call re-checks the whole form and fixes what is wrong; it only presses Export
  // when everything is right. Field keys (from CMS web's code): dataToExport, includeInputs, useHeadersAndLabels,
  // convertNullValues, convertTimeToSeconds, destination (file/clipboard), fileName, fieldSeparator, delimiter.
  o = typeof o === 'string' ? { fileName: o, mode: 'file' } : (o || {});
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const T = e => (e && e.textContent || '').replace(/\s+/g, ' ').trim();
  const st = window.__rtaExp = window.__rtaExp || {};
  const t = Date.now();
  const once = (k, ms) => { if (st[k] && t - st[k] < ms) return false; st[k] = t; return true; };
  const notGrid = e => !e.closest('.ag-root-wrapper,.ag-root,ag-grid-angular');
  // --- checkboxes (Angular Material / formly: the real <input type=checkbox> carries aria-label = label text)
  const boxes = [...document.querySelectorAll('input[type=checkbox],[role=checkbox],md-checkbox,mat-checkbox')].filter(notGrid);
  const labelOf = e => (e.getAttribute('aria-label') || [...(e.labels || [])].map(T).join(' ') ||
    T(e.closest('mat-checkbox,md-checkbox,.mat-mdc-checkbox,.mat-checkbox,label,.form-check,.checkbox') || e.parentElement || e)).trim();
  const findBox = re => {
    const m = boxes.filter(e => re.test(labelOf(e)));
    return m.find(e => e.tagName === 'INPUT') || m.find(e => e.getAttribute('role') === 'checkbox') || m[0] || null;
  };
  const isOn = e => {
    if (e.tagName === 'INPUT') return e.checked;
    const a = e.getAttribute('aria-checked'); if (a != null) return a === 'true';
    return /(^|\s)(md-checked|mat-checkbox-checked|mat-mdc-checkbox-checked)(\s|$)/.test(e.className || '');
  };
  const hdrBox = findBox(/labels\s*and\s*headers/i), secBox = findBox(/durations\s*in\s*seconds/i);
  const panel = hdrBox || secBox;
  // --- toggle buttons (All Data / Export to Clipboard / Export to File ...)
  const toggles = re => [...document.querySelectorAll('mat-button-toggle button,button,[role=radio],[role=button],label,.btn')]
    .filter(e => vis(e) && notGrid(e) && re.test(T(e)) && T(e).length < 40);
  const pressed = e => {
    for (let x = e, i = 0; x && i < 3; x = x.parentElement, i++) {
      if (x.getAttribute('aria-pressed') === 'true' || x.getAttribute('aria-checked') === 'true') return true;
      if (/(^|\s)(mat-button-toggle-checked|mat-mdc-button-toggle-checked|active|selected|checked|md-checked)(\s|$)/.test(x.className || '')) return true;
      if (x.getAttribute('aria-pressed') === 'false' || x.getAttribute('aria-checked') === 'false') return false;
    }
    return null;   // unknown
  };
  const nameInput = [...document.querySelectorAll("input[id*='fileName' i],input[name*='fileName' i],input[ng-model*='fileName' i],input[formcontrolname*='fileName' i]")].find(vis) || null;

  // 1) open the export form
  if (!panel) {
    const eb = [...document.querySelectorAll('button')].filter(vis).find(b => b.querySelector('i.fa-file-export,[translate="CMSReport_export"]'));
    if (!eb) return { stage: 'no-export-button' };
    if (once('open', 8000)) eb.click();
    return { stage: 'opening' };
  }
  // 2) Data to Export = All Data
  const all = toggles(/^all data$/i)[0];
  if (all && pressed(all) === false) { if (once('all', 1500)) all.click(); return { stage: 'setting All Data' }; }
  // 3) checkboxes: headers ON, nulls as zero ON, seconds ON, report inputs OFF
  const want = [[/labels\s*and\s*headers/i, true, 'Include Labels and Headers'], [/null\s*values\s*as\s*zero/i, true, 'Export Null Values as Zero'],
                [/durations\s*in\s*seconds/i, true, 'Export Time Durations in Seconds'], [/include\s*report\s*inputs/i, false, 'Include Report Inputs']];
  const wrong = [];
  for (const [re, on, name] of want) {
    const b = findBox(re); if (!b) { if (on && name.startsWith('Include Labels')) return { stage: 'headers checkbox not found' }; continue; }
    if (isOn(b) !== on) { wrong.push(name); if (once('cb' + name, 1500)) b.click(); }
  }
  if (wrong.length) return { stage: 'ticking: ' + wrong.join(', ') };
  // 4) destination
  if (o.mode === 'clipboard') {
    const cb = toggles(/^(export\s*)?to\s*clipboard$/i)[0];
    if (!cb) return { stage: 'no "Export to Clipboard" option' };
    const p = pressed(cb);
    // the File name box is hidden when Clipboard is selected — the surest sign it took
    if (p === false || nameInput) { if (once('dest', 1500)) cb.click(); return { stage: 'selecting Export to Clipboard' }; }
  } else {
    const fb = toggles(/^(export\s*)?to\s*file$/i)[0];
    if (fb && (pressed(fb) === false || !nameInput)) { if (once('dest', 1500)) fb.click(); return { stage: 'selecting Export to File' }; }
    if (!nameInput) return { stage: 'waiting for file name box' };
    const fname = String(o.fileName || 'rta_export').replace(/\.csv$/i, '');   // CMS web adds ".csv" itself
    if (nameInput.value !== fname) {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(nameInput, fname);
      for (const ev of ['input', 'change', 'blur']) nameInput.dispatchEvent(new Event(ev, { bubbles: true }));
      return { stage: 'typing file name' };
    }
  }
  // 5) the form's own Export button (not the toolbar one)
  let box = panel, ex = null;
  for (let i = 0; i < 12 && box && !ex; i++, box = box.parentElement)
    ex = [...box.querySelectorAll('button')].find(b => vis(b) && /^export$/i.test(T(b)) && !b.querySelector('i.fa-file-export'));
  if (!ex) ex = [...document.querySelectorAll('button')].find(b => vis(b) && /^export$/i.test(T(b)) && !b.querySelector('i.fa-file-export'));
  if (!ex) return { stage: 'export button not found' };
  if (ex.disabled || ex.getAttribute('aria-disabled') === 'true') return { stage: 'export button disabled' };
  ex.click(); st.open = 0;
  return { stage: 'exported' };
}
function pgCmsCloseDialog() {
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const bs = [...document.querySelectorAll('button,[role=button],a,i,mat-icon,span')].filter(vis);
  const b = bs.find(b => /^\s*(cancel|close|×|✕|✖)\s*$/i.test(b.textContent || '')) ||
            bs.find(b => /close/i.test(b.getAttribute('aria-label') || b.getAttribute('title') || '')) ||
            bs.find(b => b.matches && b.matches('.fa-times,.fa-close,.fa-xmark,.close'));
  if (b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
}
// --- Teams
function pgTeamsDetect(sel) {
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const q = list => { for (const s of list) { const e = [...document.querySelectorAll(s)].find(vis); if (e) return e; } return null; };
  const compose = q(sel.compose);
  const host = location.host;
  const signedOut = /login\.microsoftonline|okta|login\.live/i.test(host) || /^sign in/i.test(document.title);
  let launcher = false;
  if (/\/dl\/launcher\//i.test(location.pathname)) {
    const r = new URLSearchParams(location.search).get('url') || '';
    if (r.startsWith('/') && !r.startsWith('//')) { location.replace(location.origin + r); return { compose: false, signedOut: false, launcher: true, url: location.href, title: document.title }; }
  }
  for (const t of sel.launcher) {
    const b = [...document.querySelectorAll('button,a')].find(e => vis(e) && (e.textContent || '').trim().toLowerCase().includes(t.toLowerCase()));
    if (b) { b.click(); launcher = true; break; }
  }
  return { compose: !!compose, signedOut, launcher, url: location.href, title: document.title };
}
function pgTeamsPaste(images, sel) {  // MAIN world
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const q = list => { for (const s of list) { const e = [...document.querySelectorAll(s)].find(vis); if (e) return e; } return null; };
  const ed = q(sel.compose); if (!ed) return { ok: false, why: 'message box not found' };
  // clear any old draft (only inside the message box)
  try { ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('delete'); } catch (e) { }
  const dt = new DataTransfer();
  for (const im of images) {
    const b64 = im.dataUrl.split(',')[1], bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    dt.items.add(new File([u8], im.name, { type: 'image/png' }));
  }
  ed.focus();
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  ed.dispatchEvent(ev);
  return { ok: true, method: 'paste', handled: ev.defaultPrevented, vis: document.visibilityState };
}
function pgTeamsDrop(images, sel) {  // MAIN world fallback
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const q = list => { for (const s of list) { const e = [...document.querySelectorAll(s)].find(vis); if (e) return e; } return null; };
  const ed = q(sel.compose); if (!ed) return { ok: false };
  const dt = new DataTransfer();
  for (const im of images) { const bin = atob(im.dataUrl.split(',')[1]); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); dt.items.add(new File([u8], im.name, { type: 'image/png' })); }
  for (const type of ['dragenter', 'dragover', 'drop']) ed.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  return { ok: true, method: 'drop' };
}
function pgTeamsComposeState(sel) {
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const q = list => { for (const s of list) { const e = [...document.querySelectorAll(s)].find(vis); if (e) return e; } return null; };
  const ed = q(sel.compose); if (!ed) return { found: false };
  // the attachment strip sits near the editor: search the closest container that holds both the editor and the send button
  let box = ed; for (let i = 0; i < 8 && box.parentElement; i++) { box = box.parentElement; if (sel.send.some(s => box.querySelector(s))) break; }
  const imgs = [...box.querySelectorAll('img')].filter(vis).filter(i => (i.naturalWidth || i.width) > 40 && !/avatar|emoji/i.test(i.className + ' ' + (i.alt || '')));
  const chips = box.querySelectorAll('[data-tid*="attachment" i],[data-tid*="file-preview" i],[aria-label*="attachment" i]').length;
  const inEd = ed.querySelectorAll('img').length;                                              // pasted pictures often sit inside the editor itself
  const blobs = [...box.querySelectorAll('img')].filter(i => /^(blob|data):/.test(i.getAttribute('src') || '')).length;
  const uploading = !!box.querySelector('[role="progressbar"],[data-tid*="upload" i][aria-busy="true"]');
  const text = (ed.innerText || '').trim();
  const sendBtn = (() => { for (const s of sel.send) { const b = [...box.querySelectorAll(s)].find(vis) || [...document.querySelectorAll(s)].find(vis); if (b) return b; } return null; })();
  return { found: true, attachments: Math.max(imgs.length, chips, inEd, blobs), html: ed.innerHTML.length, vis: document.visibilityState, uploading, text, canSend: !!sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true' };
}
function pgTeamsSnapshot(sel) {   // what the Teams page looks like — saved when a send fails, shown by Diagnose
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const out = { at: new Date().toLocaleTimeString(), url: location.href.slice(0, 160), title: document.title, visibility: document.visibilityState, focused: document.hasFocus(), composeSel: null, compose: null, path: [], tids: {}, pageImgs: 0, blobImgs: 0, sendBtn: null, editables: 0 };
  let ed = null;
  for (const sl of sel.compose) { const e = [...document.querySelectorAll(sl)].find(vis); if (e) { ed = e; out.composeSel = sl; break; } }
  out.editables = [...document.querySelectorAll('[contenteditable="true"]')].filter(vis).map(e => (e.getAttribute('data-tid') || e.getAttribute('aria-label') || e.tagName).slice(0, 40));
  if (ed) {
    out.compose = { tag: ed.tagName, tid: ed.getAttribute('data-tid'), role: ed.getAttribute('role'), aria: ed.getAttribute('aria-label'), htmlLen: ed.innerHTML.length, imgs: ed.querySelectorAll('img').length,
      html: ed.innerHTML.replace(/src="(data|blob):[^"]{12,}"/g, 'src="$1:…"').replace(/>[^<]{40,}</g, '>…<').slice(0, 900) };
    for (let x = ed, i = 0; x && i < 12; x = x.parentElement, i++)
      out.path.push([x.tagName.toLowerCase(), x.getAttribute('data-tid') || '', (typeof x.className === 'string' ? x.className : '').split(/\s+/)[0] || '', 'img:' + x.querySelectorAll('img').length, sel.send.some(q => x.querySelector(q)) ? 'has-send' : ''].join(' ').trim());
  }
  document.querySelectorAll('[data-tid]').forEach(e => { const t = e.getAttribute('data-tid'); if (/attach|file|image|upload|preview|send|compose|editor/i.test(t)) out.tids[t] = (out.tids[t] || 0) + 1; });
  const imgs = [...document.querySelectorAll('img')]; out.pageImgs = imgs.length; out.blobImgs = imgs.filter(i => /^(blob|data):/.test(i.getAttribute('src') || '')).length;
  for (const q of sel.send) { const b = [...document.querySelectorAll(q)].find(vis); if (b) { out.sendBtn = { sel: q, disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true', label: b.getAttribute('aria-label') || b.title || '' }; break; } }
  return out;
}
function pgTeamsClearDraft(sel) {
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  for (const q of sel.compose) { const ed = [...document.querySelectorAll(q)].find(vis); if (ed) { try { ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); const g = getSelection(); g.removeAllRanges(); g.addRange(r); document.execCommand('delete'); } catch (e) { } return true; } }
  return false;
}
function pgTeamsClickSend(sel) {
  const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  for (const s of sel.send) { const b = [...document.querySelectorAll(s)].find(e => vis(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true'); if (b) { b.click(); return true; } }
  return false;
}

// ------------------------------------------------------------------ CMS collector
const slug = s => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const expName = r => `rta_${slug(r.lob)}_${r.id}`;

async function ensureReportTab(r) {
  const tabId = RT.tabs[r.id]; const t = await tabAlive(tabId);
  if (t && t.windowId === RT.workerWin) return t;
  if (t) await closeTab(t.id);
  const nt = await openTab(r.url); RT.tabs[r.id] = nt.id; RT.exp[r.id] = Object.assign(RT.exp[r.id] || {}, { openedAt: now() }); saveRt();
  log(`[CMS ${r.lob}] opened report tab`);
  return null;   // give it time to load; exported next round
}

async function reopenReport(r, why) {
  log(`[CMS ${r.lob}] reopening report tab (${why})`, 'warn');
  const old = RT.tabs[r.id];
  const nt = await openTab(r.url);          // open the new tab first, then close the old one
  if (old) await closeTab(old);
  RT.tabs[r.id] = nt.id; RT.exp[r.id] = Object.assign(RT.exp[r.id] || {}, { openedAt: now(), fails: 0 }); saveRt();
}

async function loginServer(origin, reportUrl) {
  if (BUSY.login.has(origin)) return false;
  const lb = RT.login[origin] || (RT.login[origin] = { fails: 0, until: 0, at: 0 });
  if (now() < lb.until) return false;                         // back-off after failures (avoid account lock-out)
  const cred = CFG.cms.creds[origin];
  if (!cred || !cred.user || !cred.pass) { if (!lb.warned) { log(`[CMS] ${origin} is logged out and no login is saved — add it in Automation → CMS logins`, 'error'); lb.warned = true; } return false; }
  BUSY.login.add(origin);
  let tab = null;
  try {
    log(`[CMS] logging in to ${origin}…`);
    tab = await openTab(loginUrlFor(reportUrl));
    await waitComplete(tab.id, 60000);
    const form = await waitFor(async () => (await exec(tab.id, pgCmsDetect)).loginForm, 45000, 1000);
    if (!form) {
      const d = await exec(tab.id, pgCmsDetect).catch(() => ({}));
      if (d && d.ready) { log(`[CMS] ${origin}: already logged in`); }
      else throw new Error('login form did not appear');
    } else {
      const res = await exec(tab.id, pgCmsLogin, [cred.user, cred.pass]);
      if (res !== 'clicked') throw new Error('could not submit the login form (' + res + ')');
      const done = await waitFor(async () => { const d = await exec(tab.id, pgCmsDetect); if (d.okBtn) await exec(tab.id, pgClickOk); return !d.loginForm ? d : null; }, 60000, 1500);
      if (!done) throw new Error('still on the login page after 60 s — wrong password?');
      await sleep(1500); await exec(tab.id, pgClickOk).catch(() => {});
    }
    lb.fails = 0; lb.until = 0; lb.at = now(); lb.warned = false; saveRt();
    log(`[CMS] ${origin}: logged in ✓ — reopening its reports in fresh tabs`);
    await closeTab(tab.id); tab = null;
    for (const r of CFG.cms.reports.filter(r => r.enabled && serverOf(r.url) === origin)) { await reopenReport(r, 'after login'); await sleep(700); }
    return true;
  } catch (e) {
    lb.fails++; lb.until = now() + (lb.fails >= 3 ? 15 : 2) * 60000; saveRt();
    log(`[CMS] ${origin}: login failed (${e.message}). Next try in ${lb.fails >= 3 ? 15 : 2} min`, 'error');
    if (tab) await closeTab(tab.id);
    return false;
  } finally { BUSY.login.delete(origin); }
}

async function exportReport(r, manual = false) {
  if (BUSY.cms.has(r.id)) return;
  BUSY.cms.add(r.id);
  const st = RT.exp[r.id] || (RT.exp[r.id] = { fails: 0 });
  const origin = serverOf(r.url);
  try {
    const t = await ensureReportTab(r); if (!t) return;
    if (t.status !== 'complete') { if (now() - (st.openedAt || 0) > 90000) await reopenReport(r, 'page stuck loading'); return; }
    let d = await exec(t.id, pgCmsDetect).catch(e => ({ err: e.message }));
    if (d.err) { st.fails = (st.fails || 0) + 1; st.err = d.err; log(`[CMS ${r.lob}] page check failed: ${d.err}`, 'warn'); if (st.fails >= 2) await reopenReport(r, 'page not responding'); return; }
    if (d.okBtn && !d.ready) { await exec(t.id, pgClickOk); await sleep(800); d = await exec(t.id, pgCmsDetect); }
    if (d.loginForm || d.expired || /#\/login/i.test(d.url)) {
      st.state = 'logged out'; saveRt();
      if (!BUSY.login.has(origin)) loginServer(origin, r.url);   // runs in background; other tabs of the server wait
      return;
    }
    if (!d.ready) {
      if (now() - (st.openedAt || 0) > 60000) { st.fails = (st.fails || 0) + 1; if (st.fails >= 2) await reopenReport(r, 'report never became ready'); }
      return;
    }
    if (CFG.cms.activateBeforeExport) { try { await chrome.tabs.update(t.id, { active: true }); } catch { } }
    const t0 = now();
    const mode = CFG.cms.exportMode === 'file' ? 'file' : 'clipboard';
    await exec(t.id, pgHook, [!(mode === 'file' && CFG.cms.saveCopies)], 'MAIN');
    const name = expName(r);
    const waitDl = new Promise(res => PENDING.set(name, { resolve: res, until: now() + 45000 }));
    let stage = null;
    const ok = await waitFor(async () => { const s = await exec(t.id, pgCmsExportStep, [{ fileName: name, mode }]); stage = s && s.stage; return stage === 'exported'; }, 40000, 900);
    if (!ok) { await exec(t.id, pgCmsCloseDialog).catch(() => {}); throw new Error(`export form stuck at "${stage}"`); }
    // wait for the CSV: captured in-page (blob/data) or via a real download URL
    const text = await Promise.race([
      waitFor(() => exec(t.id, pgCaptured, [t0], 'MAIN'), 40000, 800),
      waitDl,
    ]);
    PENDING.delete(name);
    await exec(t.id, pgCmsCloseDialog).catch(() => {});
    if (!text) throw new Error(mode === 'clipboard' ? 'export text was not captured' : 'export file was not captured');
    if (!looksLikeCmsCsv(text)) throw new Error(/\d{8,}/.test(text) ? `export came without the header row ("Include Labels and Headers" did not stick) – got: ${JSON.stringify(text.slice(0, 60))}`
                                                                     : `export is not an agent table (got: ${JSON.stringify(text.slice(0, 60))})`);
    const rows = countCmsRows(text);
    await storeCms(r, text, d.refreshed, rows);
    Object.assign(st, { at: now(), ok: true, rows, err: null, fails: 0, state: 'ok', refreshed: d.refreshed });
    if (manual || !st.everOk) log(`[CMS ${r.lob}] exported ${rows} agents (${mode})`); st.everOk = true;
  } catch (e) {
    st.fails = (st.fails || 0) + 1; st.err = e.message; st.ok = false; st.state = 'error'; st.at = st.at || 0; st.tried = now();
    log(`[CMS ${r.lob}] ${e.message} (fail ${st.fails})`, 'warn');
    if (st.fails >= 2) await reopenReport(r, 'repeated export failures');
  } finally {
    st.tried = now(); saveRt(); BUSY.cms.delete(r.id); pushState();
  }
}

async function storeCms(r, text, refreshed, rows) {
  const d = (await chrome.storage.local.get('rta_cms')).rta_cms || {};
  d[r.id] = { lob: r.lob, text, at: now(), refreshed, rows };
  for (const k of Object.keys(d)) if (!CFG.cms.reports.find(x => x.id === k)) delete d[k];
  await chrome.storage.local.set({ rta_cms: d });
  broadcast({ type: 'cms:data', id: r.id, lob: r.lob, text, at: now(), rows });
}

async function cmsCycle(force = false) {
  const due = [];
  for (const r of CFG.cms.reports) {
    if (!r.enabled || !r.url || !r.lob) continue;
    const st = RT.exp[r.id] || {};
    const last = Math.max(st.tried || 0, 0);
    const every = Math.max(30, +r.everySec || 60) * 1000;
    if (force || !last || now() - last >= every) due.push(r);
    // watchdog: no good export for too long → reopen
    if (st.at && now() - st.at > (+CFG.cms.staleReloadMin || 6) * 60000 && now() - (st.reopenedAt || 0) > 5 * 60000 && !BUSY.cms.has(r.id)) {
      st.reopenedAt = now(); reopenReport(r, `no fresh data for ${CFG.cms.staleReloadMin} min`);
    }
  }
  const lim = Math.max(1, +CFG.cms.concurrency || 3);
  const queue = due.filter(r => !BUSY.cms.has(r.id));
  const workers = Array.from({ length: Math.min(lim, queue.length) }, async () => { while (queue.length) { await exportReport(queue.shift()); } });
  await Promise.all(workers);
}

function decodeBytes(b) {
  let enc = 'utf-8', off = 0;
  if (b[0] === 0xFF && b[1] === 0xFE) { enc = 'utf-16le'; off = 2; } else if (b[0] === 0xFE && b[1] === 0xFF) { enc = 'utf-16be'; off = 2; }
  else if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) off = 3;
  else { let odd = 0, even = 0; const n = Math.min(b.length, 4000); for (let i = 0; i < n; i++) if (b[i] === 0) (i % 2 ? odd++ : even++); if (odd > n * 0.3) enc = 'utf-16le'; else if (even > n * 0.3) enc = 'utf-16be'; }
  return new TextDecoder(enc).decode(b.subarray(off));
}
// downloads: capture CSV from real download URLs, keep or drop the file
chrome.downloads.onCreated.addListener(async item => {
  const name = (item.filename || item.url || '').split(/[\\/]/).pop();
  const key = [...PENDING.keys()].find(k => (item.url + ' ' + name + ' ' + (item.finalUrl || '')).includes(k));
  const fromCms = CFG && CFG.cms.reports.some(r => { const o = serverOf(r.url); return o && ((item.url || '').includes(o.replace(/^https?:\/\//, '')) || (item.referrer || '').startsWith(o)); });
  if (!key && !fromCms) return;
  if (/^https?:/i.test(item.url) && key) {
    try { const res = await fetch(item.url, { credentials: 'include' }); const txt = decodeBytes(new Uint8Array(await res.arrayBuffer())); const p = PENDING.get(key); if (p) p.resolve(txt); } catch (e) { }
  }
  if (CFG && !CFG.cms.saveCopies) { try { await chrome.downloads.cancel(item.id); await chrome.downloads.erase({ id: item.id }); } catch { } }
});
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const base = (item.filename || '').split(/[\\/]/).pop();
  if (CFG && CFG.cms.saveCopies && /^rta_/i.test(base)) { suggest({ filename: 'RTA_CMS/' + base, conflictAction: 'overwrite' }); return; }
  suggest();
});

// ------------------------------------------------------------------ dashboard link
async function dashboardTab(open = true) {
  const tabs = await chrome.tabs.query({ url: DASH + '*' });
  if (tabs.length) return tabs[0];
  if (!open) return null;
  const t = await chrome.tabs.create({ url: DASH, active: false, pinned: true });
  log('Opened the dashboard (it renders the pictures — keep it open)');
  return t;
}
async function askDashboard(msg, timeoutMs = 60000) {
  const t = await dashboardTab(true);
  if (t.status !== 'complete') { try { await waitComplete(t.id, 30000); } catch { } }
  return Promise.race([chrome.runtime.sendMessage(msg), sleep(timeoutMs).then(() => null)]).catch(() => null);
}

// ------------------------------------------------------------------ Teams sender
async function teamsTab() {
  const t = await tabAlive(RT.teamsTab);
  if (t && t.windowId === RT.workerWin) return t;
  if (t) await closeTab(t.id);
  const nt = await openTeamsTab('https://teams.cloud.microsoft/', t => { RT.teamsTab = t.id; });
  return nt;
}
const normTitle = t => String(t || '').replace(/^\(\d+\)\s*/, '').split('|').map(x => x.trim()).filter(x => x && !/^(chat|chats|activity|microsoft teams|teams|teams and channels)$/i.test(x))[0] || '';   // the chat name part of the tab title
// one kept tab per chat: returns { tab, fresh } — fresh = just opened / navigated, needs to load
async function chatTab(tg) {
  const link = webChatLink(tg.link);
  RT.chatTabs = RT.chatTabs || {};
  if (!CFG.teams.tabPerChat) {
    const wait = (RT.teamsHoldUntil || 0) - now(); if (wait > 0) await sleep(wait);   // shared tab: never navigate while a send is posting
    const t = await teamsTab(); await chrome.tabs.update(t.id, { url: link }); return { tab: t, fresh: true };
  }
  const rec = RT.chatTabs[tg.id];
  const t = rec && await tabAlive(rec.tabId);
  if (t && t.windowId === RT.workerWin && rec.link === link && !t.discarded) {
    if (rec.title && normTitle(t.title) && normTitle(t.title) !== rec.title) {
      // the tab drifted to another chat/page → bring it back
      const wait = (rec.holdUntil || 0) - now(); if (wait > 0) await sleep(wait);
      await chrome.tabs.update(t.id, { url: link }); rec.title = null; saveRt(); return { tab: t, fresh: true };
    }
    if (rec.needsLoad) { rec.needsLoad = false; saveRt(); return { tab: t, fresh: true }; }
    return { tab: t, fresh: false };
  }
  if (t) await closeTab(t.id);
  const nt = await openTeamsTab(link, t => { RT.chatTabs[tg.id] = { tabId: t.id, link, openedAt: now(), title: null, holdUntil: 0 }; });
  passLauncher(nt.id).catch(() => {});
  log(`[Teams ${tg.target}] opened its chat tab`);
  return { tab: nt, fresh: true };
}
// fallback if a launcher page shows anyway: keep pressing past it for up to 90 s (not only when a send is due)
async function passLauncher(tabId) {
  const end = now() + 90000;
  while (now() < end) {
    await sleep(2500);
    const d = await exec(tabId, pgTeamsDetect, [CFG.teams.selectors]).catch(() => null);
    if (d && (d.compose || d.signedOut)) return;
  }
}
// "when it breaks, refresh the same chat link": reload that chat's tab, then the caller tries once more
async function reloadChat(tg) {
  if (!CFG.teams.tabPerChat) return;   // shared tab: every send already re-opens the link
  const rec = (RT.chatTabs || {})[tg.id]; const t = rec && await tabAlive(rec.tabId);
  if (!t) return;
  const wait = (rec.holdUntil || 0) - now(); if (wait > 0) await sleep(wait);
  await chrome.tabs.update(t.id, { url: webChatLink(tg.link) });
  rec.needsLoad = true; rec.title = null; saveRt();
}
async function sendWithRecovery(tg, manual = false) {
  let r = await sendTarget(tg, manual).catch(e => 'Error: ' + e.message);
  if (r.startsWith('Error') && !/signed out/i.test(r) && !CFG.teams.paused) {
    log(`[Teams ${tg.target}] ${r} → reloading the chat link and trying again`, 'warn');
    await reloadChat(tg).catch(() => {});
    const r2 = await sendTarget(tg, manual).catch(e => 'Error: ' + e.message);
    r = r2.startsWith('Sent') ? r2 + ' (after reloading the chat)' : r2 + ' (also failed after reloading the chat)';
  }
  return r;
}
async function closeStaleChatTabs() {
  RT.chatTabs = RT.chatTabs || {};
  for (const [id, rec] of Object.entries(RT.chatTabs)) {
    const tg = CFG.teams.targets.find(x => x.id === id);
    if (!CFG.teams.tabPerChat || !tg || tg.enabled === false || webChatLink(tg.link) !== rec.link) { await closeTab(rec.tabId); delete RT.chatTabs[id]; saveRt(); }
  }
}
async function waitTeamsReady(tab, sel, ms) {
  let det = null;
  const r = await waitFor(async () => { det = await exec(tab.id, pgTeamsDetect, [sel]).catch(() => null); if (!det) return null; if (det.signedOut) return 'out'; return det.compose ? 'ok' : null; }, ms, 1500);
  return { r, det };
}
async function sendTarget(tg, manual = false) {
  const est = estParts();
  const res = await askDashboard({ type: 'dash:render', target: tg.target, views: tg.views }, 90000);
  if (!res || !res.ok) return `Skipped: dashboard didn't answer (${res && res.why || 'not open'})`;
  if (res.idx !== est.idx) return `Skipped: dashboard is on another interval (${res.idx} vs ${est.idx})`;
  if (res.cmsAgeMin == null) return 'Skipped: no CMS data for this LOB';
  if (res.cmsAgeMin > (+CFG.teams.maxAgeMin || 10)) return `Skipped: CMS data is ${Math.round(res.cmsAgeMin)} min old`;
  if (!res.images.length) return 'Skipped: no pictures selected';
  const sel = CFG.teams.selectors;
  let { tab, fresh } = await chatTab(tg);
  const rec = (RT.chatTabs || {})[tg.id];
  if (rec && rec.holdUntil > now()) await sleep(rec.holdUntil - now());
  if (fresh) { await sleep(1500); try { await waitComplete(tab.id, 60000); } catch (e) { return 'Error: Teams page did not load'; } }
  let { r: ready, det } = await waitTeamsReady(tab, sel, fresh ? 60000 : 8000);
  if (!ready && !fresh) {   // kept tab not usable any more → reload the chat once
    await chrome.tabs.update(tab.id, { url: webChatLink(tg.link) }); await sleep(1500);
    try { await waitComplete(tab.id, 60000); } catch (e) { return 'Error: Teams page did not load'; }
    ({ r: ready, det } = await waitTeamsReady(tab, sel, 60000)); fresh = true;
  }
  if (ready === 'out') { CFG.teams.paused = true; saveCfg(); pushState(); return 'Error: Teams is signed out — sign in once in the worker window, then press Resume'; }
  if (!ready) return `Error: message box not found (${det && det.title || 'no page'})`;
  if (CFG.teams.activateTab !== false) try { await chrome.tabs.update(tab.id, { active: true }); } catch { }   // front tab of the worker window (does not steal your focus)
  await sleep(1200);
  // paste both / all pictures in one go (injection: files built in memory → synthetic paste; drop as fallback)
  const n = res.images.length;
  const attach = async () => {
    const before = await exec(tab.id, pgTeamsComposeState, [sel]).catch(() => ({ html: 0 }));
    const p = await exec(tab.id, pgTeamsPaste, [res.images, sel], 'MAIN', 30000);
    if (!p || !p.ok) return { err: p && p.why || 'paste failed', p };
    let grew = 0;
    const seen = async ms => waitFor(async () => {
      const st = await exec(tab.id, pgTeamsComposeState, [sel]);
      if (st.attachments >= n) return st;
      grew = st.canSend && !st.uploading && st.html > (before.html || 0) + 60 ? grew + 1 : 0;   // editor grew + Send enabled, twice in a row
      return grew >= 2 ? st : null;
    }, ms, 800);
    let att = await seen(20000);
    if (!att) {   // pictures may be in but our counter can't see them: editor grew and Send is enabled
      const st = await exec(tab.id, pgTeamsComposeState, [sel]).catch(() => null);
      if (st && st.canSend && !st.uploading && st.html > (before.html || 0) + 60) att = st;
    }
    if (!att && !p.handled) {   // Teams ignored the paste → try drag & drop
      await exec(tab.id, pgTeamsDrop, [res.images, sel], 'MAIN', 30000);
      att = await seen(15000);
    }
    return { att, p };
  };
  let a1 = await attach();
  if (a1.err) return `Error: ${a1.err}`;
  let restored = null;
  if (!a1.att) {
    RT.send[tg.id] = Object.assign(RT.send[tg.id] || {}, { diag: Object.assign(await exec(tab.id, pgTeamsSnapshot, [sel]).catch(e => ({ err: e.message })), { pasteAccepted: !!a1.p.handled, try: 1 }) }); saveRt();
    // hidden (minimised/covered) tabs get their scripts slowed down by Edge → bring the worker window up once and retry
    if (a1.p.vis === 'hidden' && CFG.teams.restoreToRetry !== false) {
      try { const w = await chrome.windows.get(RT.workerWin); if (w.state === 'minimized') { restored = w.state; await chrome.windows.update(RT.workerWin, { state: 'normal', focused: false }); await sleep(1500); } } catch { }
    }
    await exec(tab.id, pgTeamsClearDraft, [sel]).catch(() => {}); await sleep(800);
    if (restored) a1 = await attach();   // in-place retry only helps when the window was minimised; otherwise the caller reloads the chat
    if (!a1.att) {
      RT.send[tg.id].diag = Object.assign(await exec(tab.id, pgTeamsSnapshot, [sel]).catch(e => ({ err: e.message })), { pasteAccepted: !!(a1.p && a1.p.handled), try: 2 }); saveRt();
      await exec(tab.id, pgTeamsClearDraft, [sel]).catch(() => {});
      if (restored) try { await chrome.windows.update(RT.workerWin, { state: 'minimized' }); } catch { }
      return `Error: pictures did not attach (paste ${a1.p && a1.p.handled ? 'accepted' : 'ignored'} by Teams, tab ${a1.p && a1.p.vis || '?'}) — Automation → Advanced → Diagnose`;
    }
  }
  const att = a1.att;
  const canSend = await waitFor(async () => { const s = await exec(tab.id, pgTeamsComposeState, [sel]); return !s.uploading && s.canSend ? s : null; }, 45000, 1000);
  if (!canSend) return 'Error: upload never finished — draft left in the chat';
  await sleep(1500);   // let Teams settle the attachments before pressing Send
  const clicked = await exec(tab.id, pgTeamsClickSend, [sel]).catch(() => false);   // the Send button itself — never Ctrl+Enter
  if (!clicked) return 'Error: Send button not found or disabled';
  const sent = await waitFor(async () => { const s = await exec(tab.id, pgTeamsComposeState, [sel]); return s.found && s.attachments === 0 ? s : null; }, 25000, 900);
  const hold = now() + Math.max(5, +CFG.teams.holdSec || 20) * 1000;   // pictures keep posting after the box clears — don't touch this tab
  RT.teamsHoldUntil = hold;
  if (RT.chatTabs && RT.chatTabs[tg.id]) { RT.chatTabs[tg.id].holdUntil = hold; if (fresh || !RT.chatTabs[tg.id].title) { const ti = await tabAlive(tab.id); RT.chatTabs[tg.id].title = ti ? normTitle(ti.title) : null; } }
  saveRt();
  if (restored) { await sleep(Math.max(5, +CFG.teams.holdSec || 20) * 1000); try { await chrome.windows.update(RT.workerWin, { state: 'minimized' }); } catch { } }
  if (!sent) return 'Error: Send was clicked but the message box did not clear';
  return `Sent ✓ ${res.images.length} picture${res.images.length > 1 ? 's' : ''} (${res.status || '–'})`;
}

async function teamsCycle() {
  if (BUSY.teams || CFG.teams.paused) return;
  BUSY.teams = true;
  try {
    const est = estParts(); const d = new Date(); const localMin = d.getHours() * 60 + d.getMinutes();
    let sentThisRound = false;
    await closeStaleChatTabs().catch(() => {});
    for (const tg of CFG.teams.targets) {
      if (CFG.teams.paused) break;
      const info = RT.lobStatus[tg.target] || {};
      const status = RT.statusPrev[tg.id] = statusOf(info.value, RT.statusPrev[tg.id]);
      const s = RT.send[tg.id] = RT.send[tg.id] || {};
      const lastOk = s.at ? { at: s.at, idx: s.idx, estDate: s.estDate } : null;
      const due = isDue({ t: tg, last: lastOk, status, est, localMin, nowMs: now() });
      s.next = due.why; s.status = status;
      if (!due.due) continue;
      if (s.failedAt && now() - s.failedAt < 60000) { s.next = 'retrying after an error'; continue; }   // retry a failed send after 1 min
      if (sentThisRound) await sleep((CFG.teams.tabPerChat ? Math.max(0, +CFG.teams.gapSec || 0) : Math.max(5, +CFG.teams.holdSec || 20)) * 1000);
      const result = await sendWithRecovery(tg);
      const ok = result.startsWith('Sent');
      if (ok) sentThisRound = true;
      s.result = result; s.tried = now();
      if (ok) { s.at = now(); s.idx = est.idx; s.estDate = est.estDate; s.failedAt = 0; } else s.failedAt = now();
      log(`[Teams ${tg.target}] ${result}`, ok ? 'info' : result.startsWith('Skipped') ? 'warn' : 'error');
      saveRt(); pushState();
    }
    // open chat tabs ahead of time (one per round) so the first send of each chat doesn't wait for Teams to load
    if (CFG.teams.tabPerChat && !CFG.teams.paused) for (const tg of CFG.teams.targets) {
      if (tg.enabled === false || !tg.link) continue;
      const rec = RT.chatTabs[tg.id];
      if (rec && await tabAlive(rec.tabId)) continue;
      await chatTab(tg).catch(() => {}); break;
    }
  } finally { BUSY.teams = false; }
}

// ------------------------------------------------------------------ Teams desktop-app prompt guard (worker window only)
let guardKey = '';
async function syncGuards() {
  const hosts = new Set(['teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com']);
  for (const tg of CFG.teams.targets) { try { const h = new URL(webChatLink(tg.link)).hostname; if (h) hosts.add(h); } catch { } }
  const matches = [...hosts].map(h => `*://${h}/*`).sort();
  const key = (CFG.teams.blockAppPrompt ? matches.join(',') : 'off') + (CFG.teams.pretendVisible !== false ? '+awake' : '');
  if (key === guardKey) return;
  try {   // after a worker restart: keep what is already registered if it is the same (no unprotected gap)
    const reg = await chrome.scripting.getRegisteredContentScripts({ ids: ['rta-guard', 'rta-guard-main', 'rta-awake'] });
    const want = 2 + (CFG.teams.pretendVisible !== false ? 1 : 0);
    if (CFG.teams.blockAppPrompt && reg.length === want && reg.every(r => (r.matches || []).slice().sort().join(',') === matches.join(','))) { guardKey = key; return; }
  } catch { }
  guardKey = key;
  try { await chrome.scripting.unregisterContentScripts({ ids: ['rta-guard', 'rta-guard-main', 'rta-awake'] }); } catch { }
  if (!CFG.teams.blockAppPrompt && CFG.teams.pretendVisible === false) return;
  try {
    await chrome.scripting.registerContentScripts([
      { id: 'rta-guard', js: ['teams_guard.js'], matches, runAt: 'document_start', allFrames: true, world: 'ISOLATED' },
      { id: 'rta-guard-main', js: ['teams_guard_main.js'], matches, runAt: 'document_start', allFrames: true, world: 'MAIN' },
      ...(CFG.teams.pretendVisible !== false ? [{ id: 'rta-awake', js: ['teams_awake_main.js'], matches, runAt: 'document_start', allFrames: false, world: 'MAIN' }] : [])]);
  } catch (e) { guardKey = ''; log('could not install the Teams app-prompt guard: ' + e.message, 'warn'); }
}

// Teams launcher page → never load it in worker tabs: Edge redirects it to skip.html (session rule limited to our Teams tabs)
const LAUNCH_ORIGINS = ['https://teams.microsoft.com', 'https://teams.cloud.microsoft', 'https://teams.live.com'];
let launchKey = '';
async function syncLauncherRules() {
  RT.chatTabs = RT.chatTabs || {};
  const tabIds = [...new Set([...Object.values(RT.chatTabs).map(r => r.tabId), RT.teamsTab].filter(x => Number.isInteger(x)))].sort((a, b) => a - b);
  const origins = new Set(LAUNCH_ORIGINS);
  for (const tg of CFG.teams.targets) { try { origins.add(new URL(webChatLink(tg.link)).origin); } catch { } }
  const list = [...origins].sort();
  const key = (CFG.teams.blockAppPrompt ? '' : 'off') + tabIds.join(',') + '|' + list.join(',');
  if (key === launchKey) return; launchKey = key;
  const esc = x => x.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const addRules = !CFG.teams.blockAppPrompt || !tabIds.length ? [] : list.map((o, i) => ({
    id: 9100 + i, priority: 1,
    condition: { regexFilter: '^' + esc(o) + '/dl/launcher/', resourceTypes: ['main_frame'], tabIds },
    action: { type: 'redirect', redirect: { transform: { scheme: 'chrome-extension', host: chrome.runtime.id, port: '', path: '/skip.html',
      queryTransform: { addOrReplaceParams: [{ key: 'rtaorigin', value: o }] } } } } }));
  try {
    const old = (await chrome.declarativeNetRequest.getSessionRules()).map(r => r.id).filter(id => id >= 9100 && id < 9200);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old, addRules });
  } catch (e) { launchKey = ''; log('could not set the Teams launcher skip: ' + e.message, 'warn'); }
}
// open a Teams tab safely: blank first → rule covers it → then the chat link
async function openTeamsTab(link, onCreated) {
  const nt = await openTab('about:blank');
  onCreated(nt); saveRt();
  await syncLauncherRules();
  await chrome.tabs.update(nt.id, { url: link });
  return nt;
}

// ------------------------------------------------------------------ main loop
async function tick() {
  try {
    await load();
    await syncGuards().catch(() => {});
    await syncLauncherRules().catch(() => {});
    if (CFG.running.cms && !BUSY.cmsCycle) { BUSY.cmsCycle = true; cmsCycle().catch(e => log('CMS loop error: ' + e.message, 'error')).finally(() => { BUSY.cmsCycle = false; }); }
    if (CFG.running.teams) teamsCycle().catch(e => log('Teams loop error: ' + e.message, 'error'));
  } catch (e) { log('loop error: ' + e.message, 'error'); }
}
chrome.alarms.create('rta-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'rta-tick') tick(); });
let loopTimer = setInterval(tick, 10000);   // finer loop while the worker is alive (the dashboard keeps it alive)

chrome.runtime.onConnect.addListener(port => { if (port.name === 'keepalive') port.onMessage.addListener(() => {}); });
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: DASH + '*' });
  if (tabs.length) { await chrome.tabs.update(tabs[0].id, { active: true }); await chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else chrome.tabs.create({ url: DASH });
});
chrome.runtime.onStartup.addListener(() => { load().then(() => { RT.workerWin = null; RT.tabs = {}; RT.teamsTab = null; RT.chatTabs = {}; saveRt(); }); });

// ------------------------------------------------------------------ messages from the dashboard
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'rta:amIWorker') {   // from teams_guard.js
    (async () => { await load(); return { worker: !!(sender.tab && RT.workerWin && sender.tab.windowId === RT.workerWin) }; })().then(reply, () => reply({ worker: false }));
    return true;
  }
  if (!msg || !String(msg.type || '').startsWith('auto:') && msg.type !== 'dash:status') return;
  (async () => {
    await load();
    switch (msg.type) {
      case 'dash:status': RT.lobStatus = msg.targets || {}; saveRt(); return { ok: true };
      case 'auto:get': return { cfg: CFG, rt: RT, logs: ((await chrome.storage.local.get('rta_log')).rta_log || []).slice(-200), busy: { cms: [...BUSY.cms], teams: BUSY.teams } };
      case 'auto:saveCfg': deepMerge(CFG, msg.patch || {}); if (msg.replace) for (const [k, v] of Object.entries(msg.replace)) { const [a, b] = k.split('.'); CFG[a][b] = v; } await saveCfg(); pushState(); return { ok: true };
      case 'auto:start': CFG.running[msg.what] = true; if (msg.what === 'teams') CFG.teams.paused = false; await saveCfg(); log(`${msg.what === 'cms' ? 'CMS collector' : 'Teams sender'} started`); setTimeout(tick, 200); pushState(); return { ok: true };
      case 'auto:stop': CFG.running[msg.what] = false; await saveCfg(); log(`${msg.what === 'cms' ? 'CMS collector' : 'Teams sender'} stopped`); pushState(); return { ok: true };
      case 'auto:pause': CFG.teams.paused = !!msg.on; await saveCfg(); log(msg.on ? 'Teams sending PAUSED' : 'Teams sending resumed'); pushState(); return { ok: true };
      case 'auto:exportNow': { const r = CFG.cms.reports.find(x => x.id === msg.id); if (r) await exportReport(r, true); return { ok: true, st: RT.exp[msg.id] }; }
      case 'auto:reopen': { const r = CFG.cms.reports.find(x => x.id === msg.id); if (r) await reopenReport(r, 'requested'); return { ok: true }; }
      case 'auto:login': { const r = CFG.cms.reports.find(x => serverOf(x.url) === msg.origin); if (RT.login[msg.origin]) RT.login[msg.origin].until = 0; const ok = r ? await loginServer(msg.origin, r.url) : false; return { ok }; }
      case 'auto:sendNow': { const tg = CFG.teams.targets.find(x => x.id === msg.id); if (!tg) return { ok: false }; const res = await sendWithRecovery(tg, true); RT.send[tg.id] = Object.assign(RT.send[tg.id] || {}, { result: res, tried: now() }); log(`[Teams ${tg.target}] ${res} (manual)`); saveRt(); pushState(); return { ok: true, res }; }
      case 'auto:worker': { const w = await workerWindow(); await chrome.windows.update(w, { focused: true, state: 'normal' }); return { ok: true }; }
      case 'auto:clearLog': LOGS = []; await chrome.storage.local.set({ rta_log: [] }); return { ok: true };
      case 'auto:diagTeams': {
        const out = { version: chrome.runtime.getManifest().version, tabPerChat: CFG.teams.tabPerChat, chats: [] };
        for (const tg of CFG.teams.targets) {
          const rec = (RT.chatTabs || {})[tg.id]; const t = rec ? await tabAlive(rec.tabId) : (CFG.teams.tabPerChat ? null : await tabAlive(RT.teamsTab));
          const row = { chat: tg.target, last: (RT.send[tg.id] || {}).result || '', lastFailure: (RT.send[tg.id] || {}).diag || null };
          if (t) { row.now = await exec(t.id, pgTeamsSnapshot, [CFG.teams.selectors]).catch(e => ({ err: e.message })); row.state = await exec(t.id, pgTeamsComposeState, [CFG.teams.selectors]).catch(e => ({ err: e.message })); }
          else row.now = 'no tab open for this chat yet';
          out.chats.push(row);
        }
        return { ok: true, diag: out };
      }
    }
    return { ok: false };
  })().then(reply, e => reply({ ok: false, error: e.message }));
  return true;
});

load();
