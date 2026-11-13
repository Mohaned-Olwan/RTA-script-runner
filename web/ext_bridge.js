// RTA Realtime — dashboard ↔ extension bridge + Automation tab. Loaded after dashboard.js.
(function () {
  'use strict';
  if (!(window.chrome && chrome.runtime && chrome.runtime.id)) return;
  window.IS_EXT = true;
  const $ = s => document.querySelector(s);
  const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, error: e.message }));
  const ago = t => { if (!t) return '—'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };
  const uid = () => Math.random().toString(36).slice(2, 9);

  // ---------------------------------------------------------------- keep the service worker alive
  let port = null;
  const connect = () => { try { port = chrome.runtime.connect({ name: 'keepalive' }); port.onDisconnect.addListener(() => setTimeout(connect, 1000)); } catch (e) { setTimeout(connect, 3000); } };
  connect();
  setInterval(() => { try { port.postMessage(1); } catch (e) { connect(); } }, 20000);

  // ---------------------------------------------------------------- CMS web data → dashboard
  function applyCms(d) {
    const byLob = {};
    for (const v of Object.values(d || {})) (byLob[v.lob] ||= []).push(v);
    for (const k of Object.keys(S.cms)) if (S.cms[k].source === 'web' && !byLob[k]) delete S.cms[k];
    for (const [lob, arr] of Object.entries(byLob)) {
      const rows = [];
      for (const v of arr) rows.push(...parseCMS([{ rows: splitDelimited(v.text) }]));
      S.cms[lob] = { rows, fileName: `CMS web (${arr.length} report${arr.length > 1 ? 's' : ''})`, mtime: Math.min(...arr.map(v => v.at)), source: 'web', cycle: -1 };
    }
  }
  let cmsTimer = null;
  const reloadCms = () => { clearTimeout(cmsTimer); cmsTimer = setTimeout(async () => { const x = await chrome.storage.local.get('rta_cms'); applyCms(x.rta_cms); compute(); renderAll(); }, 400); };
  reloadCms();

  // ---------------------------------------------------------------- status per target → worker (drives "send more often when failing")
  function targetNames() { return [...lobGroups().map(g => g.name), ...CFG.lobs.map(l => l.name)]; }
  function statusPayload() {
    const out = {};
    if (!S.result) return out;
    for (const n of targetNames()) {
      const Ls = isGroup(n) ? groupLobs(n) : [S.result.lobs[n]].filter(Boolean);
      const vals = Ls.filter(L => L.hasRt && L.hasReq).map(L => CFG.laDriver === 'la' ? L.la : (L.proj ?? L.la)).filter(v => v != null);
      out[n] = { value: vals.length ? Math.min(...vals) : null, idx: TIME.idx };
    }
    return out;
  }
  let lastStatus = '', lastStatusAt = 0;
  const origCompute = compute;
  compute = function () {
    origCompute.apply(this, arguments);
    const p = statusPayload(), j = JSON.stringify(p);
    if (j !== lastStatus || Date.now() - lastStatusAt > 30000) { lastStatus = j; lastStatusAt = Date.now(); send({ type: 'dash:status', targets: p }); }
  };

  // ---------------------------------------------------------------- render pictures for the Teams sender
  async function renderFor(m) {
    compute();
    const name = m.target;
    const Ls = isGroup(name) ? groupLobs(name) : [S.result && S.result.lobs[name]].filter(Boolean);
    if (!Ls.length) return { ok: false, why: `unknown LOB "${name}"` };
    const withData = Ls.filter(L => S.cms[L.name]);
    const base = { ok: true, idx: TIME.idx, estDate: TIME.estDate, images: [] };
    if (!withData.length) return Object.assign(base, { cmsAgeMin: null });
    base.cmsAgeMin = (Date.now() - Math.min(...withData.map(L => S.cms[L.name].mtime))) / 60000;
    const vals = Ls.filter(L => L.hasRt && L.hasReq).map(L => CFG.laDriver === 'la' ? L.la : (L.proj ?? L.la)).filter(v => v != null);
    base.status = vals.length ? laStatus(Math.min(...vals)).t + ' ' + pct(Math.min(...vals)) : '';
    const views = (m.views && m.views.length) ? m.views : picViewsFor(name);
    for (const k of views) {
      const n = picPageCount(k, name);
      for (let i = 0; i < n; i++) {
        const c = await picCanvas(k, name, i);
        base.images.push({ name: `${slug(name)}_${k}${i ? '_' + (i + 1) : ''}.png`, dataUrl: c.toDataURL('image/png') });
      }
    }
    return base;
  }

  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!m || !m.type) return;
    if (m.type === 'cms:data') { reloadCms(); return; }
    if (m.type === 'dash:render') { renderFor(m).then(reply, e => reply({ ok: false, why: e.message })); return true; }
    if (m.type === 'auto:update' || m.type === 'auto:log') { if (document.querySelector('#page-auto.active')) scheduleAuto(); }
  });

  // ---------------------------------------------------------------- Automation tab
  let A = null;          // last state from the worker
  let autoTimer = null;
  const scheduleAuto = () => { clearTimeout(autoTimer); autoTimer = setTimeout(renderAuto, 250); };
  const editing = () => document.activeElement && document.activeElement.closest && document.activeElement.closest('#page-auto') && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  setInterval(() => { if (document.querySelector('#page-auto.active')) renderAuto(); }, 5000);

  async function saveReplace(path, value) { await send({ type: 'auto:saveCfg', replace: { [path]: value } }); }
  async function savePatch(patch) { await send({ type: 'auto:saveCfg', patch }); }

  const LOB_ALIASES = { 'tsx': 'EG TSX 4P', 'tsx 4p': 'EG TSX 4P', 'xmbo': 'EG XM BO', 'xm bo': 'EG XM BO', 'hotline': 'EG Hotline', 'fraud': 'EG Fraud', 'csa': 'CSA (all)', 'mm': 'MM Care', 'mm care': 'MM Care', 'smb voice': 'SMB Voice', 'smb chat': 'SMB Chat', 'bsc': 'BSC', 'bsd': 'BSD', 'csa t1': 'CSA T1', 'csat1': 'CSA T1', 'csa t2': 'CSA T2', 'csat2': 'CSA T2', 'csa spa': 'CSA Spanish', 'csa_spa': 'CSA Spanish', 'csa spanish': 'CSA Spanish' };
  const mapName = l => { const k = String(l).trim().toLowerCase().replace(/^realtime_/, '').replace(/_/g, ' '); return LOB_ALIASES[k] || targetNames().find(n => n.toLowerCase() === k) || l.trim(); };

  window.renderAuto = async function renderAuto() {
    const st = await send({ type: 'auto:get' });
    if (!st || !st.cfg) { $('#autoBody').innerHTML = '<div class="card empty">Automation engine not reachable — press F5 to reload this page.</div>'; return; }
    A = st;
    if (editing()) { renderAutoLive(); return; }
    const c = A.cfg, rt = A.rt;
    const lobOpts = sel => CFG.lobs.map(l => `<option ${l.name === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
    const tgtOpts = sel => targetNames().map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const origins = [...new Set(c.cms.reports.map(r => { try { return new URL(r.url).origin; } catch { return null; } }).filter(Boolean))];
    const run = (what, on) => `<button class="btn sm ${on ? '' : 'primary'}" data-act="${on ? 'stop' : 'start'}" data-what="${what}">${on ? '■ Stop' : '▶ Start'}</button>`;
    $('#autoBody').innerHTML = `
    <div class="card" style="padding:14px 16px;margin-bottom:12px">
      <div class="row" style="justify-content:space-between">
        <div class="row">
          <b>CMS web collector</b> <span class="st ${c.running.cms ? 'good' : 'none'}">${c.running.cms ? '● running' : '○ stopped'}</span> ${run('cms', c.running.cms)}
          <span style="width:18px"></span>
          <b>Teams sender</b> <span class="st ${c.running.teams ? (c.teams.paused ? 'warn' : 'good') : 'none'}">${c.running.teams ? (c.teams.paused ? '❚❚ paused' : '● running') : '○ stopped'}</span> ${run('teams', c.running.teams)}
          ${c.running.teams ? `<button class="btn sm" data-act="pause">${c.teams.paused ? '▶ Resume' : '❚❚ Pause'}</button>` : ''}
        </div>
        <div class="row"><button class="btn sm" data-act="worker">Show CMS / Teams tabs</button></div>
      </div>
      <p class="hint" style="margin:8px 0 0">The CMS report tabs and the Teams chat tabs open in <b>this same window</b>. Keep this dashboard tab open — it runs the automation and draws the pictures. The window can sit behind other windows; don't minimise it.</p>
    </div>

    <div class="card" style="padding:14px 16px;margin-bottom:12px">
      <div class="row" style="justify-content:space-between"><h2>CMS web reports</h2>
        <div class="row"><button class="btn sm" data-act="addRep">+ Add report</button><button class="btn sm" data-act="pasteRep">Paste report list</button></div></div>
      <div style="overflow:auto;margin-top:8px"><table class="lobtbl" id="repTbl">
        <tr><th>On</th><th>LOB</th><th>Report link (CMS web)</th><th>Every (s)</th><th>Status</th><th></th></tr>
        ${c.cms.reports.map(r => { const s = rt.exp[r.id] || {}; const busy = A.busy.cms.includes(r.id);
          return `<tr data-rid="${r.id}"><td><input type="checkbox" data-f="enabled" ${r.enabled ? 'checked' : ''}></td>
          <td><select data-f="lob" class="btn sm">${lobOpts(r.lob)}</select></td>
          <td><input data-f="url" value="${esc(r.url)}" style="min-width:380px"></td>
          <td><input data-f="everySec" type="number" min="30" value="${r.everySec || 60}" style="width:70px"></td>
          <td class="rstat" style="min-width:230px">${busy ? '<span class="st info">exporting…</span>' : s.ok ? `<span class="st good">✓ ${s.rows} agents · ${ago(s.at)}</span>` : s.state === 'logged out' ? '<span class="st warn">logged out → logging in</span>' : s.err ? `<span class="st crit" title="${esc(s.err)}">✗ ${esc(s.err).slice(0, 48)}</span>` : '<span class="muted">—</span>'}</td>
          <td style="white-space:nowrap"><button class="btn sm" data-act="expNow">Export now</button> <button class="btn sm" data-act="reopen">Reopen</button> <button class="btn sm" data-act="delRep">✕</button></td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">No reports yet — Add report or Paste report list.</td></tr>'}
      </table></div>
    </div>

    <div class="setup" style="margin-bottom:12px">
      <div class="card" style="padding:14px 16px">
        <h2>CMS logins</h2>
        <p class="hint">One login per CMS server. Saved in the app's data folder on this PC only. Used only when a report tab shows the login page. After 3 failed logins it waits 15 min (protects the account from lock-out).</p>
        <table class="lobtbl">${origins.map(o => { const cr = c.cms.creds[o] || {}; const lb = rt.login[o] || {};
          return `<tr data-origin="${esc(o)}"><td style="max-width:220px;word-break:break-all"><b>${esc(o)}</b><div class="muted" style="font-size:11px">${lb.at ? 'last login ' + ago(lb.at) : 'not logged in yet'}${lb.until > Date.now() ? ` · waiting ${Math.ceil((lb.until - Date.now()) / 60000)} min after failures` : ''}</div></td>
          <td><input data-c="user" placeholder="username" value="${esc(cr.user || '')}" style="width:130px"></td>
          <td><input data-c="pass" type="password" placeholder="password" value="${esc(cr.pass || '')}" style="width:130px"></td>
          <td style="white-space:nowrap"><button class="btn sm" data-act="saveCred">Save</button> <button class="btn sm" data-act="loginNow">Log in now</button></td></tr>`; }).join('') || '<tr><td class="muted">Add a report first.</td></tr>'}</table>
      </div>
      <div class="card cfg" style="padding:14px 16px">
        <h2>Settings</h2>
        <label><span>Reports exported at the same time</span><input type="number" min="1" max="8" data-set="cms.concurrency" value="${c.cms.concurrency}"></label>
        <label><span>Reopen a report tab after no data for (min)</span><input type="number" min="2" data-set="cms.staleReloadMin" value="${c.cms.staleReloadMin}"></label>
        <label><span>How to read the report</span><select data-set="cms.exportMode"><option value="clipboard" ${c.cms.exportMode !== 'file' ? 'selected' : ''}>In memory via "Export to Clipboard" (no file, no download prompt)</option><option value="file" ${c.cms.exportMode === 'file' ? 'selected' : ''}>Export to File (backup)</option></select></label>
        <label><span>Teams: one tab per chat (opened once and kept — no reloading between sends; more memory)</span><input type="checkbox" data-set="teams.tabPerChat" ${c.teams.tabPerChat !== false ? 'checked' : ''}></label>
        <label><span>Teams: after a send, leave that chat alone for (s) so the pictures finish posting</span><input type="number" min="5" max="120" data-set="teams.holdSec" value="${c.teams.holdSec ?? 20}"></label>
        <label><span>Teams: pause between two chats (s)</span><input type="number" min="0" max="60" data-set="teams.gapSec" value="${c.teams.gapSec ?? 3}"></label>
        <label><span>Teams: skip if CMS data older than (min)</span><input type="number" min="1" data-set="teams.maxAgeMin" value="${c.teams.maxAgeMin}"></label>
        <label><span>Send frequency follows</span><select data-dash="laDriver"><option value="proj" ${CFG.laDriver !== 'la' ? 'selected' : ''}>Interval projection</option><option value="la" ${CFG.laDriver === 'la' ? 'selected' : ''}>Current LA</option></select></label>
        <details style="margin-top:8px"><summary class="muted">Advanced: Teams page selectors</summary>
          <textarea class="paste" id="selJson" style="min-height:140px">${esc(JSON.stringify(c.teams.selectors, null, 1))}</textarea>
          <div class="row"><button class="btn sm" data-act="saveSel">Save selectors</button><button class="btn sm" data-act="diag">Diagnose Teams tabs</button><span id="diagOut" class="muted" style="font-size:11px"></span></div></details>
      </div>
    </div>

    <div class="card" style="padding:14px 16px;margin-bottom:12px">
      <div class="row" style="justify-content:space-between"><h2>Teams group chats</h2>
        <div class="row"><button class="btn sm" data-act="addTg">+ Add chat</button><button class="btn sm" data-act="pasteTg">Paste chat list</button></div></div>
      <p class="hint">Interval-aligned: first send at :01 / :31, then every N min, stops before the interval ends and restarts with the next one. <b>By status</b> = different minutes for Failing / Tight / Passing (beta).</p>
      <div style="overflow:auto"><table class="lobtbl" id="tgTbl">
        <tr><th>On</th><th>LOB / group</th><th>Group chat link</th><th>Pictures</th><th>Frequency (min)</th><th>Start</th><th>Stop</th><th>Status</th><th></th></tr>
        ${c.teams.targets.map(t => { const s = rt.send[t.id] || {}; const v = t.views || [];
          return `<tr data-tid="${t.id}"><td><input type="checkbox" data-f="enabled" ${t.enabled ? 'checked' : ''}></td>
          <td><select data-f="target" class="btn sm">${tgtOpts(t.target)}</select></td>
          <td><input data-f="link" value="${esc(t.link)}" style="min-width:230px"></td>
          <td style="white-space:nowrap">${[['view', 'LA'], ['legacy', 'Legacy'], ['flags', 'Flags'], ['day', 'Day']].map(([k, l]) => `<label style="display:inline-flex;gap:3px;margin-right:6px"><input type="checkbox" data-view="${k}" ${v.includes(k) ? 'checked' : ''}>${l}</label>`).join('')}</td>
          <td style="white-space:nowrap"><select data-f="mode" class="btn sm"><option value="fixed" ${t.mode !== 'status' ? 'selected' : ''}>Every</option><option value="status" ${t.mode === 'status' ? 'selected' : ''}>By status</option></select>
            ${t.mode === 'status' ? `<span class="muted">F</span><input data-f="fail" type="number" step="0.5" min="0.5" value="${t.fail}" style="width:46px"><span class="muted">T</span><input data-f="tight" type="number" step="0.5" min="0.5" value="${t.tight}" style="width:46px"><span class="muted">P</span><input data-f="pass" type="number" step="0.5" min="0.5" value="${t.pass}" style="width:46px">`
              : `<input data-f="every" type="number" step="0.5" min="0.5" value="${t.every}" style="width:56px">`}</td>
          <td><input data-f="start" value="${esc(t.start || '')}" placeholder="now" style="width:64px"></td>
          <td><input data-f="stop" value="${esc(t.stop || '')}" placeholder="never" style="width:64px"></td>
          <td class="tstat" style="min-width:240px;font-size:12px">${s.result ? `<span class="st ${/^Sent/.test(s.result) ? 'good' : /^Skipped/.test(s.result) ? 'warn' : 'crit'}" title="${esc(s.result)}">${esc(s.result).slice(0, 60)}</span> <span class="muted">${ago(s.tried)}</span>` : ''}<div class="muted">${esc(s.next || '')}${s.status && s.status !== 'none' ? ' · ' + s.status : ''}</div></td>
          <td style="white-space:nowrap"><button class="btn sm" data-act="sendNow">Send now</button> <button class="btn sm" data-act="delTg">✕</button></td></tr>`; }).join('') || '<tr><td colspan="9" class="muted">No chats yet — Add chat or Paste chat list.</td></tr>'}
      </table></div>
    </div>

    <div class="card" style="padding:14px 16px">
      <div class="row" style="justify-content:space-between"><h2>Log</h2><button class="btn sm" data-act="clearLog">Clear</button></div>
      <div id="autoLog" style="font-family:Consolas,monospace;font-size:12px;max-height:280px;overflow:auto;margin-top:8px">${A.logs.slice().reverse().map(l => `<div style="color:${l.level === 'error' ? 'var(--crit)' : l.level === 'warn' ? 'var(--warn)' : 'var(--text-secondary)'}">${new Date(l.t).toLocaleTimeString()}  ${esc(l.msg)}</div>`).join('')}</div>
    </div>`;
    wireAuto();
  };

  function renderAutoLive() {   // while typing: refresh only status cells
    for (const tr of document.querySelectorAll('#repTbl tr[data-rid]')) { const s = A.rt.exp[tr.dataset.rid] || {}; const td = tr.querySelector('.rstat'); if (td && s.at) td.textContent = (s.ok ? `✓ ${s.rows} agents · ${ago(s.at)}` : s.err || ''); }
  }

  function wireAuto() {
    const body = $('#autoBody');
    body.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act, b));
    // report rows
    body.querySelectorAll('#repTbl tr[data-rid] [data-f]').forEach(el => el.onchange = async () => {
      const id = el.closest('tr').dataset.rid, reps = A.cfg.cms.reports.map(r => ({ ...r })); const r = reps.find(x => x.id === id);
      r[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value.trim();
      await saveReplace('cms.reports', reps); scheduleAuto();
    });
    // teams rows
    body.querySelectorAll('#tgTbl tr[data-tid] [data-f], #tgTbl tr[data-tid] [data-view]').forEach(el => el.onchange = async () => {
      const id = el.closest('tr').dataset.tid, tgs = A.cfg.teams.targets.map(t => ({ ...t, views: [...(t.views || [])] })); const t = tgs.find(x => x.id === id);
      if (el.dataset.view) { const set = new Set(t.views); el.checked ? set.add(el.dataset.view) : set.delete(el.dataset.view); t.views = ['view', 'legacy', 'flags', 'day'].filter(k => set.has(k)); if (!t.views.length) t.views = ['view']; }
      else t[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value.trim();
      await saveReplace('teams.targets', tgs); scheduleAuto();
    });
    body.querySelectorAll('[data-set]').forEach(el => el.onchange = async () => {
      const [a, b] = el.dataset.set.split('.'); await savePatch({ [a]: { [b]: el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : +el.value } }); scheduleAuto();
    });
    body.querySelectorAll('[data-dash]').forEach(el => el.onchange = () => { CFG[el.dataset.dash] = el.value; saveCfg(); compute(); });
  }

  function pasteDialog(title, hint, onOk) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:60;display:flex;align-items:center;justify-content:center';
    d.innerHTML = `<div class="card" style="padding:16px;width:760px;max-width:92vw"><h2>${title}</h2><p class="hint">${hint}</p><textarea class="paste" style="min-height:220px"></textarea>
      <div class="row" style="margin-top:8px;justify-content:flex-end"><button class="btn" data-x="c">Cancel</button><button class="btn primary" data-x="o">Add</button></div></div>`;
    document.body.appendChild(d);
    d.querySelector('[data-x=c]').onclick = () => d.remove();
    d.querySelector('[data-x=o]').onclick = async () => { await onOk(d.querySelector('textarea').value); d.remove(); };
  }
  const parseLines = txt => txt.split(/\r?\n/).map(l => { const m = l.match(/^\s*(.+?)\s*[:|,\t]\s*((?:https?:\/\/|msteams:)\S+)/i); return m ? [m[1], m[2]] : null; }).filter(Boolean);

  async function act(a, el) {
    const tr = el.closest('tr');
    switch (a) {
      case 'start': case 'stop': await send({ type: 'auto:' + a, what: el.dataset.what }); break;
      case 'pause': await send({ type: 'auto:pause', on: !A.cfg.teams.paused }); break;
      case 'worker': await send({ type: 'auto:worker' }); break;
      case 'addRep': await saveReplace('cms.reports', [...A.cfg.cms.reports, { id: uid(), lob: CFG.lobs[0].name, url: '', everySec: 60, enabled: true }]); break;
      case 'pasteRep': pasteDialog('Paste report list', 'One per line: <code>LOB: report link</code> — e.g. <code>TSX: https://…/CMSWeb/#/reportViewer?…</code>. Labels like realtime_CSAT1, TSX, SMB Voice, MM are understood.', async txt => {
        const items = parseLines(txt); const reps = [...A.cfg.cms.reports];
        for (const [l, u] of items) if (!reps.find(r => r.url === u)) reps.push({ id: uid(), lob: mapName(l), url: u, everySec: 60, enabled: true });
        await saveReplace('cms.reports', reps); toast(`${items.length} report(s) read`); scheduleAuto(); }); return;
      case 'delRep': if (confirm('Remove this report?')) await saveReplace('cms.reports', A.cfg.cms.reports.filter(r => r.id !== tr.dataset.rid)); break;
      case 'expNow': el.textContent = 'Exporting…'; el.disabled = true; await send({ type: 'auto:exportNow', id: tr.dataset.rid }); break;
      case 'reopen': await send({ type: 'auto:reopen', id: tr.dataset.rid }); break;
      case 'saveCred': { const o = tr.dataset.origin; await savePatch({ cms: { creds: { [o]: { user: tr.querySelector('[data-c=user]').value.trim(), pass: tr.querySelector('[data-c=pass]').value } } } }); toast('Login saved for ' + o); break; }
      case 'loginNow': { el.textContent = 'Logging in…'; el.disabled = true; const r = await send({ type: 'auto:login', origin: tr.dataset.origin }); toast(r && r.ok ? 'Logged in ✓' : 'Login failed — see the log', !(r && r.ok)); break; }
      case 'addTg': await saveReplace('teams.targets', [...A.cfg.teams.targets, { id: uid(), target: targetNames()[0], link: '', views: picViewsFor(targetNames()[0]), mode: 'fixed', every: 3, fail: 2, tight: 5, pass: 10, start: '', stop: '', enabled: true, offsetMin: 1 }]); break;
      case 'pasteTg': pasteDialog('Paste chat list', 'One per line: <code>TSX: https://teams.cloud.microsoft/l/chat/…</code> (Teams → chat → ⋯ → Copy link).', async txt => {
        const items = parseLines(txt); const tgs = [...A.cfg.teams.targets];
        for (const [l, u] of items) if (!tgs.find(t => t.link === u)) { const n = mapName(l); tgs.push({ id: uid(), target: n, link: u, views: picViewsFor(n), mode: 'fixed', every: 3, fail: 2, tight: 5, pass: 10, start: '', stop: '', enabled: true, offsetMin: 1 }); }
        await saveReplace('teams.targets', tgs); toast(`${items.length} chat(s) read`); scheduleAuto(); }); return;
      case 'delTg': if (confirm('Remove this chat?')) await saveReplace('teams.targets', A.cfg.teams.targets.filter(t => t.id !== tr.dataset.tid)); break;
      case 'sendNow': el.textContent = 'Sending…'; el.disabled = true; { const r = await send({ type: 'auto:sendNow', id: tr.dataset.tid }); toast(r && r.res ? r.res : 'Send failed', !(r && r.res && r.res.startsWith('Sent'))); } break;
      case 'saveSel': try { const v = JSON.parse($('#selJson').value); await saveReplace('teams.selectors', v); toast('Selectors saved'); } catch (e) { toast('Invalid JSON: ' + e.message, true); } break;
      case 'diag': {
        $('#diagOut').textContent = 'Checking every chat tab…';
        const r = await send({ type: 'auto:diagTeams' }); const txt = JSON.stringify(r && r.diag || r, null, 1);
        window.__rtaDiag = txt;
        const lines = ((r && r.diag && r.diag.chats) || []).map(c => `${c.chat}: ${typeof c.now === 'string' ? c.now : (c.now && c.now.compose ? 'message box found' : 'message box NOT found')}${c.state && c.state.vis ? ' · tab ' + c.state.vis : ''}${c.lastFailure ? ' · last failure saved (' + c.lastFailure.at + ', paste ' + (c.lastFailure.pasteAccepted ? 'accepted' : 'ignored') + ')' : ''}`);
        $('#diagOut').innerHTML = lines.map(l => l.replace(/[<>&]/g, '')).join('<br>') + '<br><button class="btn sm" data-act="diagCopy">Copy diagnostics</button> ← paste it to Claude';
        return;
      }
      case 'diagCopy': { try { await navigator.clipboard.writeText(window.__rtaDiag || ''); toast('Diagnostics copied — paste them in the chat'); } catch (e) { const ta = document.createElement('textarea'); ta.value = window.__rtaDiag || ''; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Diagnostics copied'); } return; }
      case 'clearLog': await send({ type: 'auto:clearLog' }); break;
    }
    scheduleAuto();
  }
})();
