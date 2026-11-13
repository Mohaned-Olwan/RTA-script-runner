// RTA app tabs (only in the RTA Script Runner app): 🗂 Scripts · 💬 Teams desktop · 📑 Reports.
// Same look as the dashboard. Talks to the Python side through window.rtaApp.call('app.<op>', args).
(() => {
  if (!window.rtaApp || !window.rtaApp.call) return;
  const css = document.createElement('style');
  css.textContent = `#scriptsBody input:not([type=checkbox]),#tdeskBody input:not([type=checkbox]),#reportsBody input:not([type=checkbox]){background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:4px 6px;color:var(--text-primary);font-size:12px}
    #scriptsBody select,#tdeskBody select{color:var(--text-primary)} #scriptsBody .btn:disabled,#reportsBody .btn:disabled{opacity:.6}`;
  document.head.appendChild(css);
  const $ = s => document.querySelector(s);
  const call = (op, a) => window.rtaApp.call('app.' + op, a || {}).catch(e => { toast(e.message || String(e), true); throw e; });
  const ST = { s: null, logs: [], seq: 0, busy: false };
  const PAGES = { 'page-scripts': renderScripts, 'page-tdesk': renderTeams, 'page-reports': renderReports };
  const editing = root => { const a = document.activeElement; return a && root && root.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName); };
  const stateCls = s => /^(Running|Waiting)/.test(s) ? 'good' : /^Error/.test(s) ? 'crit' : /^Finished/.test(s) ? 'warn' : 'none';
  const resCls = r => /^(Error|Exit|✗)/.test(r || '') ? 'critTxt' : /^Sent|^OK|^Launched|^✓/.test(r || '') ? '' : /^Skipped/.test(r || '') ? 'warnTxt' : 'muted';
  const targets = () => [...new Set([...(typeof lobGroups === 'function' ? lobGroups().map(g => g.name) : []), ...CFG.lobs.map(l => l.name)])];

  async function poll() {
    if (ST.busy) return;
    ST.busy = true;
    try {
      const s = await window.rtaApp.call('app.state', { since: ST.seq });
      ST.s = s; ST.seq = s.seq;
      if (s.logs.length) { ST.logs.push(...s.logs); if (ST.logs.length > 400) ST.logs.splice(0, ST.logs.length - 400); }
      window.__rtaBusy = !!s.busyAny || !!(window.A_running);
      const page = document.querySelector('.page.active');
      if (page && PAGES[page.id]) PAGES[page.id]();
    } catch (e) { /* app restarting */ } finally { ST.busy = false; }
  }
  setInterval(poll, 1500);
  window.onPageRender = page => { if (PAGES[page]) { if (ST.s) PAGES[page](); poll(); } };
  // ask before closing the window while anything runs (the app answers with a native dialog)
  if (!window.__RTA_NATIVE) window.addEventListener('beforeunload', e => {   // native window: the app asks itself
    let web = false; try { web = !!(window.__rtaWebRunning); } catch (x) { }
    if (window.__rtaBusy || web) { e.preventDefault(); e.returnValue = ''; }
  });
  setInterval(async () => { try { const st = await chrome.runtime.sendMessage({ type: 'auto:get' }); window.__rtaWebRunning = !!(st && st.cfg && (st.cfg.running.cms || st.cfg.running.teams)); } catch (e) { } }, 5000);

  // ---------------------------------------------------------------- shared bits
  function logCard() {
    return `<div class="card" style="padding:12px 16px;margin-top:12px"><div class="row" style="justify-content:space-between"><h2>App log</h2>
      <button class="btn sm" data-a="openLog">Open log file</button></div>
      <pre class="applog" style="max-height:220px;overflow:auto;margin:8px 0 0;font:12px Consolas,monospace;white-space:pre-wrap;color:var(--text-secondary)">${esc(ST.logs.slice(-150).join('\n'))}</pre></div>`;
  }
  function keepLogBottom(root) { const p = root.querySelector('.applog'); if (p) p.scrollTop = p.scrollHeight; }
  function modal(title, hint, onOk, value = '') {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:60;display:flex;align-items:center;justify-content:center';
    d.innerHTML = `<div class="card" style="padding:16px;width:760px;max-width:92vw"><h2>${title}</h2><p class="hint">${hint}</p><textarea style="width:100%;min-height:220px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px;color:var(--text-primary)">${esc(value)}</textarea>
      <div class="row" style="margin-top:8px;justify-content:flex-end"><button class="btn" data-x="c">Cancel</button><button class="btn primary" data-x="o">Add</button></div></div>`;
    document.body.appendChild(d);
    d.querySelector('[data-x=c]').onclick = () => d.remove();
    d.querySelector('[data-x=o]').onclick = () => { onOk(d.querySelector('textarea').value); d.remove(); };
  }
  function rowControls(j, sendLabel) {
    return `<button class="btn sm ${j.active ? '' : 'primary'}" data-a="toggle">${j.active ? '■ Stop' : '▶ Start'}</button>
      <button class="btn sm" data-a="run">${sendLabel}</button><button class="btn sm" data-a="del" title="Remove">✕</button>`;
  }
  function statusCells(j) {
    return `<td data-c="state"><span class="st ${stateCls(j.state || '')}">${esc((j.state || 'Stopped') + (j.status ? ' · ' + j.status : ''))}</span></td>
      <td data-c="next" class="num">${esc(j.next || '—')}</td>
      <td data-c="last" style="max-width:280px"><span class="${resCls(j.result)}">${esc(j.last || '—')}</span></td>`;
  }
  function patchStatus(root, jobs) {   // while typing: only refresh the status cells
    for (const j of jobs) {
      const tr = root.querySelector(`tr[data-id="${j.id}"]`); if (!tr) continue;
      const tmp = document.createElement('tbody'); tmp.innerHTML = `<tr>${statusCells(j)}</tr>`;
      for (const k of ['state', 'next', 'last']) { const a = tr.querySelector(`[data-c=${k}]`), b = tmp.querySelector(`[data-c=${k}]`); if (a && b && a.innerHTML !== b.innerHTML) a.innerHTML = b.innerHTML; }
      const btn = tr.querySelector('[data-a=toggle]'); if (btn) { btn.textContent = j.active ? '■ Stop' : '▶ Start'; btn.classList.toggle('primary', !j.active); }
    }
  }
  function toolbar(kind, addLabel, extra = '') {
    return `<div class="row" style="justify-content:space-between;margin-bottom:10px"><div class="row">
      <button class="btn sm primary" data-a="add" data-kind="${kind}">${addLabel}</button>${extra}
      <button class="btn sm" data-a="startKind" data-kind="${kind}">▶ Start all</button><button class="btn sm" data-a="stopKind" data-kind="${kind}">■ Stop all</button>
      <span class="hint">Stop all at</span><input class="stopAt" placeholder="23:00" style="width:70px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:4px 6px">
      <button class="btn sm" data-a="stopAt" data-kind="${kind}">Apply</button></div>
      <label class="row hint" style="gap:6px"><input type="checkbox" data-a="autostart" ${ST.s.autostart ? 'checked' : ''}> Start all rows (Scripts + Teams desktop) when the app opens</label></div>`;
  }
  const inp = (f, v, w, ph = '') => `<input data-f="${f}" value="${esc(v ?? '')}" placeholder="${esc(ph)}" style="width:${w}px">`;

  async function saveRow(tr) {
    const d = { id: tr.dataset.id };
    tr.querySelectorAll('[data-f]').forEach(e => { d[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value; });
    if (d.every_min !== undefined) { d.every = d.every_min; delete d.every_min; }
    await call('saveJob', d);
  }

  async function onClick(e, root) {
    const b = e.target.closest('[data-a]'); if (!b || b.type === 'checkbox') return;
    const tr = b.closest('tr[data-id]'), a = b.dataset.a;
    try {
      if (a === 'add') { await call('addJob', { kind: b.dataset.kind }); }
      else if (a === 'toggle') { await saveRow(tr); const err = await call('toggleJob', { id: tr.dataset.id }); if (err) toast(err, true); }
      else if (a === 'run') { await saveRow(tr); const err = await call('runJob', { id: tr.dataset.id }); toast(err || (b.textContent.trim() === 'Send' ? 'Queued — watch the result column' : 'Started once')); if (err) toast(err, true); }
      else if (a === 'del') { if (!confirm('Remove this row?')) return; await call('removeJob', { id: tr.dataset.id }); }
      else if (a === 'startKind') { root.querySelectorAll('tr[data-id]').forEach(saveRow); await call('startKind', { kind: b.dataset.kind }); }
      else if (a === 'stopKind') { await call('stopKind', { kind: b.dataset.kind }); }
      else if (a === 'stopAt') { await call('stopAllAt', { kind: b.dataset.kind, time: root.querySelector('.stopAt').value }); toast('Stop time applied — restart running rows to use it'); }
      else if (a === 'browse') { const p = await call('pickFile', { type: 'script', title: 'Choose the script' }); if (p) { tr.querySelector('[data-f=path]').value = p; await saveRow(tr); } }
      else if (a === 'paste') { modal('Paste chat list', 'One per line: <code>TSX: https://teams…/l/chat/…</code> (Teams → chat → ⋯ → Copy link).', async t => { const n = await call('pasteChats', { text: t }); toast(`Added ${n} chat(s)`); poll(); }); return; }
      else if (a === 'pickOut') { const p = await call('pickDir', { title: 'Dashboard picture export folder' }); if (p) { root.querySelector('[data-t=out_dir]').value = p; await saveTeams(root); } }
      else if (a === 'pause') { await call('pause', { on: !ST.s.paused }); }
      else if (a === 'openLog') { await call('openLog'); return; }
      else if (a === 'latRun' || a === 'iexRun') { await saveReports(root); const k = a === 'latRun' ? 'lat' : 'iex';
        const p = k === 'lat' ? { kind: 'lat', date: root.querySelector('[data-r=lat_date]').value, dir: root.querySelector('[data-r=lat_dir]').value,
                                  kinds: ['Voice', 'Chat'].filter(x => root.querySelector(`[data-r=lat_${x.toLowerCase()}]`).checked) }
                              : { kind: 'iex', from: root.querySelector('[data-r=iex_from]').value, to: root.querySelector('[data-r=iex_to]').value, dir: root.querySelector('[data-r=iex_dir]').value };
        const err = await call('runReport', p); if (err) toast(err, true); else toast(`${k.toUpperCase()} export started`); }
      else if (a === 'rosterNow') { await saveReports(root); const err = await call('runReport', { kind: 'roster' }); if (err) toast(err, true); }
      else if (a === 'pickRep') { const p = await call('pickDir', { title: 'Save to' }); if (p) { root.querySelector(`[data-r=${b.dataset.t}]`).value = p; await saveReports(root); } }
      else if (a === 'pickRoster') { const p = await call('pickFile', { type: 'roster', title: 'Roster file' }); if (p) { root.querySelector('[data-r=live_roster]').value = p; await saveReports(root); } }
      else if (a === 'openDir') { await call('openFolder', { path: root.querySelector(`[data-r=${b.dataset.t}]`).value }); return; }
      else if (a === 'today') { b.dataset.t.split(',').forEach(t => { root.querySelector(`[data-r=${t}]`).value = ST.s.reports.today; }); return; }
    } catch (err) { return; }
    poll();
  }
  async function onChange(e, root) {
    const t = e.target;
    if (t.dataset.a === 'autostart') { await call('setAutostart', { on: t.checked }); return; }
    const tr = t.closest('tr[data-id]');
    if (tr && t.dataset.f) { await saveRow(tr); poll(); return; }
    if (t.dataset.t) { await saveTeams(root); return; }
    if (t.dataset.r) { await saveReports(root); poll(); }
  }
  function wire(root) {
    if (root.dataset.wired) return; root.dataset.wired = '1';
    root.addEventListener('click', e => onClick(e, root));
    root.addEventListener('change', e => onChange(e, root));
  }

  // ---------------------------------------------------------------- 🗂 Scripts
  function renderScripts() {
    const root = $('#scriptsBody'); if (!root || !ST.s) return; wire(root);
    const jobs = ST.s.jobs.filter(j => j.kind === 'script');
    const key = JSON.stringify(jobs.map(j => [j.id, j.enabled, j.name, j.path, j.every_min, j.start_at, j.stop_at])) + ST.s.autostart;
    if (root.dataset.key === key || editing(root)) { patchStatus(root, jobs); const p = root.querySelector('.applog'); if (p) { p.textContent = ST.logs.slice(-150).join('\n'); keepLogBottom(root); } return; }
    root.dataset.key = key;
    root.innerHTML = `<div class="card" style="padding:14px 16px">
      <div class="row" style="justify-content:space-between"><h2>🗂 CMS scripts on a timer</h2><span class="hint">.acsauto / .bat / .ps1 / .vbs / .exe · CMS Supervisor must be open and logged in for .acsauto</span></div>
      <div style="margin-top:10px">${toolbar('script', '+ Add script')}</div>
      <div style="overflow:auto"><table class="lobtbl">
        <tr><th>On</th><th>Name</th><th>Script file</th><th>Every (min)</th><th>Start</th><th>Stop</th><th>Status</th><th>Next run</th><th>Last run · result</th><th></th></tr>
        ${jobs.map(j => `<tr data-id="${j.id}"><td><input type="checkbox" data-f="enabled" ${j.enabled ? 'checked' : ''} style="width:auto"></td>
          <td>${inp('name', j.name, 120, 'name')}</td>
          <td style="white-space:nowrap">${inp('path', j.path, 300, 'C:\\…\\export.acsauto')} <button class="btn sm" data-a="browse">…</button></td>
          <td>${inp('every_min', j.every_min, 60)}</td><td>${inp('start_at', j.start_at, 70, 'now')}</td><td>${inp('stop_at', j.stop_at, 70, 'never')}</td>
          ${statusCells(j)}<td style="white-space:nowrap">${rowControls(j, 'Run')}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No scripts yet — + Add script.</td></tr>'}
      </table></div>
      <p class="hint" style="margin:8px 0 0">Times = this PC's clock (Cairo). Every = minutes (0.5 = 30 s). Start/Stop = 23:00 or 11:00 PM; earlier than now = tomorrow. No overlap; a run hanging over 120 s is stopped.</p>
    </div>${logCard()}`;
    keepLogBottom(root);
  }

  // ---------------------------------------------------------------- 💬 Teams desktop
  async function saveTeams(root) {
    const d = {}; root.querySelectorAll('[data-t]').forEach(e => { d[e.dataset.t] = e.type === 'number' ? +e.value : e.value; });
    await call('saveTeams', d);
  }
  function renderTeams() {
    const root = $('#tdeskBody'); if (!root || !ST.s) return; wire(root);
    const s = ST.s, jobs = s.jobs.filter(j => j.kind === 'teams'), t = s.teams;
    const key = JSON.stringify(jobs.map(j => [j.id, j.enabled, j.target, j.link, j.hint, j.every_min, j.every_status, j.start_at, j.stop_at])) + JSON.stringify(t) + s.paused + s.autostart + targets().join();
    if (root.dataset.key === key || editing(root)) { patchStatus(root, jobs); const p = root.querySelector('.applog'); if (p) { p.textContent = ST.logs.slice(-150).join('\n'); keepLogBottom(root); }
      const pb = root.querySelector('[data-a=pause]'); if (pb) pb.textContent = s.paused ? '▶ Resume sending' : '❚❚ Pause sending'; return; }
    root.dataset.key = key;
    const opts = sel => targets().map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('') + (sel && !targets().includes(sel) ? `<option selected>${esc(sel)}</option>` : '');
    root.innerHTML = `<div class="card" style="padding:14px 16px;margin-bottom:12px">
      <div class="row" style="justify-content:space-between"><h2>💬 Teams desktop app (backup sender)</h2>
        <div class="row"><span class="st ${s.paused ? 'warn' : 'none'}">${s.paused ? '❚❚ paused' : s.sending ? '● sending…' : 'idle'}</span><button class="btn sm" data-a="pause">${s.paused ? '▶ Resume sending' : '❚❚ Pause sending'}</button></div></div>
      <p class="hint" style="margin:6px 0 10px">The main sender is <b>⚙ Automation → Teams web</b>. This one uses the Teams desktop app: finds the real "Type a message" box, pastes the pictures, presses Send and checks the picture arrived. It waits until you stop typing. Ctrl+Alt+P pauses desktop + web.${s.uia ? ` <span class="critTxt">UI Automation unavailable: ${esc(s.uia)}</span>` : ''}</p>
      <div class="row">
        <span class="hint">Dashboard picture folder</span><input data-t="out_dir" value="${esc(t.out_dir)}" style="width:260px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:4px 6px"><button class="btn sm" data-a="pickOut">…</button>
        <span class="hint">Wait until idle (s)</span><input data-t="idle_sec" type="number" value="${t.idle_sec}" style="width:60px">
        <span class="hint">Skip if data older than (min)</span><input data-t="max_age_min" type="number" value="${t.max_age_min}" style="width:60px">
        <span class="hint">Give up waiting after (s)</span><input data-t="max_wait_sec" type="number" value="${t.max_wait_sec}" style="width:60px">
      </div></div>
    <div class="card" style="padding:14px 16px">
      ${toolbar('teams', '+ Add chat', '<button class="btn sm" data-a="paste">Paste chat list</button>')}
      <div style="overflow:auto"><table class="lobtbl">
        <tr><th>On</th><th>Dashboard LOB</th><th>Group chat link</th><th>Title contains</th><th>Every · F/T/P</th><th>Start</th><th>Stop</th><th>Status</th><th>Next send</th><th>Last send · result</th><th></th></tr>
        ${jobs.map(j => `<tr data-id="${j.id}"><td><input type="checkbox" data-f="enabled" ${j.enabled ? 'checked' : ''} style="width:auto"></td>
          <td><select data-f="target" class="btn sm">${opts(j.target)}</select></td>
          <td>${inp('link', j.link, 230, 'https://teams…/l/chat/…')}</td><td>${inp('hint', j.hint, 100, 'optional')}</td>
          <td>${inp('every_min', j.every_status || j.every_min, 70)}</td><td>${inp('start_at', j.start_at, 70, 'any')}</td><td>${inp('stop_at', j.stop_at, 70, 'none')}</td>
          ${statusCells(j)}<td style="white-space:nowrap">${rowControls(j, 'Send')}</td></tr>`).join('') || '<tr><td colspan="11" class="muted">No chats yet — + Add chat or Paste chat list.</td></tr>'}
      </table></div>
      <p class="hint" style="margin:8px 0 0">Every: <b>3</b> = every 3 min · <b>1/3/5</b> = every 1 min when failing, 3 when tight, 5 when passing. Sends start at :01 / :31 of each interval; never in its last 45 s; old-interval pictures are never sent. Start/Stop = daily window (PC clock, overnight OK).</p>
    </div>${logCard()}`;
    keepLogBottom(root);
  }

  // ---------------------------------------------------------------- 📑 Reports
  async function saveReports(root) {
    const d = {};
    root.querySelectorAll('[data-r]').forEach(e => {
      const k = e.dataset.r; if (/_(date|from|to)$/.test(k)) return;
      if (/_pw$/.test(k)) { if (e.value) d[k] = e.value; return; }
      d[k] = e.type === 'checkbox' ? e.checked : e.value;
    });
    await call('saveReports', d);
    root.querySelectorAll('[data-r$=_pw]').forEach(e => { if (e.value) { e.value = ''; e.placeholder = 'saved ✓'; } });
  }
  function renderReports() {
    const root = $('#reportsBody'); if (!root || !ST.s) return; wire(root);
    const r = ST.s.reports;
    const live = () => {
      for (const [sel, txt] of [['[data-v=lat_timer]', r.lat_timer], ['[data-v=iex_timer]', r.iex_timer], ['[data-v=lat_msg]', r.msg.lat], ['[data-v=iex_msg]', r.msg.iex], ['[data-v=roster_msg]', (r.msg.roster || '') + ' · last: ' + r.roster_last]]) { const e = root.querySelector(sel); if (e && e.textContent !== txt) e.textContent = txt; }
      for (const k of ['lat', 'iex']) { const b = root.querySelector(`[data-a=${k}Run]`); if (b) { b.disabled = !!r.busy[k]; b.textContent = r.busy[k] ? 'Running…' : `Run ${k.toUpperCase()} export`; } }
      const p = root.querySelector('.applog'); if (p) { p.textContent = ST.logs.slice(-150).join('\n'); keepLogBottom(root); }
    };
    if (root.dataset.built) { live(); return; }
    root.dataset.built = '1';
    const field = (k, label, v, w = 160, type = 'text', ph = '') => `<label class="row hint" style="gap:6px">${label}<input data-r="${k}" type="${type}" value="${esc(v ?? '')}" placeholder="${esc(ph)}" style="width:${w}px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:4px 6px;color:var(--text-primary)"></label>`;
    const chk = (k, label, on) => `<label class="row hint" style="gap:6px"><input type="checkbox" data-r="${k}" ${on ? 'checked' : ''}> ${label}</label>`;
    root.innerHTML = `<div class="setup">
      <div class="card" style="padding:14px 16px">
        <h2>LAT export</h2><p class="hint">cmclineadherence · Detailed Dashboard (Voice) and Chat Dashboard → CSV.</p>
        <div class="row" style="margin-top:8px">${field('lat_user', 'Username', r.lat_user)}${field('lat_pw', 'Password', '', 150, 'password', r.lat_has_pw ? 'saved ✓' : '')}</div>
        <div class="row" style="margin-top:8px">${field('lat_date', 'Date', r.today, 110, 'text', 'MM/DD/YYYY')}<button class="btn sm" data-a="today" data-t="lat_date">Today</button>${chk('lat_voice', 'Voice', r.kinds.includes('Voice'))}${chk('lat_chat', 'Chat', r.kinds.includes('Chat'))}</div>
        <div class="row" style="margin-top:8px">${field('lat_dir', 'Save to', r.lat_dir, 320)}<button class="btn sm" data-a="pickRep" data-t="lat_dir">…</button><button class="btn sm" data-a="openDir" data-t="lat_dir">Open folder</button></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" data-a="latRun">Run LAT export</button><span class="hint" data-v="lat_msg"></span></div>
        <div class="row" style="margin-top:10px">${chk('rep_lat_on', 'Repeat every', r.lat_on)}<input data-r="rep_lat_every_h" type="number" step="0.25" min="0.25" value="${r.lat_every_h}" style="width:64px"> <span class="hint">hours (today's date, EST)</span><span class="hint" data-v="lat_timer"></span></div>
      </div>
      <div class="card" style="padding:14px 16px">
        <h2>IEX Agent Schedules</h2><p class="hint">EG_MU · 1000 COMCAST_EG → schedule file for the dashboard. The site is slow: 2–5 min is normal.</p>
        <div class="row" style="margin-top:8px">${field('iex_user', 'Username', r.iex_user)}${field('iex_pw', 'Password', '', 150, 'password', r.iex_has_pw ? 'saved ✓' : '')}</div>
        <div class="row" style="margin-top:8px">${field('iex_from', 'From', r.today, 110)}${field('iex_to', 'To', r.today, 110)}<button class="btn sm" data-a="today" data-t="iex_from,iex_to">Today</button></div>
        <div class="row" style="margin-top:8px">${field('iex_dir', 'Save to', r.iex_dir, 320)}<button class="btn sm" data-a="pickRep" data-t="iex_dir">…</button><button class="btn sm" data-a="openDir" data-t="iex_dir">Open folder</button></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" data-a="iexRun">Run IEX export</button><span class="hint" data-v="iex_msg"></span></div>
        <div class="row" style="margin-top:10px">${chk('rep_iex_on', 'Repeat every', r.iex_on)}<input data-r="rep_iex_every_h" type="number" step="0.25" min="0.25" value="${r.iex_every_h}" style="width:64px"> <span class="hint">hours (today, EST · also runs when RTA opens)</span><span class="hint" data-v="iex_timer"></span></div>
      </div></div>
    <div class="card" style="padding:14px 16px;margin-top:12px">
      <div class="row" style="justify-content:space-between"><h2>Into the dashboard</h2></div>
      <div class="row" style="margin-top:6px">${chk('rep_load_dash', 'Load each new LAT / IEX file into the dashboard (today\'s files only; Voice + Chat merged)', r.load_dash)}</div>
      <div class="row" style="margin-top:10px">${chk('live_roster_on', 'Roster file: load at start, each new day and when the file changes', r.roster_on)}
        <input data-r="live_roster" value="${esc(r.roster)}" placeholder="C:\\…\\Roster.xlsx" style="width:360px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:4px 6px;color:var(--text-primary)"><button class="btn sm" data-a="pickRoster">…</button>
        <button class="btn sm" data-a="rosterNow">Load now</button><span class="hint" data-v="roster_msg"></span></div>
      <p class="hint" style="margin:8px 0 0">Logins are saved in Windows Credential Manager on this PC (never in a file). Exports use the Edge installed on this PC, in the background.</p>
    </div>${logCard()}`;
    live();
  }
  poll();
})();
