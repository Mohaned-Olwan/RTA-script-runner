"use strict";
/* =========================================================
   CONFIG
   ========================================================= */
const DEFAULT_CFG = {
  refreshSec: 60,
  displayTz: 'CLT',          // CLT or EST
  overrideEst: '',           // "HH:MM" EST for testing; blank = live
  laGood: 100, laWarn: 92,   // LA%: >good = well staffed, ≥warn = tight, else failing
  graceMin: 5,               // break/shift grace
  longCallMin: 20, longAcwSec: 120, longHoldSec: 300, auxOutMin: 20, excessAuxMin: 15, breakOverMin: 3,
  missingSkipBreak: true,
  groups: 'CSA (all)=CSA T1|CSA T2|CSA Spanish',
  picViews: {}, flagsSplit: false, absPct: {}, paidHours: 7.5, laDriver: 'proj',
  exportSec: 60, exportOn: true,
  prodStates: 'AVAIL,ACDIN,ACDOUT,ACD,ACW,ACWIN,ACWOUT,AUXIN,AUXOUT,DACD,DACDIN,DACDOUT,DACW,OTHER,RING,RINGING,HOLD,EXTNIN,EXTNOUT',
  breakAux: 'Break,Lunch,Personal,Prayer',
  coachAux: 'Coaching,NPS,Meeting,Huddle,Team Meeting,One on One',
  trainAux: 'Training',
  systemAux: 'System Problems,System Issue,System Issues',
  projectAux: 'Project,Projects,Special Project',
  projectActs: 'Project,Projects,Special Project',
  onQActs: 'Open,Overtime,Nesting Phone Time,Support Phone Time,RDOT (Rest Day Overtime),Floor Support',
  breakActs: 'Break,Lunch',
  coachActs: 'Coaching,NPS Huddle,Nesting Coaching and Development,Meeting',
  trainActs: 'Training-Bill,Training NonBill,Training',
  systemActs: 'System Issues',
  leaveActs: 'Vacation Leave,Exam Leave_EG,OffRoster/Inactive,PLOA (Planned Inactive),PIE (Planned Inactive),Late Arrival Offered_EG,Sick Leave,Casual Leave,Closed',
  lobs: [
    {name:'EG TSX 4P', fc:'BM_VXI_RP_REP_E_V_CRO', files:'TSX', tiers:'EG TSX 4P', prodAux:''},
    {name:'SMB Voice', fc:'CB_VXI_UNI_SMBCARE_E_V_CRO', files:'SMB Voice,SMB Voice2', tiers:'SMB VOICE', prodAux:''},
    {name:'CSA T1', fc:'BM_VXI_SP_CSAT1_E_V_CRO', files:'CSA T1', tiers:'CSA T1', prodAux:''},
    {name:'CSA T2', fc:'BM_VXI_SP_CSAT2_E_V_CRO', files:'CSA T2', tiers:'CSA T2', prodAux:''},
    {name:'CSA Spanish', fc:'BM_VXI_SP_CSAT1_S_V_CRO', files:'CSA SPA', tiers:'CSA Spanish', prodAux:''},
    {name:'MM Care', fc:'CB_VXI_UNI_SMBVECARE_E_V_CRO', files:'MM Billing', tiers:'MM Care', prodAux:''},
    {name:'EG XM BO', fc:'CF_VXI_SPC_UNLKXM_E_B_CRO', files:'EG XM BO', tiers:'EG XM BO', prodAux:'Task'},
    {name:'EG Hotline', fc:'CF_VXI_SPC_ColHot_E_V_CRO', files:'EG Hotline', tiers:'EG Hotline', prodAux:''},
    {name:'BSD', fc:'CB_VXI_UNI_OMSMB_E_V_CRO', files:'BSD', tiers:'BSD', prodAux:''},
    {name:'BSC', fc:'CB_VXI_UNI_OMSMB_E_B_CRO', files:'BSC', tiers:'BSC', prodAux:'Tasks'},
    {name:'EG Fraud', fc:'CF_VXI_SPC_OVT_E_V_CRO', files:'EG Fraud', tiers:'EG Fraud', prodAux:''},
    {name:'SMB Chat', fc:'CB_VXI_UNI_SMBCARE_E_C_CRO', files:'SMB Chat', tiers:'SMB CHAT', prodAux:''}
  ]
};
const LS = {
  get(k,d){try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true}catch(e){toast('Browser storage full/blocked — data kept in memory only');return false}},
  del(k){try{localStorage.removeItem(k)}catch(e){}}
};
let CFG = Object.assign({}, DEFAULT_CFG, LS.get('rta_cfg', {}));
if(!Array.isArray(CFG.lobs)||!CFG.lobs.length) CFG.lobs = DEFAULT_CFG.lobs.slice();
const saveCfg = () => LS.set('rta_cfg', CFG);
if (CFG.groups==null) CFG.groups = DEFAULT_CFG.groups;
function lobGroups(){ return String(CFG.groups||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{ const [n,m]=x.split('='); return {name:(n||'').trim(), members:String(m||'').split('|').map(y=>y.trim()).filter(Boolean)}; }).filter(g=>g.name&&g.members.length); }
const isGroup = n => lobGroups().some(g=>g.name===n);
function groupLobs(n){ const g=lobGroups().find(g=>g.name===n); const R=S.result; return g&&R ? g.members.map(m=>R.lobs[m]).filter(Boolean) : []; }
const slug = n => String(n).replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
if (CFG.laWarn===90){ CFG.laWarn=92; saveCfg(); }
if (CFG.auxOutMin===10){ CFG.auxOutMin=20; saveCfg(); }
{ const b = CFG.lobs.find(l=>l.name==='BSC'); if (b && !b.prodAux){ b.prodAux='Tasks'; saveCfg(); } }
const list = s => String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
const lset = s => new Set(list(s).map(x=>x.toLowerCase()));

/* =========================================================
   STATE
   ========================================================= */
const S = {
  lat: LS.get('rta_lat', null),         // {date, fileName, loadedAt, req:{fc:[48]}}
  roster: LS.get('rta_roster', null),   // {fileName, loadedAt, agents:[...]}
  sched: LS.get('rta_sched', null),     // {fileName, loadedAt, date, agents:{hrid:{...}}}
  cms: {},                              // lobName -> {rows:[...], fileName, mtime, source}
  cmsMeta: {lastRead:null, folderName:null, files:0, errors:[]},
  dirHandle: null,
  result: null,
  sort: {key:'sev', dir:-1},
  selLob: LS.get('rta_selLob', null)
};
const pasted = LS.get('rta_pasted', {});

/* =========================================================
   TIME — LAT + schedules are EST; PC clock is Cairo
   ========================================================= */
function tzParts(date, tz){
  const f = new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const o = {}; f.formatToParts(date).forEach(p=>o[p.type]=p.value);
  return {y:+o.year, mo:+o.month, d:+o.day, h:+o.hour, mi:+o.minute, s:+o.second};
}
function nowCtx(){
  const real = new Date();
  const e = tzParts(real,'America/New_York'), c = tzParts(real,'Africa/Cairo');
  const toAbs = p => Date.UTC(p.y,p.mo-1,p.d,p.h,p.mi,p.s);
  const offsetMin = Math.round((toAbs(c)-toAbs(e))/60000);   // Cairo − EST (420 in Nov)
  let estMin = e.h*60 + e.mi + e.s/60;
  let override = false;
  if (CFG.overrideEst && /^\d{1,2}:\d{2}$/.test(CFG.overrideEst)) {
    const [h,m] = CFG.overrideEst.split(':').map(Number); estMin = h*60+m; override = true;
  }
  const estDate = `${String(e.mo).padStart(2,'0')}/${String(e.d).padStart(2,'0')}/${e.y}`;
  return {estMin, offsetMin, estDate, override, idx: Math.floor(estMin/30)};
}
const pad = n => String(n).padStart(2,'0');
function fmtMin(m, tz){           // m = minutes after EST midnight
  if (m==null || isNaN(m)) return '–';
  const ctx = TIME || nowCtx();
  if ((tz||CFG.displayTz)==='CLT') m += ctx.offsetMin;
  m = ((Math.round(m)%1440)+1440)%1440;
  let h = Math.floor(m/60), mi = m%60, ap = h>=12?'PM':'AM'; h = h%12||12;
  return `${h}:${pad(mi)} ${ap}`;
}
function fmtDur(sec){
  if (sec==null||isNaN(sec)) return '–';
  sec = Math.max(0,Math.round(sec));
  const h=Math.floor(sec/3600), m=Math.floor(sec%3600/60), s=sec%60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
const shortT = m => fmtMin(m).replace(':00','').replace(' AM','a').replace(' PM','p');
const intLabel = (i,tz) => `${fmtMin(i*30,tz)} – ${fmtMin(i*30+30,tz)}`;
let TIME = null;

/* =========================================================
   PARSING HELPERS
   ========================================================= */
function parseClock(v){            // -> minutes after midnight
  if (v==null || v==='') return null;
  if (v instanceof Date) return v.getHours()*60+v.getMinutes();
  if (typeof v==='number') { const f = v - Math.floor(v); return Math.round(f*1440); }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h=+m[1], mi=+m[2];
  if (m[4]) { const pm=/p/i.test(m[4]); if (h===12) h=0; if (pm) h+=12; }
  return h*60+mi;
}
function parseSec(v){              // CMS "Time": seconds or h:mm:ss / mm:ss
  if (v==null || v==='') return 0;
  if (typeof v==='number') return v<1 && v>0 ? v*86400 : v;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  const p = s.split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return p.length===3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1];
}
const idStr = v => { if (v==null||v==='') return ''; if (typeof v==='number') return String(Math.round(v)); return String(v).trim().replace(/\.0+$/,''); };
const norm = s => String(s==null?'':s).trim().toLowerCase().replace(/\s+/g,' ');

function splitDelimited(text){
  text = text.replace(/^\uFEFF/,'');
  const lines = text.split(/\r?\n/).filter(l=>l.trim()!=='');
  if (!lines.length) return [];
  const sample = lines.slice(0,20).join('\n');
  const cnt = c => (sample.match(new RegExp(c==='|'?'\\|':c,'g'))||[]).length;
  const cands = ['\t',',',';','|'].map(c=>[c,cnt(c)]).sort((a,b)=>b[1]-a[1]);
  const d = cands[0][1] ? cands[0][0] : '\t';
  return lines.map(line=>{
    if (d!==',' || line.indexOf('"')<0) return line.split(d);
    const out=[]; let cur='', q=false;
    for (let i=0;i<line.length;i++){const ch=line[i];
      if (q){ if(ch==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
      else if (ch==='"') q=true; else if (ch===d){out.push(cur);cur='';} else cur+=ch; }
    out.push(cur); return out;
  });
}
async function fileToSheets(file){  // -> [{name, rows:[[...]]}]
  const name = file.name||'';
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0,8));
  const isZip = head[0]===0x50 && head[1]===0x4B;          // xlsx/xlsb
  const isOle = head[0]===0xD0 && head[1]===0xCF;          // xls
  if (isZip || isOle || /\.(xlsx|xlsb|xls|xlsm)$/i.test(name)) {
    const wb = XLSX.read(buf, {type:'array', cellDates:false});
    return wb.SheetNames.map(n=>({name:n, rows:XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,raw:true,defval:null,blankrows:false})}));
  }
  const text = new TextDecoder('utf-8').decode(buf);
  return [{name, rows: splitDelimited(text)}];
}
function findHeader(rows, mustHave, maxScan=40){
  for (let i=0;i<Math.min(rows.length,maxScan);i++){
    const r = (rows[i]||[]).map(norm);
    if (mustHave.every(h=>r.some(c=>c===h || c.replace(/\s/g,'')===h.replace(/\s/g,'')))) return i;
  }
  return -1;
}
function colIdx(header, names){
  const h = header.map(norm);
  for (const n of names){ const i = h.findIndex(c=>c===n || c.replace(/\s/g,'')===n.replace(/\s/g,'')); if (i>=0) return i; }
  return -1;
}
function detectKind(sheets){
  for (const sh of sheets){
    const r = sh.rows;
    if (findHeader(r,['forecast name','interval'])>=0) return 'lat';
    if (r.slice(0,40).some(row=>(row||[]).some(c=>typeof c==='string' && /^Agent:\s*\d+/.test(c)))) return 'sched';
    if (findHeader(r,['hrid','activity start'])>=0) return 'sched';
    if (findHeader(r,['full name','supervisor'])>=0 || findHeader(r,['hrid2','supervisor'])>=0) return 'roster';
  }
  return null;
}

/* ---------- LAT ---------- */
function parseLAT(sheets){
  for (const sh of sheets){
    const rows = sh.rows, hi = findHeader(rows,['forecast name','interval']);
    if (hi<0) continue;
    const H = rows[hi], cF=colIdx(H,['forecast name']), cI=colIdx(H,['interval']), cR=colIdx(H,['req']), cD=colIdx(H,['date']), cB=colIdx(H,['be req']), cP=colIdx(H,['prem req']), cA=colIdx(H,['act req']);
    if (cR<0) throw new Error('LAT file: no REQ column');
    const req = {}, be = {}, prem = {}, act = {}; let date=null;
    for (let i=hi+1;i<rows.length;i++){
      const r = rows[i]; if (!r||r[cF]==null) continue;
      const fc = String(r[cF]).trim(), m = parseClock(r[cI]); if (m==null) continue;
      const idx = Math.floor(m/30); if (idx<0||idx>47) continue;
      (req[fc] ||= new Array(48).fill(0))[idx] += (+r[cR]||0);
      if (cB>=0) (be[fc] ||= new Array(48).fill(0))[idx] += (+r[cB]||0);
      if (cP>=0) (prem[fc] ||= new Array(48).fill(0))[idx] += (+r[cP]||0);
      if (cA>=0) (act[fc] ||= new Array(48).fill(0))[idx] += (+r[cA]||0);
      if (!date && cD>=0 && r[cD]!=null) date = typeof r[cD]==='number' ? XLSX.SSF.format('mm/dd/yyyy',r[cD]) : String(r[cD]);
    }
    return {date, req, be, prem, act, forecasts:Object.keys(req).length};
  }
  throw new Error('Not a LAT export (needs Forecast Name / Interval / REQ)');
}
/* ---------- Roster ---------- */
function parseRoster(sheets){
  for (const sh of sheets){
    const rows = sh.rows;
    let hi = findHeader(rows,['full name','supervisor']); if (hi<0) hi = findHeader(rows,['hrid2','supervisor']);
    if (hi<0) continue;
    const H=rows[hi];
    const c = {
      hrid: colIdx(H,['hrid2','hrid','hr id']), name: colIdx(H,['full name','agent name','name']),
      login: colIdx(H,['avaya id2','avaya id','login id','avaya']), ext: colIdx(H,['extension','extn','ext']),
      sup: colIdx(H,['supervisor','team leader','tl']), om: colIdx(H,['om','operations manager','manager']),
      tier: colIdx(H,['tier','lob']), status: colIdx(H,['status']), lwd: colIdx(H,['lwd'])
    };
    if (c.hrid<0||c.login<0) continue;
    const agents=[];
    for (let i=hi+1;i<rows.length;i++){
      const r=rows[i]; if(!r) continue; const hrid=idStr(r[c.hrid]); if(!hrid) continue;
      agents.push({hrid, name:String(r[c.name]??'').trim(), login:idStr(r[c.login]), ext:c.ext>=0?idStr(r[c.ext]):'',
        sup:String(r[c.sup]??'').trim(), om:String(r[c.om]??'').trim(), tier:String(r[c.tier]??'').trim(),
        status:c.status>=0?String(r[c.status]??'').trim():'', lwd:c.lwd>=0?(r[c.lwd]??''):''});
    }
    return {agents};
  }
  throw new Error('Not a roster (needs HRID, Full name, Avaya ID, Supervisor)');
}
/* ---------- Schedule (NICE IEX "Agent Schedules" report or flat table) ---------- */
function parseSchedule(sheets){
  const out = {}; let date=null;
  for (const sh of sheets){
    const rows = sh.rows;
    // flat format: HRID | Shift Start | Shift End | Scheduled Activity | Activity Start | Activity End
    const fh = findHeader(rows,['hrid','activity start']);
    if (fh>=0){
      const H=rows[fh], c={h:colIdx(H,['hrid']),n:colIdx(H,['name','agent name']),ss:colIdx(H,['shift start']),se:colIdx(H,['shift end']),a:colIdx(H,['scheduled activity','activity']),as:colIdx(H,['activity start']),ae:colIdx(H,['activity end'])};
      for (let i=fh+1;i<rows.length;i++){ const r=rows[i]; if(!r) continue; const h=idStr(r[c.h]); if(!h) continue;
        const a = out[h] ||= {hrid:h,name:String(r[c.n]??''),off:false,start:parseClock(r[c.ss]),end:parseClock(r[c.se]),acts:[]};
        const nm=String(r[c.a]??'').trim(); const s=parseClock(r[c.as]), e=parseClock(r[c.ae]);
        if (nm && s!=null && e!=null) a.acts.push({name:nm,s,e});
      }
      continue;
    }
    let cur=null, col=null;
    for (const r of rows){
      if (!r) continue;
      const agentCell = r.find(c=>typeof c==='string' && /^Agent:\s*\d+/.test(c));
      if (agentCell){ const m=agentCell.match(/^Agent:\s*(\d+)\s*(.*)$/); cur = out[m[1]] ||= {hrid:m[1],name:m[2].trim(),off:false,start:null,end:null,acts:[]}; continue; }
      const dr = r.find(c=>typeof c==='string' && /^Date Range:/i.test(c));
      if (dr && !date){ const m=dr.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/); if(m) date=m[1]; }
      const lc = r.map(norm);
      if (lc.includes('date') && lc.includes('start')){
        const starts=[],ends=[]; lc.forEach((v,i)=>{if(v==='start')starts.push(i); if(v==='end')ends.push(i);});
        col={date:lc.indexOf('date'), ss:starts[0], se:ends[0], as:starts[1], ae:ends[1]}; continue;
      }
      if (!cur || !col) continue;
      const dateV = r[col.date];
      if (dateV!=null && dateV!==''){
        const sv = r[col.ss];
        if (typeof sv==='string' && /off/i.test(sv)) { cur.off=true; continue; }
        const ps=parseClock(sv), pe=parseClock(r[col.se]); if (ps!=null){ cur.start=ps; cur.end=pe; }
      }
      if (col.as!=null){
        const s=parseClock(r[col.as]), e=parseClock(r[col.ae]);
        if (s!=null && e!=null){
          let nm=null; for (let k=(col.se??0)+1;k<col.as;k++){ if (r[k]!=null && String(r[k]).trim()){ nm=String(r[k]).trim(); break; } }
          if (nm) cur.acts.push({name:nm,s,e});
        }
      }
    }
  }
  // normalise overnight
  for (const a of Object.values(out)){
    if (a.start!=null && a.end!=null && a.end<=a.start) a.end+=1440;
    let prev = a.start ?? 0;
    for (const x of a.acts){ if (x.s < prev-180) { x.s+=1440; x.e+=1440; } if (x.e<=x.s) x.e+=1440; prev=x.s; }
    if (a.start==null && a.acts.length){ a.start=a.acts[0].s; a.end=a.acts[a.acts.length-1].e; }
    if (a.acts.length) a.off=false; else if (!a.off) a.off = a.start==null;
  }
  const n = Object.keys(out).length;
  if (!n) throw new Error('No agents found in schedule file');
  return {date, agents:out};
}
/* ---------- CMS real-time agent report ---------- */
const CMS_STD = ['agent name','login id','extn','aux reason','state','split/skill','time','vdn name','interrupt status'];
function parseCMS(sheets){
  const rows = sheets[0].rows; const out=[];
  let hi = findHeader(rows,['login id'],30), c;
  if (hi>=0){
    const H=rows[hi];
    c={name:colIdx(H,['agent name','agent full name','name']),login:colIdx(H,['login id','loginid']),ext:colIdx(H,['extn','extension']),
       aux:colIdx(H,['aux reason','reason code','aux']),state:colIdx(H,['state','current state']),skill:colIdx(H,['split/skill','skill']),
       time:colIdx(H,['time','time in state','agent time']),vdn:colIdx(H,['vdn name','vdn'])};
  } else { hi=-1; c={name:0,login:1,ext:2,aux:3,state:4,skill:5,time:6,vdn:7}; }
  for (let i=hi+1;i<rows.length;i++){
    const r=rows[i]; if(!r) continue;
    const login=idStr(r[c.login]); if(!/^\d{4,}$/.test(login)) continue;
    out.push({name:String(r[c.name]??'').trim(), login, ext:c.ext>=0?idStr(r[c.ext]):'', aux:String(r[c.aux]??'').trim(),
      state:String(r[c.state]??'').trim().toUpperCase(), skill:c.skill>=0?String(r[c.skill]??''):'', sec:parseSec(r[c.time]), vdn:c.vdn>=0?String(r[c.vdn]??''):''});
  }
  return out;
}
function lobForFile(fileName){
  const base = norm(fileName.replace(/\.[^.]+$/,''));
  const l = CFG.lobs.find(l=>list(l.files).some(f=>norm(f)===base));
  return l ? l.name : null;
}

/* =========================================================
   LOADING
   ========================================================= */
async function loadDayFile(file, kindHint){
  try{
    const sheets = await fileToSheets(file);
    const kind = kindHint || detectKind(sheets);
    const meta = {fileName:file.name, loadedAt:Date.now()};
    if (kind==='lat'){ S.lat = Object.assign(parseLAT(sheets),meta); LS.set('rta_lat',S.lat); toast(`LAT loaded · ${S.lat.forecasts} forecasts`); }
    else if (kind==='roster'){ S.roster = Object.assign(parseRoster(sheets),meta); LS.set('rta_roster',S.roster); toast(`Roster loaded · ${S.roster.agents.length} agents`); }
    else if (kind==='sched'){ S.sched = Object.assign(parseSchedule(sheets),meta); LS.set('rta_sched',S.sched); toast(`Schedule loaded · ${Object.keys(S.sched.agents).length} agents`); }
    else throw new Error('Could not recognise this file');
  }catch(e){ console.error(e); toast(`${file.name}: ${e.message}`, true); }
  renderAll();
}
async function loadCmsFile(file, lobOverride){
  const lob = lobOverride || lobForFile(file.name);
  if (!lob){ S.cmsMeta.errors.push(`${file.name}: no LOB mapped`); return; }
  const rows = parseCMS(await fileToSheets(file));
  const prev = S.cms[lob];
  // merge files of the same LOB (e.g. SMB Voice + SMB Voice2) within one read cycle
  if (prev && prev.cycle===S.cmsMeta.cycle){ prev.rows.push(...rows); prev.fileName+=' + '+file.name; prev.mtime=Math.max(prev.mtime,file.lastModified||0); }
  else S.cms[lob] = {rows, fileName:file.name, mtime:file.lastModified||Date.now(), cycle:S.cmsMeta.cycle, source:'file'};
}
async function readFolder(interactive){
  if (!S.dirHandle) return;
  try{
    let perm = await S.dirHandle.queryPermission({mode:'read'});
    if (perm!=='granted' && interactive) perm = await S.dirHandle.requestPermission({mode:'read'});
    if (perm!=='granted'){ S.cmsMeta.needPerm=true; renderPills(); return; }
    S.cmsMeta.needPerm=false; S.cmsMeta.cycle=(S.cmsMeta.cycle||0)+1; S.cmsMeta.errors=[];
    for (const k of Object.keys(S.cms)) if (S.cms[k].source==='file') delete S.cms[k];
    let n=0;
    for await (const [name,h] of S.dirHandle.entries()){
      if (h.kind!=='file' || !/\.(txt|csv|xlsx|xls)$/i.test(name)) continue;
      try{ await loadCmsFile(await h.getFile()); n++; }catch(e){ S.cmsMeta.errors.push(`${name}: ${e.message}`); }
    }
    S.cmsMeta.files=n; S.cmsMeta.lastRead=Date.now(); S.cmsMeta.folderName=S.dirHandle.name;
  }catch(e){ console.error(e); S.cmsMeta.errors.push(e.message); }
  applyPasted(); compute(); renderAll();
}
function applyPasted(){
  for (const [lob,p] of Object.entries(pasted)){
    if (S.cms[lob] && S.cms[lob].source==='file') continue;
    S.cms[lob] = {rows:parseCMS([{rows:splitDelimited(p.text)}]), fileName:'pasted', mtime:p.at, source:'paste'};
  }
}
/* IndexedDB just for the folder handle */
const idb = {
  db(){return new Promise((res,rej)=>{const r=indexedDB.open('rta',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});},
  async get(k){const d=await this.db();return new Promise(res=>{const q=d.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>res(null);});},
  async set(k,v){const d=await this.db();return new Promise(res=>{const t=d.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=()=>res(true);t.onerror=()=>res(false);});}
};

/* =========================================================
   ENGINE
   ========================================================= */
function classifyAct(name){
  const n = norm(name);
  if (lset(CFG.onQActs).has(n)) return 'onq';
  if (lset(CFG.breakActs).has(n)) return 'break';
  if (lset(CFG.leaveActs).has(n)) return 'leave';
  if (lset(CFG.coachActs).has(n)) return 'coach';
  if (lset(CFG.trainActs).has(n)) return 'train';
  if (lset(CFG.systemActs).has(n)) return 'system';
  if (lset(CFG.projectActs||'').has(n) || /project/.test(n)) return 'project';
  return 'ooq';
}
function actAt(sch, m){
  if (!sch || sch.off) return null;
  for (const a of sch.acts) if (m>=a.s && m<a.e) return a;
  return null;
}
function actNear(sch, m, g, cat){   // any activity of category within ±grace
  if (!sch || sch.off) return null;
  return sch.acts.find(a=>classifyAct(a.name)===cat && m>=a.s-g && m<a.e+g) || null;
}
function tierToLob(tier){
  const t = norm(tier);
  const l = CFG.lobs.find(l=>list(l.tiers).some(x=>norm(x)===t) || norm(l.name)===t);
  return l ? l.name : (tier||'Unmapped');
}
const FLAG = {  // name -> severity 3 critical, 2 warning, 1 info
  'Missing':3,'Unscheduled Break':3,'Exceeding Break':2,'Unproductive AUX':3,'Unscheduled Coaching':2,'Default AUX':3,
  'Excessive AUX':3,'System Issue':2,'Long Call':2,'Long ACW':2,'Long Hold/Other':2,'Outbound Parking':2,
  'Outside Shift':2,'Logged in on Off/Leave':2,'Not in Roster':1,'Skipped Break':1
};
function minKey(){ const t=TIME||nowCtx(); return 'rta_min_'+(t.override?'sim_':'')+t.estDate.replace(/\//g,'')+'_'+t.idx; }
function editMinutes(lob, list, raw){
  const mk=minKey(), mins=LS.get(mk,{}), t=(mins[lob] ||= {});
  const v = String(raw).replace('%','').trim();
  const n = parseFloat(v);
  if (v!=='' && isNaN(n)) { toast('Enter LA as a number, e.g. 95.4',true); return; }
  for (const m of list){ if (v==='') delete t[m]; else t[m]={la:n/100, man:true}; }
  LS.set(mk,mins); if (list.length>1) toast(`${v===''?'Cleared':'Set'} ${list.length} minutes${v===''?'':' to '+n+'%'}`);
  if (S.minSel) S.minSel.set=new Set();
  S._applying=true; if (document.activeElement) document.activeElement.blur(); S._applying=false;
  compute(); renderLobView(S.selLob);
}
function offKey(){ const t=TIME||nowCtx(); return 'rta_off_'+t.estDate.replace(/\//g,''); }
function getOff(){ const o=LS.get(offKey(),null)||{absent:[],wins:[]}; o.absent ||= []; o.wins ||= []; return o; }
function setOff(o){ LS.set(offKey(),o); }
function cltToEst(hhmm){ if(!hhmm) return null; const [h,m]=hhmm.split(':').map(Number); if(isNaN(h)) return null; const t=TIME||nowCtx(); let v=h*60+m-(CFG.displayTz==='CLT'?t.offsetMin:0); return ((v%1440)+1440)%1440; }
function excusedNow(hr, m){
  if (!hr) return false;
  for (const w of getOff().wins){
    if (String(w.hrid).trim()!==hr) continue;
    const a=cltToEst(w.start), b0=cltToEst(w.end); if (a==null||b0==null) continue;
    let b=b0; if (b<=a) b+=1440;
    if ((m>=a && m<b) || (m+1440>=a && m+1440<b)) return true;
  }
  return false;
}
function compute(){
  TIME = nowCtx();
  const m = TIME.estMin, idx = TIME.idx, g = +CFG.graceMin||0;
  const prodStates = lset(CFG.prodStates), pjA=lset(CFG.projectAux||'Project'), brA=lset(CFG.breakAux), coA=lset(CFG.coachAux), trA=lset(CFG.trainAux), syA=lset(CFG.systemAux);
  const roster = S.roster ? S.roster.agents : [];
  const byLogin = new Map(), byExt = new Map(), byHr = new Map();
  for (const a of roster){ if(a.login) byLogin.set(a.login,a); if(a.ext) byExt.set(a.ext,a); byHr.set(a.hrid,a); }
  const sched = S.sched ? S.sched.agents : {};
  const lobs = {};
  for (const l of CFG.lobs){
    const fcs = list(l.fc), reqArr = new Array(48).fill(0), beArr = new Array(48).fill(0), premArr = new Array(48).fill(0), actArr = new Array(48).fill(0); let hasReq=false;
    if (S.lat) for (const f of fcs){ const a=S.lat.req[f]; if(a){hasReq=true; a.forEach((v,i)=>reqArr[i]+=v);}
      const b=(S.lat.be||{})[f]; if(b) b.forEach((v,i)=>beArr[i]+=v); const q=(S.lat.prem||{})[f]; if(q) q.forEach((v,i)=>premArr[i]+=v); const z=(S.lat.act||{})[f]; if(z) z.forEach((v,i)=>actArr[i]+=v); }
    lobs[l.name] = {name:l.name, cfg:l, reqArr, beArr, premArr, actArr, hasReq, req:reqArr[idx]||0, be:beArr[idx]||0, prem:premArr[idx]||0, nextReq:reqArr[idx+1]||0, hasRt:!!S.cms[l.name],
      logged:0, prod:0, prodNoNest:0, states:{avail:0,acd:0,acw:0,other:0,auxout:0,prodaux:0,brk:0,coach:0,unprod:0},
      schedOnQ:0, schedBreak:0, schedOOQ:0, schedLeave:0, inShift:0, nsRaw:0, schedArr:new Array(48).fill(0), flags:{}, agents:[]};
  }
  const agents = []; const seen = new Set();
  // ---- logged-in agents
  for (const [lobName, src] of Object.entries(S.cms)){
    const L = lobs[lobName]; if (!L) continue;
    const prodAux = lset(L.cfg.prodAux); const dedup = new Set();
    for (const r of src.rows){
      if (dedup.has(r.login)) continue; dedup.add(r.login); seen.add(r.login);
      const ro = byLogin.get(r.login) || (r.ext && byExt.get(r.ext)) || null;
      const sch = ro ? sched[ro.hrid] : null;
      const act = actAt(sch, m), cat = act ? classifyAct(act.name) : null;
      const st = r.state, aux = norm(r.aux);
      let productive = false, grp='other';
      if (st==='AUX'){
        if (prodAux.has(aux)) { productive=true; grp='prodaux'; }
        else if (brA.has(aux)) grp='brk'; else if (coA.has(aux)||trA.has(aux)) grp='coach'; else if (pjA.has(aux) && actNear(sch,m,g,'project')) grp='coach'; else grp='unprod';
      } else if (prodStates.has(norm(st))) {
        productive = true;
        grp = st==='AVAIL'?'avail': /ACD/.test(st)?'acd': /ACW/.test(st)?'acw': st==='AUXOUT'||st==='AUXIN'?'auxout':'other';
      } else grp='other';
      const nest = ro && /nest/i.test(ro.status);
      const flags = [];
      if (!ro) flags.push('Not in Roster');
      if (ro && sch){
        const off = sch.off || sch.start==null;
        const leaveNow = act && cat==='leave';
        if (off || leaveNow) flags.push('Logged in on Off/Leave');
        else if (m < sch.start-g*3 || m >= sch.end+g*3) flags.push('Outside Shift');
      }
      if (st==='AUX'){
        if (prodAux.has(aux)) {}
        else if (brA.has(aux)){
          const b = actNear(sch,m,g,'break');
          if (!b) flags.push('Unscheduled Break');
          else { const allowed=(b.e-b.s+(+CFG.breakOverMin||0))*60; if (r.sec>allowed) flags.push('Exceeding Break'); }
        } else if (coA.has(aux)){
          if (!actNear(sch,m,g,'coach')) flags.push('Unscheduled Coaching');
        } else if (trA.has(aux)){
          if (!actNear(sch,m,g,'train')) flags.push('Unproductive AUX');
        } else if (pjA.has(aux)){
          if (!actNear(sch,m,g,'project')) flags.push('Unproductive AUX');
        } else if (syA.has(aux)){
          flags.push('System Issue');
        } else if (aux==='' || aux==='0' || aux==='default'){
          flags.push('Default AUX');
        } else flags.push('Unproductive AUX');
        if ((flags.includes('Unproductive AUX')||flags.includes('Default AUX')) && r.sec > (+CFG.excessAuxMin||15)*60) flags.push('Excessive AUX');
      } else {
        if (/ACD/.test(st) && r.sec > (+CFG.longCallMin)*60) flags.push('Long Call');
        if (/ACW/.test(st) && r.sec > +CFG.longAcwSec) flags.push('Long ACW');
        if ((st==='OTHER'||st==='HOLD') && r.sec > +CFG.longHoldSec) flags.push('Long Hold/Other');
        if (st==='AUXOUT' && r.sec > (+CFG.auxOutMin)*60) flags.push('Outbound Parking');
        if (productive && cat==='break' && m>=act.s+g) flags.push('Skipped Break');
      }
      const excused = ro && excusedNow(ro.hrid, m);
      if (excused) flags.length = 0;
      const sev = flags.reduce((a,f)=>Math.max(a,FLAG[f]||1),0);
      const ag = {lob:lobName, hrid:ro?ro.hrid:'', name:ro?ro.name:r.name, login:r.login, sup:ro?ro.sup:'', om:ro?ro.om:'', status:ro?ro.status:'',
        state:st, aux:r.aux, sec:r.sec, productive, grp, act:act?act.name:(sch&&sch.off?'Off':''), cat, shift:sch&&!sch.off?[sch.start,sch.end]:null,
        nextBreak: sch? (sch.acts.find(a=>classifyAct(a.name)==='break' && a.s>m)||null):null, flags, sev, logged:true, vdn:r.vdn, excused};
      agents.push(ag); L.agents.push(ag);
      L.logged++; L.states[grp]++; if (productive){ L.prod++; if(!nest) L.prodNoNest++; }
      for (const f of flags) L.flags[f]=(L.flags[f]||0)+1;
    }
  }
  // ---- schedule-based counts + missing
  const absentSet = new Set(getOff().absent.map(a=>String(a.hrid)));
  for (const [hr, sch] of Object.entries(sched)){
    const ro = byHr.get(hr); if (!ro) continue;
    const L = lobs[tierToLob(ro.tier)]; if (!L) continue;
    if (sch.off) continue;
    for (const a of sch.acts){ if (classifyAct(a.name)!=='onq') continue;
      for (let i=Math.max(0,Math.floor(a.s/30)); i<Math.min(48,Math.ceil(a.e/30)); i++){
        const ov = Math.min(a.e,(i+1)*30)-Math.max(a.s,i*30); if (ov>0) L.schedArr[i]+=ov/30; } }
    const act = actAt(sch,m); const cat = act?classifyAct(act.name):null;
    const inShift = m>=sch.start && m<sch.end;
    if (!inShift) continue;
    if (cat==='leave'){ L.schedLeave++; continue; }
    L.inShift++;
    if (cat==='onq') L.schedOnQ++; else if (cat==='break') L.schedBreak++; else L.schedOOQ++;
    const loggedIn = (ro.login && seen.has(ro.login)) || (ro.ext && seen.has(ro.ext));
    if (!loggedIn && L.hasRt && m >= sch.start+g){
      if (CFG.missingSkipBreak && cat==='break') continue;
      if (cat==='system') continue;   // scheduled System Issues → not missing
      L.nsRaw++;                       // NS% counts everyone not logged in (independent of Absent-today list)
      if (absentSet.has(hr) || excusedNow(hr, m)) continue;   // Scheduled-off tab
      const ag = {lob:L.name, hrid:hr, name:ro.name, login:ro.login, sup:ro.sup, om:ro.om, status:ro.status, state:'NOT LOGGED IN', aux:'', sec:null,
        productive:false, grp:'missing', act:act?act.name:'', cat, shift:[sch.start,sch.end], nextBreak:null, flags:['Missing'], sev:3, logged:false};
      agents.push(ag); L.agents.push(ag); L.flags.Missing=(L.flags.Missing||0)+1;
    }
  }
  // ---- LA + snapshots
  const snapKey = 'rta_snap_'+(TIME.override?'sim_':'')+TIME.estDate.replace(/\//g,'');
  const snaps = LS.get(snapKey,{});
  const elapsed = m - idx*30;
  for (const L of Object.values(lobs)){
    L.la = L.req>0 ? L.prod/L.req : null;
    L.total = L.req + L.be + L.prem; L.hasBE = (L.be + L.prem) > 0;
    L.laBE = L.total>0 ? L.prod/L.total : null;
    L.laNoNest = L.req>0 ? L.prodNoNest/L.req : null;
    L.diff = L.prod - L.req;
    L.schedLa = L.req>0 ? L.schedOnQ/L.req : null;
    if (L.hasRt){
      const s = (snaps[L.name] ||= {});
      const tick = (S.cms[L.name]||{}).mtime + '|' + Math.floor(m);
      const cur = s[idx] ||= {sum:0,n:0,last:null};
      if (cur.last!==tick){ cur.sum+=L.prod; cur.n++; cur.last=tick; }
      L.snaps = s;
      let sp=0, sr=0; for (const [i,v] of Object.entries(s)){ const rq=L.reqArr[+i]; if (rq>0 && v.n){ sp+=v.sum/v.n; sr+=rq; } }
    } else { L.snaps = snaps[L.name]||{}; }
  }
  LS.set(snapKey, snaps);
  // ---- NS% = (not logged in − manual exclusions) ÷ scheduled in shift
  const nsEx = {}; for (const r of getOff().nsEx||[]) if (r.lob) nsEx[r.lob]=(nsEx[r.lob]||0)+(+r.n||0);
  for (const L of Object.values(lobs)){
    L.nsEx = nsEx[L.name]||0; L.nsAdj = Math.max(0, L.nsRaw - L.nsEx);
    L.ns = L.hasRt && L.inShift>0 ? L.nsAdj/L.inShift : null;
  }
  // ---- minute table (current interval only, 0–29) → Running LA + Projection
  const mk = minKey();
  Object.keys(localStorage).filter(k=>k.startsWith('rta_min_') && k!==mk).forEach(k=>localStorage.removeItem(k));
  const mins = LS.get(mk,{});
  const curMin = Math.min(29, Math.max(0, Math.floor(m - idx*30)));
  for (const L of Object.values(lobs)){
    const t = mins[L.name] ||= {};
    if (L.hasRt && L.la!=null && !(t[curMin] && t[curMin].man)) {
      // minutes with no refresh since the last recorded one get the last recorded value (no gaps in the table)
      let prev=-1; for (let i=curMin-1;i>=0;i--) if (t[i] && t[i].la!=null){ prev=i; break; }
      if (prev>=0) for (let i=prev+1;i<curMin;i++) if (!t[i]) t[i] = {la:t[prev].la, laBE:t[prev].laBE, prod:t[prev].prod, req:t[prev].req, carry:t[prev].carry??prev};
      t[curMin] = {la:L.la, laBE:L.laBE, prod:L.prod, req:L.req};
    }
    const vals = Object.entries(t).filter(([k,v])=>+k<=curMin && v && v.la!=null).map(([k,v])=>v.la);
    L.minTbl = t; L.curMin = curMin; L.minFilled = vals.length;
    L.runLa = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
    const vb = Object.entries(t).filter(([k,v])=>+k<=curMin && v && v.laBE!=null).map(([k,v])=>v.laBE);
    L.runLaBE = vb.length ? vb.reduce((a,b)=>a+b,0)/vb.length : null;
    const now = L.la!=null ? L.la : (vals.length ? vals[vals.length-1] : null);
    L.proj = vals.length && now!=null ? (vals.reduce((a,b)=>a+b,0) + now*Math.max(0,30-vals.length))/30 : null;
  }
  LS.set(mk, mins);
  S.result = {lobs, agents, time:TIME};
}

/* =========================================================
   RENDER
   ========================================================= */
const $ = s => document.querySelector(s);
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = v => v==null ? '–' : (v*100).toFixed(1)+'%';
const f1 = v => v==null||isNaN(v) ? '–' : (Math.round(v*10)/10).toLocaleString();
function laStatus(v){
  if (v==null) return {c:'none',i:'○',t:'No REQ'};
  if (v*100 > +CFG.laGood) return {c:'good',i:'▲',t:'Well staffed'};
  if (v*100 >= +CFG.laWarn) return {c:'warn',i:'◆',t:'Tight'};
  return {c:'crit',i:'▼',t:'Failing'};
}
const chip = v => { const s=laStatus(v); return `<span class="st ${s.c}">${s.i} ${s.t}</span>`; };
const sevClass = s => s>=3?'crit':s===2?'warn':'info';
function toast(msg, bad){ const t=$('#toast'); t.textContent=msg; t.style.display='block'; t.style.borderColor=bad?'var(--crit)':'var(--border)'; clearTimeout(toast._t); toast._t=setTimeout(()=>t.style.display='none',4200); }

function renderClock(){
  const t = nowCtx();
  $('#clkEst').textContent = fmtMin(t.estMin,'EST') + (t.override?' (sim)':'');
  $('#clkClt').textContent = fmtMin(t.estMin,'CLT');
  $('#clkInt').textContent = intLabel(t.idx, CFG.displayTz) + ' ' + CFG.displayTz;
}
function renderPills(){
  const p = [];
  const ok = (cond,label,title) => `<span class="pill ${cond}" title="${esc(title||'')}"><span class="dot"></span>${label}</span>`;
  const today = nowCtx().estDate;
  const latOk = S.lat ? (S.lat.date && !sameDay(S.lat.date,today) ? 'warn':'ok') : 'bad';
  p.push(ok(latOk,'LAT', S.lat?`${S.lat.fileName} · date ${S.lat.date}`:'Not loaded'));
  p.push(ok(S.roster?'ok':'bad','Roster', S.roster?`${S.roster.agents.length} agents`:'Not loaded'));
  const schOk = S.sched ? (S.sched.date && !sameDay(S.sched.date,today)?'warn':'ok') : 'bad';
  p.push(ok(schOk,'Schedule', S.sched?`${Object.keys(S.sched.agents).length} agents · ${S.sched.date||''}`:'Not loaded'));
  const nCms = Object.keys(S.cms).length;
  let cmsCls = nCms ? 'ok live' : 'bad', lbl = nCms ? `CMS · ${nCms} LOB` : 'CMS';
  if (S.cmsMeta.needPerm){ cmsCls='warn'; lbl='CMS · click to reconnect'; }
  const newest = Math.max(0,...Object.values(S.cms).map(c=>c.mtime||0));
  if (nCms && newest && Date.now()-newest > 5*60000){ cmsCls='warn'; lbl+=` · stale ${Math.round((Date.now()-newest)/60000)}m`; }
  p.push(`<span class="pill ${cmsCls}" id="pillCms" style="cursor:pointer" title="${esc(S.cmsMeta.errors.join('\n'))}"><span class="dot"></span>${lbl}</span>`);
  if (S.outHandle){ const m=S.outMeta||{}; const age=m.last?Math.round((Date.now()-m.last)/60000):null;
    p.push(`<span class="pill ${m.needPerm?'warn':m.err?'bad':m.last?'ok':'warn'}" id="pillOut" style="cursor:pointer" title="${esc(m.err||'')}"><span class="dot"></span>${m.needPerm?'Export · click to reconnect':m.last?`Export · ${age}m ago`:'Export · waiting'}</span>`); }
  $('#pills').innerHTML = p.join('');
  const po=$('#pillOut'); if (po) po.onclick = () => (S.outMeta||{}).needPerm ? exportPictures(true) : switchTab('setup');
  $('#pillCms').onclick = () => S.cmsMeta.needPerm ? readFolder(true) : switchTab('setup');
}
function sameDay(a,b){ const pa=String(a).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/), pb=String(b).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if(!pa||!pb) return true; return +pa[1]===+pb[1] && +pa[2]===+pb[2] && (+pa[3]%100)===(+pb[3]%100); }

function activeLobs(){ const R=S.result; return R ? Object.values(R.lobs).filter(L=>L.hasReq||L.hasRt||L.inShift) : []; }

function renderOverview(){
  const R = S.result;
  if (!S.lat && !S.roster && !S.sched && !Object.keys(S.cms).length){
    $('#ovBody').innerHTML = `<div class="card empty"><h2>No data yet</h2><p>Load today's LAT, roster and schedule, then connect the CMS export folder.</p><button class="btn primary" data-goto="setup">Go to Data &amp; Setup</button></div>`; return;
  }
  const Ls = activeLobs();
  const live = Ls.filter(L=>L.hasRt && L.req>0);
  const tReq = live.reduce((a,L)=>a+L.req,0), tProd = live.reduce((a,L)=>a+L.prod,0);
  const tMiss = Ls.reduce((a,L)=>a+(L.flags.Missing||0),0);
  const tFlag = R.agents.filter(a=>a.sev>=2).length;
  const LR = Ls.filter(L=>L.hasRt); const tLog = LR.reduce((a,L)=>a+L.logged,0), tSch = LR.reduce((a,L)=>a+L.schedOnQ,0);
  const oLa = tReq>0 ? tProd/tReq : null;
  const kp = (l,v,s) => `<div class="card kpi"><small>${l}</small><b class="num">${v}</b><div class="sub">${s||''}</div></div>`;
  const rated = Ls.filter(L=>L.hasRt && L.hasReq && L.req>0 && L.la!=null);
  const pass = rated.filter(L=>L.la*100 >= +CFG.laWarn), fail = rated.filter(L=>L.la*100 < +CFG.laWarn);
  const well = pass.filter(L=>L.la*100 > +CFG.laGood).length;
  const nsL = Ls.filter(L=>L.hasRt && L.inShift>0);
  const nsNum = nsL.reduce((a,L)=>a+L.nsAdj,0), nsDen = nsL.reduce((a,L)=>a+L.inShift,0);
  const nsP = nsDen ? nsNum/nsDen : null;
  const names = arr => arr.length ? arr.map(L=>`${esc(L.name)} <span class="num" style="font-weight:600;color:var(--${laStatus(L.la).c})">${pct(L.la)}</span>`).join(' · ') : '—';
  const kc = (l,v,s,c) => `<div class="card kpi"><small>${l}</small><b class="num" ${c?`style="color:var(--${c})"`:''}>${v}</b><div class="sub">${s||''}</div></div>`;
  let html = `<div class="kpis" style="grid-template-columns:repeat(5,minmax(0,1fr))">
    ${kc('Passing LOBs', `${pass.length}<span class="muted" style="font-size:16px"> / ${rated.length}</span>`, `${well} well staffed · ${pass.length-well} tight<br>${names(pass)}`, pass.length?'good':'')}
    ${kc('Failing LOBs', `${fail.length}<span class="muted" style="font-size:16px"> / ${rated.length}</span>`, `below ${CFG.laWarn}%<br>${names(fail)}`, fail.length?'crit':'good')}
    ${kc('Abs / NS %', pct(nsP), `${nsNum} not logged in of ${nsDen} scheduled${nsL.some(L=>L.nsEx)?` · ${nsL.reduce((a,L)=>a+L.nsEx,0)} excluded`:''}`)}
    ${kc('Missing agents', tMiss, 'flagged · after Scheduled-off list')}
    ${kc('Flags (warn+)', tFlag, `<a href="#" data-goto="agents" style="color:var(--accent)">open list →</a>`)}
  </div><div class="lobgrid">`;
  const sorted = Ls.slice().sort((a,b)=>(b.hasRt-a.hasRt)||((a.la??9)-(b.la??9)));
  for (const L of sorted){
    const st = laStatus(L.hasRt?L.la:null);
    const fl = Object.entries(L.flags).sort((a,b)=>(FLAG[b[0]]||1)-(FLAG[a[0]]||1)).slice(0,4)
      .map(([f,n])=>`<span class="st ${sevClass(FLAG[f]||1)}">${n} ${esc(f)}</span>`).join('');
    html += `<div class="card lob ${L.hasRt?'':'inactive'}" data-lob="${esc(L.name)}" data-st="${L.hasRt?st.c:''}">
      <div class="hd"><b>${esc(L.name)}</b>${L.hasRt?chip(L.la):'<span class="st none">○ No CMS data</span>'}</div>
      <div class="la"><b class="num" style="color:var(--${st.c==='none'?'text-muted':st.c})">${L.hasRt?pct(L.la):'–'}</b>
        <span class="sec num">${!L.hasReq?`${f1(L.prod)} productive · forecast not in LAT`:L.hasRt?`${f1(L.prod)} / ${f1(L.req)} req`:`REQ ${f1(L.req)}`}</span></div>
      ${spark(L)}
      <div class="stats">
        <div><small>${L.diff>=0?'Extra':'Deficit'}</small><span class="num" style="color:var(--${L.hasRt&&L.hasReq?(L.diff>=0?'good':'crit'):'text-primary'})">${L.hasRt?(L.diff>0?'+':'')+f1(L.diff):'–'}</span></div>
        <div><small>Sched On-Q</small><span class="num">${f1(L.schedOnQ)}</span></div>
        <div><small>Logged in</small><span class="num">${L.logged}</span></div>
        <div><small>Next REQ</small><span class="num">${f1(L.nextReq)}</span></div>
      </div>
      <div class="flagsline">${fl||'<span class="muted" style="font-size:12px">No flags</span>'}</div></div>`;
  }
  $('#ovBody').innerHTML = html+'</div>';
  document.querySelectorAll('.lob[data-lob]').forEach(el=>el.onclick=()=>{S.selLob=el.dataset.lob;LS.set('rta_selLob',S.selLob);switchTab('lob');});
}
function dayWindow(L){
  let a=47,b=0;
  L.reqArr.forEach((v,i)=>{ if(v>0||L.schedArr[i]>0){a=Math.min(a,i);b=Math.max(b,i);} });
  for (const i of Object.keys(L.snaps||{})){a=Math.min(a,+i);b=Math.max(b,+i);}
  if (a>b){a=Math.max(0,TIME.idx-8);b=Math.min(47,TIME.idx+8);}
  return [a,b];
}
function spark(L){
  const [a,b]=dayWindow(L), n=b-a+1, W=268, H=40;
  const max = Math.max(1,...L.reqArr.slice(a,b+1),...Object.values(L.snaps||{}).map(s=>s.n?s.sum/s.n:0));
  const x=i=>(i-a)/(Math.max(1,n-1))*W, y=v=>H-2-v/max*(H-6);
  const reqPath = L.reqArr.slice(a,b+1).map((v,k)=>`${k?'L':'M'}${x(a+k).toFixed(1)},${y(v).toFixed(1)}`).join('');
  let bars=''; const bw=Math.max(2,W/n-2);
  for (const [i,s] of Object.entries(L.snaps||{})){ if(+i<a||+i>b||!s.n) continue; const v=s.sum/s.n; bars+=`<rect x="${(x(+i)-bw/2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H-2-y(v)).toFixed(1)}" rx="1.5" fill="var(--s1)" opacity=".85"/>`; }
  const nowX = x(TIME.idx);
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="margin-top:8px;display:block;height:${H}px">
    ${bars}<path d="${reqPath}" fill="none" stroke="var(--s2)" stroke-width="2"/>
    ${TIME.idx>=a&&TIME.idx<=b?`<line x1="${nowX}" x2="${nowX}" y1="0" y2="${H}" stroke="var(--text-muted)" stroke-dasharray="2 3"/>`:''}</svg>`;
}

/* ---------- LOB view (the picture) ---------- */
function renderLobSelect(){
  const Ls = activeLobs(); const sel=$('#lobSel');
  const base = Ls.length ? Ls.map(L=>L.name) : CFG.lobs.map(l=>l.name);
  const grps = lobGroups().map(g=>g.name);
  const names = [...grps, ...base];
  if (!S.selLob || !names.includes(S.selLob)) S.selLob = names[0];
  sel.innerHTML = (grps.length?`<optgroup label="Groups">${grps.map(n=>`<option value="${esc(n)}" ${n===S.selLob?'selected':''}>▦ ${esc(n)}</option>`).join('')}</optgroup>`:'') +
    `<optgroup label="LOBs">${base.map(n=>`<option value="${esc(n)}" ${n===S.selLob?'selected':''}>${esc(n)}</option>`).join('')}</optgroup>`;
}
const PIC_FLAGS = ['Missing','Unproductive AUX','Default AUX','Unscheduled Break','Exceeding Break','Unscheduled Coaching','System Issue'];
const UNPROD_FLAGS = ['Unproductive AUX','Default AUX','Unscheduled Break','Unscheduled Coaching'];
const PAGE_ROWS = 34;          // rows per flags picture page (2 columns) → keeps the font readable
const BOX_ROWS = 16;           // a long table continues in a new box
function viewHead(L, title){
  const T=TIME;
  return `<div class="vh"><div><div class="t">${esc(L.name)} · ${title}</div>
    <div class="s num">Interval ${intLabel(T.idx,'CLT')} CLT &nbsp;·&nbsp; ${intLabel(T.idx,'EST')} EST &nbsp;·&nbsp; ${T.estDate}</div></div>
    <div style="text-align:right">${L.hasRt?chip(L.la):'<span class="st none">○ No CMS data</span>'}<div class="muted num" style="font-size:12px;margin-top:6px">As of ${fmtMin(T.estMin,'CLT')} CLT</div></div></div>`;
}
function kpiBlock(L){
  const st = laStatus(L.hasRt?L.la:null);
  const tl = (l,v,s,c,st)=>`<div class="tile" data-st="${st||c||''}"><small>${l}</small><b class="num" ${c?`style="color:var(--${c})"`:''}>${v}</b><div class="sub">${s||'&nbsp;'}</div></div>`;
  const lc = v => { const c=laStatus(v).c; return c==='none'?'':c; };
  const tot = L.logged||1, sg=L.states;
  const parts = [['Available',sg.avail,'var(--s1)'],['On call',sg.acd,'var(--s1b)'],['ACW / Hold / Other',sg.acw+sg.other,'var(--s3)'],['AUX-out / Prod AUX',sg.auxout+sg.prodaux,'var(--s3b)'],['Break / Lunch',sg.brk,'var(--warn)'],['Coaching / Training / Project',sg.coach,'var(--info)'],['Unproductive AUX',sg.unprod,'var(--crit)']];
  const bar = parts.filter(p=>p[1]>0).map(p=>`<div style="width:${p[1]/tot*100}%;background:${p[2]}" title="${p[0]}: ${p[1]}"></div>`).join('');
  const leg = parts.map(p=>`<span><i style="background:${p[2]}"></i>${p[0]} <b class="num">${p[1]}</b></span>`).join('');
  const unprod = UNPROD_FLAGS.reduce((a,f)=>a+(L.flags[f]||0),0);
  const beTxt = L.hasBE ? `BE ${f1(L.be)} · Prem ${f1(L.prem)}` : 'no BE / Prem';
  return `<div class="hero">
    <div class="herola" data-st="${L.hasRt&&st.c!=='none'?st.c:''}"><small>Line adherence</small><b class="num" style="color:var(--${st.c==='none'?'text-muted':st.c})">${L.hasRt?pct(L.la):'–'}</b>
      <div class="sec num" style="margin-top:4px">${L.hasReq?`${f1(L.prod)} productive vs ${f1(L.req)} required`:`Forecast ${esc(L.cfg.fc)} not in LAT file`}</div>
      ${L.hasBE?`<div class="sec num" style="margin-top:2px">LA w/ BE <span style="font-weight:700;font-size:16px;color:var(--${lc(L.laBE)||'text-primary'})">${pct(L.laBE)}</span></div>`:''}</div>
    <div class="tiles">
      ${tl('Total login HC',L.logged,`of ${L.inShift} in shift`,'',L.inShift&&L.logged<L.inShift*0.9?'warn':'')}
      ${tl('REQ',f1(L.req),beTxt)}
      ${tl(L.hasBE?'Total (REQ+BE+Prem)':'Next interval REQ',L.hasBE?f1(L.total):f1(L.nextReq),L.hasBE?`Next REQ ${f1(L.nextReq)}`:'')}
      ${tl(L.diff>=0?'Extra':'Deficit',L.hasRt?(L.diff>0?'+':'')+f1(L.diff):'–',L.nextReq?`vs next: ${f1(L.prod-L.nextReq)}`:'',L.hasRt&&L.hasReq?(L.diff>=0?'good':'crit'):'')}
      ${tl('Productive',f1(L.prod),`w/o nesters ${f1(L.prodNoNest)} · LA ${pct(L.laNoNest)}`)}
      ${tl('Running LA',pct(L.runLa),L.hasBE?`Running w/ BE ${pct(L.runLaBE)}`:'',lc(L.runLa))}
      ${tl('Interval projection',pct(L.proj),'end of interval',lc(L.proj))}
      ${tl('Sched On-Q',f1(L.schedOnQ),`sched LA ${pct(L.schedLa)} · OOQ ${L.schedOOQ+L.schedBreak}`)}
      ${tl('Missing',L.flags.Missing||0,'scheduled, not logged in','',(L.flags.Missing||0)>0?'crit':'good')}
      ${tl('Unproductive',unprod,`unsched AUX / break · ${L.flags['System Issue']||0} system`,'',unprod>=3?'crit':unprod>0?'warn':'good')}
    </div></div>
  <h3>Agent states · ${L.logged} logged in</h3>
  <div class="statebar">${bar}</div><div class="legend">${leg}</div>`;
}
function flagGrid(Lx, only){
  const Ls = Array.isArray(Lx) ? Lx : [Lx];
  const groups = {};
  for (const L of Ls) for (const a of L.agents) for (const f of a.flags) if (!only || only.includes(f)) (groups[f] ||= []).push(a);
  const order = only ? only.filter(f=>groups[f]) : Object.keys(groups).sort((a,b)=>(FLAG[b]||1)-(FLAG[a]||1)||groups[b].length-groups[a].length);
  const fbox = f => { const arr=groups[f].slice().sort((a,b)=>a.lob.localeCompare(b.lob)||(b.sec||0)-(a.sec||0));
    const isMiss = f==='Missing';
    return `<div class="fbox"><div class="fh"><b>${esc(f)}</b><span class="st ${sevClass(FLAG[f]||1)}">${arr.length}</span></div>
      <table><tr><th>Agent</th><th>LOB</th><th>Supervisor</th>${isMiss?'<th>Activity now</th><th>Shift</th>':'<th>State / AUX</th><th>Time</th>'}</tr>
      ${arr.map(a=>`<tr><td title="${esc(a.name)}">${esc(a.name)}</td><td>${esc(a.lob)}</td><td>${esc(a.sup)}</td>${isMiss?`<td>${esc(a.act||'–')}</td><td class="num">${a.shift?shortT(a.shift[0])+'–'+shortT(a.shift[1]):'–'}</td>`:`<td>${esc(a.state)}${a.aux?' · '+esc(a.aux):''}</td><td class="num">${fmtDur(a.sec)}</td>`}</tr>`).join('')}
      </table></div>`; };
  return `<div class="flaggrid">${order.length?order.map(fbox).join(''):`<div class="fbox muted">${only?'No unproductive, unscheduled or system-issue agents right now.':'No flags right now.'}</div>`}</div>`;
}
function flagPages(Lx, only){
  const Ls = Array.isArray(Lx) ? Lx : [Lx];
  const groups = {};
  for (const L of Ls) for (const a of L.agents) for (const f of a.flags) if (only.includes(f)) (groups[f] ||= []).push(a);
  const boxes = [];
  for (const f of only.filter(f=>groups[f])){
    const arr = groups[f].slice().sort((a,b)=>a.lob.localeCompare(b.lob)||(b.sec||0)-(a.sec||0));
    const BR = CFG.flagsSplit ? BOX_ROWS : 1e9;
    for (let i=0;i<arr.length;i+=BR) boxes.push({f, rows:arr.slice(i,i+BR), total:arr.length, part:Math.floor(i/BR)+1, parts:Math.ceil(arr.length/BR)});
  }
  const pages=[]; let cur=[], used=0;
  for (const b of boxes){ const cost=b.rows.length+3; if (CFG.flagsSplit && cur.length && used+cost>PAGE_ROWS*2){ pages.push(cur); cur=[]; used=0; } cur.push(b); used+=cost; }
  if (cur.length) pages.push(cur);
  return pages.length ? pages : [[]];
}
function flagPageHTML(boxes){
  if (!boxes.length) return `<div class="flaggrid"><div class="fbox muted">No missing, unproductive, unscheduled or system-issue agents right now.</div></div>`;
  return `<div class="flaggrid">${boxes.map(b=>{ const isMiss=b.f==='Missing';
    return `<div class="fbox"><div class="fh"><b>${esc(b.f)}${b.parts>1?` <span class="muted">(${b.part}/${b.parts})</span>`:''}</b><span class="st ${sevClass(FLAG[b.f]||1)}">${b.total}</span></div>
      <table><tr><th>Agent</th><th>LOB</th><th>Supervisor</th>${isMiss?'<th>Activity now</th><th>Shift</th>':'<th>State / AUX</th><th>Time</th>'}</tr>
      ${b.rows.map(a=>`<tr><td>${esc(a.name)}</td><td>${esc(a.lob)}</td><td>${esc(a.sup)}</td>${isMiss?`<td>${esc(a.act||'–')}</td><td class="num">${a.shift?shortT(a.shift[0])+'–'+shortT(a.shift[1]):'–'}</td>`:`<td>${esc(a.state)}${a.aux?' · '+esc(a.aux):''}</td><td class="num">${fmtDur(a.sec)}</td>`}</tr>`).join('')}
      </table></div>`; }).join('')}</div>`;
}
function picPageCount(kind, name){
  if (kind!=='flags') return 1;
  const Ls = isGroup(name) ? groupLobs(name) : [S.result.lobs[name]].filter(Boolean);
  return flagPages(Ls, PIC_FLAGS).length;
}
/* ---------- Day plan (actual + projected per interval) ---------- */
function absFor(lob){ const v=(CFG.absPct||{})[lob]; return v==null||v==='' ? 10 : +v; }
function dayPlan(name){
  const Ls = isGroup(name) ? groupLobs(name) : [S.result.lobs[name]].filter(Boolean);
  const pass = +CFG.laWarn/100, rows=[];
  for (let i=0;i<48;i++){
    let req=0, be=0, act=0, orig=0, actS=0, absW=0;
    for (const L of Ls){ req+=L.reqArr[i]; be+=L.beArr[i]+L.premArr[i]; act+=L.actArr[i]; const o=L.schedArr[i]; orig+=o; actS+=o*(1-absFor(L.name)/100); absW+=absFor(L.name); }
    if (req<=0 && orig<=0) continue;
    const abs = absW/Ls.length/100, published = act>0;
    const r = {i, req, be, act:published?act:null, orig, abs, actS, varc:actS-req,
      origIC: req>0?orig/req:null, expIC: !published&&req>0?actS/req:null, actual: published&&req>0?act/req:null};
    r.ot = published ? null : Math.max(0, Math.ceil(1.05*req - actS - 1e-9));
    r.off = published ? null : Math.max(0, Math.floor(r.varc - 1));
    rows.push(r);
  }
  const withReq = rows.filter(r=>r.req>0);
  const actRows = withReq.filter(r=>r.actual!=null);
  const passOf = v => v!=null && v>=pass;
  const sum = k => rows.reduce((a,r)=>a+(r[k]||0),0);
  const ov = {act:sum('act')/2, req:sum('req')/2, orig:sum('orig')/2, actS:sum('actS')/2, be:sum('be')/2, abs: rows.length? rows.reduce((a,r)=>a+r.abs,0)/rows.length : 0,
    ot:sum('ot'), off:sum('off'),
    projOrig: withReq.length ? withReq.filter(r=>passOf(r.origIC)).length/withReq.length : null,
    projEOD: withReq.length ? (actRows.filter(r=>passOf(r.actual)).length + withReq.filter(r=>r.actual==null && passOf(r.expIC)).length)/withReq.length : null,
    running: actRows.length ? actRows.filter(r=>passOf(r.actual)).length/actRows.length : null};
  return {rows, ov, Ls};
}
function dayPlanHTML(name){
  const {rows, ov} = dayPlan(name); const hp = +CFG.paidHours||7.5;
  const d = new Date(); const wd = d.toLocaleDateString('en-US',{weekday:'long'}), mo = d.toLocaleDateString('en-US',{month:'long'});
  const [mm,dd,yy] = TIME.estDate.split('/');
  const n1 = v => v==null?'-':(Math.round(v*10)/10).toFixed(1), pc = (v,d=1) => v==null?'':(v*100).toFixed(d)+'%';
  const tcls = v => { const c=laStatus(v).c; return c==='good'?'tg':c==='warn'?'tw':c==='crit'?'tc':''; };
  const bcls = v => { const c=laStatus(v).c; return c==='good'?'bg-g':c==='warn'?'bg-w':c==='crit'?'bg-c':''; };
  const vbg = v => { if (v<0) return 'background:#ff7c80'; const t=Math.min(1,v/40); const g=Math.round(235-60*t), r=Math.round(255-155*t); return `background:rgb(${r},${g},${Math.round(132-30*t)})`; };
  return `<div class="dptitle">${wd} ${+dd} - ${mo} - ${yy} ${esc(name)} Daily Plan View</div>
  <table class="dpt"><tr><th>Interval EST</th><th>Interval CLT</th><th>Act Req LAT</th><th>Required</th><th>Original scheduled</th><th>Planned ABS</th><th>Act Scheduled</th><th>BE Req</th><th>Variance +/-</th><th>Original Projected IC%</th><th>Expected IC%</th><th>Actual LAT %</th><th>HC REQ OT</th><th>Offered Leaves HC</th></tr>
  ${rows.map(r=>`<tr class="${r.i===TIME.idx?'now':''}"><td class="iv">${fmtMin(r.i*30,'EST')}</td><td class="iv">${fmtMin(r.i*30,'CLT')}</td>
    <td>${r.act==null?'-':n1(r.act)}</td><td>${n1(r.req)}</td><td>${n1(r.orig)}</td><td>${pc(r.abs)}</td><td>${n1(r.actS)}</td><td>${r.be?n1(r.be):'-'}</td>
    <td style="${vbg(r.varc)}">${Math.round(r.varc)}</td><td class="pi ${tcls(r.origIC)}">${pc(r.origIC)}</td>
    <td class="pi ${tcls(r.expIC)}">${pc(r.expIC)}</td><td class="${r.actual!=null?bcls(r.actual):''}">${pc(r.actual,2)}</td>
    <td>${r.ot?r.ot:''}</td><td>${r.off?r.off:''}</td></tr>`).join('')}
  <tr class="ov"><td>Overall HRs.</td><td>-</td><td>${n1(ov.act)}</td><td>${n1(ov.req)}</td><td>${n1(ov.orig)}</td><td>${pc(ov.abs)}</td><td>${n1(ov.actS)}</td><td>${n1(ov.be)}</td><td>-</td>
    <td class="hl">Projected ${pc(ov.projOrig)}</td><td class="hl">Projected EOD ${pc(ov.projEOD)}</td><td class="hl">Running at ${ov.running==null?'–':pc(ov.running)}</td><td>${ov.ot}</td><td>${ov.off}</td></tr>
  <tr class="ov"><td>Overall HC</td><td>-</td><td>${n1(ov.act/hp)}</td><td>${n1(ov.req/hp)}</td><td>${n1(ov.orig/hp)}</td><td>-</td><td>${n1(ov.actS/hp)}</td><td>${n1(ov.be/hp)}</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>
  </table>`;
}
function renderDay(){
  if (!S.result) return;
  $('#daySel').innerHTML = $('#lobSel').innerHTML || ''; $('#daySel').value = S.selLob;
  const Ls = isGroup(S.selLob) ? groupLobs(S.selLob) : [S.result.lobs[S.selLob]].filter(Boolean);
  $('#dayAbs').value = Ls.length===1 ? absFor(Ls[0].name) : ''; $('#dayAbs').placeholder = Ls.length>1 ? 'per LOB' : '';
  $('#dayAbs').disabled = Ls.length!==1; $('#dayPass').textContent = CFG.laWarn;
  $('#dayView').innerHTML = dayPlanHTML(S.selLob);
}
/* ---------- Legacy view (Excel look) ---------- */
const LEG_COLORS = [['EG TSX 4P','#f07c7c'],['BSC','#9cc3c9'],['SMB Chat','#fce4d6'],['EG XM BO','#8eaadb'],['Fraud','#a9d08e'],['MM','#63e58a'],['SMB Voice','#bf8f00'],['SPANISH','#00b0f0'],['CSA T2','#ff9900'],['CSA T1','#f2e600'],['EG Hotline','#ffe699'],['BSD','#a6a6a6']];
const legColor = n => (LEG_COLORS.find(([k])=>String(n).toUpperCase().includes(k.toUpperCase()))||[0,'#d9d9d9'])[1];
function legCell(v){ const c=laStatus(v).c; return c==='good'?'lg-good':c==='warn'?'lg-warn':c==='crit'?'lg-crit':''; }
function legacyBlock(L){
  const r2 = v => v==null||isNaN(v)?'–':(Math.round(v*100)/100).toLocaleString();
  const p2 = v => v==null?'–':(v*100).toFixed(2)+'%';
  const sg=L.states, tot=L.logged||1;
  const parts=[['Available',sg.avail,'#2a78d6'],['On call',sg.acd,'#86b6ef'],['ACW / Hold / Other',sg.acw+sg.other,'#1baf7a'],['AUX-out / Prod AUX',sg.auxout+sg.prodaux,'#8fd8bb'],['Break / Lunch',sg.brk,'#e0a000'],['Coaching / Training / Project',sg.coach,'#6250d6'],['Unproductive AUX',sg.unprod,'#d03b3b']];
  const projC = laStatus(L.proj).c;
  return `<div class="lgblock">
    <table class="lgt">
      <tr><th colspan="2" style="background:${legColor(L.name)}">${esc(L.name)}</th></tr>
      <tr class="lg-g"><td>Total Login HC</td><td>${L.logged}</td></tr>
      <tr class="lg-g"><td>REQ</td><td><b>${r2(L.req)}</b></td></tr>
      <tr class="lg-g"><td>Prem Req</td><td>${r2(L.prem)}</td></tr>
      <tr class="lg-g"><td>Be Req</td><td>${r2(L.be)}</td></tr>
      <tr class="lg-g"><td>Total</td><td>${r2(L.total)}</td></tr>
      <tr class="lg-g"><td>${L.diff>=0?'Extra':'Deficit'}</td><td class="${L.hasRt&&L.hasReq?(L.diff>=0?'lg-txt-good':'lg-txt-crit'):''}">${L.hasRt?r2(L.diff):'–'}</td></tr>
      <tr class="lg-g"><td>Productive</td><td>${L.prod}</td></tr>
      <tr class="lg-k"><td>LA</td><td class="${legCell(L.la)}">${p2(L.la)}</td></tr>
      <tr class="lg-k"><td>LA w/ BE</td><td class="${legCell(L.laBE)}">${p2(L.laBE)}</td></tr>
      <tr class="lg-k"><td>LA w/o Nesters</td><td class="${legCell(L.laNoNest)}">${p2(L.laNoNest)}</td></tr>
      <tr class="lg-k"><td>Running LA</td><td class="${legCell(L.runLa)}">${p2(L.runLa)}</td></tr>
      ${L.hasBE?`<tr class="lg-k"><td>Running LA w/ BE</td><td class="${legCell(L.runLaBE)}">${p2(L.runLaBE)}</td></tr>`:''}
      <tr class="lg-n"><td>Next Interval REQ</td><td><b>${r2(L.nextReq)}</b></td></tr>
    </table>
    <div class="lgproj"><small>INTERVAL PROJECTION</small><b class="num" style="color:var(--${projC==='none'?'text-muted':projC})">${pct(L.proj)}</b><span>LA w/o nesters ${pct(L.laNoNest)}</span></div>
    <div class="lgstates"><small>AGENT STATES · ${L.logged} LOGGED IN</small>
      <div class="statebar">${parts.filter(p=>p[1]>0).map(p=>`<div style="width:${p[1]/tot*100}%;background:${p[2]}"></div>`).join('')}</div>
      <div class="legend">${parts.map(p=>`<span><i style="background:${p[2]}"></i>${p[0]} <b class="num">${p[1]}</b></span>`).join('')}</div></div>
  </div>`;
}
function legacyHTML(name){
  const Ls = isGroup(name) ? groupLobs(name) : [S.result.lobs[name]].filter(Boolean);
  const T=TIME;
  return `<div class="lghead"><b>Legacy view</b><span class="num">Interval ${intLabel(T.idx,'CLT')} CLT · ${intLabel(T.idx,'EST')} EST · As of ${fmtMin(T.estMin,'CLT')} CLT</span></div>
    <div class="lggrid" style="grid-template-columns:repeat(${Ls.length},minmax(0,520px))">${Ls.map(legacyBlock).join('')}</div>`;
}
function viewFoot(L){
  const cms = S.cms[L.name];
  return `<div class="foot"><span>Source: ${esc(cms?cms.fileName:'—')} ${cms?'· updated '+new Date(cms.mtime).toLocaleTimeString():''} · LAT ${esc(S.lat?S.lat.fileName:'—')}</span><span>LA = productive HC ÷ REQ · ▲ ≥${CFG.laGood}% · ◆ ≥${CFG.laWarn}%</span></div>`;
}
function groupHead(name, title){
  const T=TIME;
  return `<div class="vh"><div><div class="t">${esc(name)} · ${title}</div>
    <div class="s num">Interval ${intLabel(T.idx,'CLT')} CLT &nbsp;·&nbsp; ${intLabel(T.idx,'EST')} EST &nbsp;·&nbsp; ${T.estDate}</div></div>
    <div style="text-align:right"><div class="muted num" style="font-size:12px;margin-top:6px">As of ${fmtMin(T.estMin,'CLT')} CLT</div></div></div>`;
}
function compactBlock(L){
  const st = laStatus(L.hasRt?L.la:null), lc = v => { const c=laStatus(v).c; return c==='none'?'':`style="color:var(--${c})"`; };
  const t = (l,v,s,c)=>`<div class="tile"><small>${l}</small><b class="num" ${c||''}>${v}</b><div class="sub">${s||'&nbsp;'}</div></div>`;
  const sg=L.states, tot=L.logged||1;
  const parts=[[sg.avail,'var(--s1)'],[sg.acd,'var(--s1b)'],[sg.acw+sg.other,'var(--s3)'],[sg.auxout+sg.prodaux,'var(--s3b)'],[sg.brk,'var(--warn)'],[sg.coach,'var(--info)'],[sg.unprod,'var(--crit)']];
  const unprod = UNPROD_FLAGS.reduce((a,f)=>a+(L.flags[f]||0),0);
  return `<div class="cblock">
    <div class="row" style="justify-content:space-between"><b style="font-size:17px">${esc(L.name)}</b>${L.hasRt?chip(L.la):'<span class="st none">○ No CMS data</span>'}</div>
    <div class="herola" style="margin:10px 0"><small>Line adherence</small><b class="num" style="font-size:44px;color:var(--${st.c==='none'?'text-muted':st.c})">${L.hasRt?pct(L.la):'–'}</b>
      <div class="sec num">${L.hasReq?`${f1(L.prod)} productive vs ${f1(L.req)} required`:'No REQ in LAT'}</div></div>
    <div class="tiles" style="grid-template-columns:1fr 1fr">
      ${t('REQ',f1(L.req),`Next ${f1(L.nextReq)}`)}${t('Productive',f1(L.prod),`w/o nesters ${f1(L.prodNoNest)}`)}
      ${t(L.diff>=0?'Extra':'Deficit',L.hasRt?(L.diff>0?'+':'')+f1(L.diff):'–','',L.hasRt&&L.hasReq?`style="color:var(--${L.diff>=0?'good':'crit'})"`:'')}
      ${t('Running LA',pct(L.runLa),`${L.minFilled||0}/30 min`,lc(L.runLa))}${t('Projection',pct(L.proj),'interval',lc(L.proj))}
      ${t('Logged in',L.logged,`of ${L.inShift} in shift`)}${t('Sched On-Q',f1(L.schedOnQ),`sched LA ${pct(L.schedLa)}`)}
      ${t('Planned OOQ',L.schedOOQ+L.schedBreak,`${L.schedBreak} break`)}${t('Missing',L.flags.Missing||0,'')}${t('Unproductive',unprod,`${L.flags['System Issue']||0} system`)}
    </div>
    <div class="statebar" style="margin-top:10px">${parts.filter(p=>p[0]>0).map(p=>`<div style="width:${p[0]/tot*100}%;background:${p[1]}"></div>`).join('')}</div>
  </div>`;
}
function groupLegend(){
  const parts=[['Available','var(--s1)'],['On call','var(--s1b)'],['ACW / Hold / Other','var(--s3)'],['AUX-out / Prod AUX','var(--s3b)'],['Break / Lunch','var(--warn)'],['Coaching / Training / Project','var(--info)'],['Unproductive AUX','var(--crit)']];
  return `<div class="legend" style="margin-top:10px">${parts.map(p=>`<span><i style="background:${p[1]}"></i>${p[0]}</span>`).join('')}</div>`;
}
function renderGroupView(name, el){
  const Ls = groupLobs(name);
  el.innerHTML = `${groupHead(name,'Realtime LA')}<div class="cgrid">${Ls.map(compactBlock).join('')}</div>${groupLegend()}
    <h3 style="margin:18px 0 10px">Flags · all ${esc(name)} LOBs</h3>${flagGrid(Ls)}`;
}
function renderLobView(lobName, target){
  if (isGroup(lobName)) return renderGroupView(lobName, target || $('#view'));
  const R = S.result; const L = R && R.lobs[lobName];
  const el = target || $('#view');
  if (!L){ el.innerHTML='<div class="empty">Select a LOB</div>'; return; }
  el.innerHTML = `${viewHead(L,'Realtime LA')}
  <div class="vgrid"><div class="vmain">${kpiBlock(L)}<div style="margin-top:14px">${flagGrid(L)}</div></div>${minSide(L)}</div>${viewFoot(L)}`;
  wireMinTbl(L, el);
}
function renderPic(kind, L, node, page=0){
  const nm = typeof L==='string' ? L : L.name;
  if (kind==='legacy'){ node.innerHTML = legacyHTML(nm); return; }
  if (kind==='day'){ node.innerHTML = `<div class="day-wrap" style="display:block">${dayPlanHTML(nm)}</div>`; return; }
  if (kind==='flags'){
    const Ls = typeof L==='string' ? groupLobs(L) : [L];
    const pages = flagPages(Ls, PIC_FLAGS), pg = Math.min(page, pages.length-1);
    const head = typeof L==='string' ? groupHead(L,'Flags') : viewHead(L,'Flags');
    node.innerHTML = head.replace('· Flags</div>', `· Flags${pages.length>1?` · page ${pg+1}/${pages.length}`:''}</div>`) + flagPageHTML(pages[pg]);
    return; }
  if (typeof L === 'string'){ const Ls=groupLobs(L);
    node.innerHTML = kind==='flags' ? `${groupHead(L,'Unproductive & Unscheduled')}${flagGrid(Ls, PIC_FLAGS)}`
      : `${groupHead(L,'Realtime LA')}<div class="cgrid">${Ls.map(compactBlock).join('')}</div>${groupLegend()}`;
    return; }
  node.innerHTML = kind==='flags'
    ? `${viewHead(L,'Unproductive & Unscheduled')}${flagGrid(L, PIC_FLAGS)}`
    : `${viewHead(L,'Realtime LA')}${kpiBlock(L)}`;
}
function lastUpdateBox(L){
  const c = S.cms[L.name];
  if (!c) return `<div class="lu bad"><small>Last update</small><b>No CMS file</b></div>`;
  const age = Math.max(0, Math.round((Date.now()-c.mtime)/1000));
  const cls = age>300?'bad':age>120?'warn':'ok';
  const ago = age<60?`${age}s ago`:age<3600?`${Math.floor(age/60)}m ${age%60}s ago`:`${Math.floor(age/3600)}h ago`;
  return `<div class="lu ${cls}"><small>Last update · CMS file</small><b class="num">${new Date(c.mtime).toLocaleTimeString()}</b>
    <span class="num">${ago} · ${esc(c.fileName)}</span></div>`;
}
function nsBox(L){
  return `<div class="lu" style="border-left-color:var(--info)"><small>Abs / NS %</small><b class="num">${pct(L.ns)}</b>
    <span class="num">${L.nsAdj} not logged in of ${L.inShift} scheduled${L.nsEx?` · ${L.nsEx} excluded`:''}</span></div>`;
}
function minSide(L){
  const t = L.minTbl||{}, cur = L.curMin??0, base = TIME.idx*30;
  const cls = v => { const s=laStatus(v).c; return s==='good'?'lag':s==='warn'?'law':s==='crit'?'lac':''; };
  const lc = v => { const c=laStatus(v).c; return c==='none'?'':`style="color:var(--${c})"`; };
  const sel = (S.minSel && S.minSel.lob===L.name && S.minSel.idx===TIME.idx) ? S.minSel.set : new Set();
  let rows='';
  for (let i=0;i<30;i++){
    const v=t[i], fut=i>cur;
    rows += `<tr class="${i===cur?'now':''} ${fut?'fut':''} ${v&&v.man?'man':''} ${sel.has(i)?'sel':''}" data-m="${i}"${v&&v.carry!=null&&!v.man?` title="no refresh this minute — carried from minute ${v.carry}"`:''}><td class="num">${i}</td><td class="num">${fmtMin(base+i,'CLT')}</td>
      <td class="num">${v&&v.prod!=null?f1(v.prod):''}</td>
      <td><input class="num ${v?cls(v.la):''}" data-m="${i}" value="${v&&v.la!=null?(v.la*100).toFixed(1):''}" placeholder="${fut?'':'–'}"></td></tr>`;
  }
  return `<div class="sidecol">${lastUpdateBox(L)}${nsBox(L)}<div class="side"><div class="sh"><h3>Interval minutes</h3><span class="st none">${L.minFilled||0}/30</span></div>
    <div class="minsum"><div><small>Running LA</small><b class="num" ${lc(L.runLa)}>${pct(L.runLa)}</b></div><div><small>Projection</small><b class="num" ${lc(L.proj)}>${pct(L.proj)}</b></div></div>
    <table class="mintbl"><tr><th>Min</th><th>CLT</th><th>Prod</th><th style="text-align:right;padding-right:10px">LA %</th></tr>${rows}</table>
    <div class="muted" style="font-size:10.5px;margin-top:6px;line-height:1.5">Drag or Shift+click to select minutes · type a value · <b>Ctrl+Enter</b> fills all selected · Enter = one cell · empty + Ctrl+Enter clears · purple = manual</div></div></div>`;
}
function wireMinTbl(L, el){
  const tbl = el.querySelector('.mintbl'); if (!tbl) return;
  const key = () => (S.minSel && S.minSel.lob===L.name && S.minSel.idx===TIME.idx) ? S.minSel : (S.minSel={lob:L.name, idx:TIME.idx, set:new Set(), anchor:null});
  const paint = () => { const st=key().set; tbl.querySelectorAll('tr[data-m]').forEach(tr=>tr.classList.toggle('sel', st.has(+tr.dataset.m))); };
  const range = (a,b) => { const st=key(); st.set=new Set(); for (let i=Math.min(a,b);i<=Math.max(a,b);i++) st.set.add(i); paint(); };
  let drag=false;
  tbl.querySelectorAll('input[data-m]').forEach(inp=>{
    const i=+inp.dataset.m;
    inp.addEventListener('mousedown', e=>{
      const st=key();
      if (e.shiftKey && st.anchor!=null){ e.preventDefault(); range(st.anchor,i); inp.focus(); return; }
      if (e.ctrlKey){ st.set.has(i)?st.set.delete(i):st.set.add(i); st.anchor=i; paint(); return; }
      st.anchor=i; range(i,i); drag=true;
    });
    inp.addEventListener('mouseenter', ()=>{ if (drag){ range(key().anchor,i); } });
    inp.addEventListener('keydown', e=>{
      if (e.key==='Enter' && e.ctrlKey){ e.preventDefault(); const st=key(); const ms=st.set.size?[...st.set]:[i]; editMinutes(L.name, ms, inp.value); }
      else if (e.key==='Enter'){ e.preventDefault(); editMinutes(L.name,[i],inp.value); }
      else if (e.key==='Escape'){ key().set=new Set(); paint(); inp.blur(); }
    });
    inp.addEventListener('change', ()=>{ if (S._applying) return; const st=key(); if (st.set.size<=1) editMinutes(L.name,[i],inp.value); });
  });
  document.addEventListener('mouseup', ()=>{ drag=false; }, {once:true});
}
function bigChart(L){
  const [a,b]=dayWindow(L), n=b-a+1, W=1150, H=210, pl=34, pb=22, pt=8;
  const snapV = i => { const s=(L.snaps||{})[i]; return s&&s.n ? s.sum/s.n : null; };
  let max=1; for (let i=a;i<=b;i++) max=Math.max(max,L.reqArr[i],L.schedArr[i],snapV(i)||0);
  max = Math.ceil(max/5)*5||5;
  const cw=(W-pl)/n, x=i=>pl+(i-a)*cw+cw/2, y=v=>pt+(H-pt-pb)*(1-v/max);
  let g='';
  for (let k=0;k<=4;k++){ const v=max*k/4; g+=`<line x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${pl-6}" y="${y(v)+4}" text-anchor="end" font-size="10" fill="var(--text-muted)">${Math.round(v)}</text>`; }
  let bars='';
  for (let i=a;i<=b;i++){ const v=snapV(i); if(v==null) continue; const bw=Math.max(3,cw-4); bars+=`<path d="M${x(i)-bw/2},${y(0)} V${y(v)+3} q0,-3 3,-3 h${bw-6} q3,0 3,3 V${y(0)} Z" fill="var(--s1)"/>`; }
  const line = (arr,col,dash) => `<path d="${arr.slice(a,b+1).map((v,k)=>`${k?'L':'M'}${x(a+k).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${col}" stroke-width="2" ${dash?'stroke-dasharray="5 4"':''} stroke-linejoin="round"/>`;
  let ticks=''; const step=Math.max(1,Math.ceil(n/14));
  for (let i=a;i<=b;i+=step) ticks+=`<text x="${x(i)}" y="${H-6}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${fmtMin(i*30).replace(':00','').replace(' ','')}</text>`;
  const nowLine = TIME.idx>=a&&TIME.idx<=b ? `<line x1="${x(TIME.idx)}" x2="${x(TIME.idx)}" y1="${pt}" y2="${H-pb}" stroke="var(--text-secondary)" stroke-dasharray="2 3"/><text x="${x(TIME.idx)+4}" y="${pt+10}" font-size="10" fill="var(--text-secondary)">now</text>` : '';
  let hits=''; for (let i=a;i<=b;i++) hits+=`<rect class="hit" data-i="${i}" x="${pl+(i-a)*cw}" y="${pt}" width="${cw}" height="${H-pt-pb}" fill="transparent"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;margin-top:6px">${g}${bars}${line(L.reqArr,'var(--s2)')}${line(L.schedArr,'var(--s3)',true)}${nowLine}${ticks}${hits}</svg>`;
}
function wireChart(L, root){
  const tip = root.querySelector('#tip'), wrap = root.querySelector('#chartwrap'); if(!tip) return;
  root.querySelectorAll('rect.hit').forEach(r=>{
    r.onmousemove = ev => { const i=+r.dataset.i, s=(L.snaps||{})[i], act=s&&s.n?s.sum/s.n:null, rq=L.reqArr[i];
      tip.innerHTML = `<b>${intLabel(i)} ${CFG.displayTz}</b>
        <div class="tr"><span>REQ</span><b class="num">${f1(rq)}</b></div>
        <div class="tr"><span>Scheduled On-Q</span><b class="num">${f1(L.schedArr[i])}</b></div>
        <div class="tr"><span>Actual productive</span><b class="num">${act==null?'–':f1(act)}</b></div>
        <div class="tr"><span>LA</span><b class="num">${act!=null&&rq>0?pct(act/rq):'–'}</b></div>`;
      const b=wrap.getBoundingClientRect(); tip.style.display='block';
      let lx=ev.clientX-b.left+14; if (lx>b.width-180) lx-=200; tip.style.left=lx+'px'; tip.style.top=(ev.clientY-b.top-10)+'px'; };
    r.onmouseleave = ()=> tip.style.display='none';
  });
}

/* ---------- Agents table ---------- */
const COLS = [
  ['sev','Flag'],['name','Agent'],['hrid','HRID'],['login','Login'],['lob','LOB'],['sup','Supervisor'],['om','OM'],['status','Status'],
  ['state','State'],['aux','AUX reason'],['sec','Time'],['act','Sched activity'],['shift','Shift'],['nextBreak','Next break']
];
function fillSelect(id, label, vals, keep){
  const el=$(id), cur=keep??el.value;
  el.innerHTML = `<option value="">${label}: all</option>` + vals.map(v=>`<option ${v===cur?'selected':''}>${esc(v)}</option>`).join('');
}
function renderAgents(){
  const R=S.result; if(!R) return;
  const A=R.agents, uniq=k=>[...new Set(A.map(a=>a[k]).filter(Boolean))].sort();
  fillSelect('#fLob','LOB',uniq('lob')); fillSelect('#fOm','OM',uniq('om')); fillSelect('#fSup','Supervisor',uniq('sup'));
  fillSelect('#fFlag','Flag',[...new Set(A.flatMap(a=>a.flags))].sort()); fillSelect('#fState','State',uniq('state')); fillSelect('#fStatus','Status',uniq('status'));
  const q=norm($('#fSearch').value), fl=$('#fLob').value, fo=$('#fOm').value, fs=$('#fSup').value, ff=$('#fFlag').value, fst=$('#fState').value, fstat=$('#fStatus').value, only=$('#fFlagged').checked;
  let rows = A.filter(a=>(!fl||a.lob===fl)&&(!fo||a.om===fo)&&(!fs||a.sup===fs)&&(!ff||a.flags.includes(ff))&&(!fst||a.state===fst)&&(!fstat||a.status===fstat)&&(!only||a.flags.length)
    &&(!q||norm(a.name+' '+a.hrid+' '+a.login).includes(q)));
  const {key,dir}=S.sort;
  const val = (a,k)=> k==='shift'?(a.shift?a.shift[0]:9e9): k==='nextBreak'?(a.nextBreak?a.nextBreak.s:9e9): k==='sev'?a.sev*1e6+(a.sec||0): a[k]??'';
  rows.sort((x,y)=>{const a=val(x,key),b=val(y,key); return (typeof a==='number'&&typeof b==='number'?a-b:String(a).localeCompare(String(b)))*dir;});
  S.filtered = rows;
  $('#fCount').textContent = `${rows.length} of ${A.length} agents`;
  const th = COLS.map(([k,l])=>`<th data-k="${k}">${l}${key===k?(dir>0?' ▲':' ▼'):''}</th>`).join('');
  const body = rows.slice(0,1500).map(a=>`<tr class="sev${a.sev}">
    <td class="flag">${a.flags.map(f=>`<span class="st ${sevClass(FLAG[f]||1)}">${esc(f)}</span>`).join(' ')||(a.excused?'<span class="st none">Excused</span>':'<span class="muted">—</span>')}</td>
    <td>${esc(a.name)}</td><td class="num">${esc(a.hrid)}</td><td class="num">${esc(a.login)}</td><td>${esc(a.lob)}</td><td>${esc(a.sup)}</td><td>${esc(a.om)}</td><td>${esc(a.status)}</td>
    <td>${a.productive?'<span class="st good">'+esc(a.state)+'</span>':esc(a.state)}</td><td>${esc(a.aux)}</td><td class="num">${fmtDur(a.sec)}</td><td>${esc(a.act)}</td>
    <td class="num">${a.shift?fmtMin(a.shift[0])+' – '+fmtMin(a.shift[1]):'–'}</td><td class="num">${a.nextBreak?fmtMin(a.nextBreak.s):'–'}</td></tr>`).join('');
  $('#agTbl').innerHTML = `<thead><tr>${th}</tr></thead><tbody>${body}</tbody>`;
  $('#agTbl').querySelectorAll('th').forEach(h=>h.onclick=()=>{const k=h.dataset.k; S.sort = {key:k, dir:S.sort.key===k?-S.sort.dir:(k==='sev'||k==='sec'?-1:1)}; renderAgents();});
}
function exportCsv(){
  const rows=S.filtered||[]; const H=['Flags','Agent','HRID','Login','LOB','Supervisor','OM','Status','State','AUX','Time','Activity','Shift start','Shift end'];
  const q=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  const csv=[H.join(',')].concat(rows.map(a=>[a.flags.join(' | '),a.name,a.hrid,a.login,a.lob,a.sup,a.om,a.status,a.state,a.aux,fmtDur(a.sec),a.act,a.shift?fmtMin(a.shift[0]):'',a.shift?fmtMin(a.shift[1]):''].map(q).join(','))).join('\r\n');
  download(new Blob(['\uFEFF'+csv],{type:'text/csv'}), `RTA_agents_${stamp()}.csv`);
}
const stamp = () => { const t=TIME||nowCtx(); return t.estDate.replace(/\//g,'-')+'_'+fmtMin(t.idx*30,'CLT').replace(/[: ]/g,''); };
function download(blob,name){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),4000); }

/* ---------- Setup page ---------- */
const CFG_FIELDS = [
  ['displayTz','Display times in',['CLT','EST']],
  ['refreshSec','Auto-refresh (seconds)','num'],
  ['overrideEst','Simulate EST time (HH:MM, blank = live)','text'],
  ['laGood','Well staffed (green) above (%)','num'],['laWarn','Tight (yellow) from (%) — below = failing (red)','num'],
  ['graceMin','Grace for breaks / shift start (min)','num'],
  ['breakOverMin','Break overrun allowed (min)','num'],
  ['excessAuxMin','Excessive unproductive AUX (min)','num'],
  ['longCallMin','Long call (min)','num'],['longAcwSec','Long ACW (sec)','num'],['longHoldSec','Long hold/other (sec)','num'],['auxOutMin','Outbound parking (min)','num'],
  ['missingSkipBreak','Ignore agents on scheduled break in "Missing"','bool'],
  ['groups','LOB groups (Name=LOB|LOB|LOB ; …)','text'],
  ['exportSec','Picture export every (seconds)','num'],
  ['exportOn','Auto-export pictures for Teams sender','bool'],
  ['flagsSplit','Split long flag lists into pages (off = one picture)','bool'],
  ['laDriver','Send frequency follows',['proj','la']],
  ['paidHours','Day plan: paid hours per HC','num'],
  ['prodStates','Productive CMS states','text'],['breakAux','Break AUX reasons','text'],['coachAux','Coaching AUX reasons','text'],['trainAux','Training AUX reasons','text'],['systemAux','System issue AUX reasons','text'],
  ['onQActs','IEX activities = On-Queue','text'],['breakActs','IEX activities = Break','text'],['coachActs','IEX activities = Coaching','text'],['trainActs','IEX activities = Training','text'],['systemActs','IEX activities = System','text'],['projectAux','Project AUX reasons','text'],['projectActs','IEX activities = Project','text'],['leaveActs','IEX activities = Leave','text']
];
function renderOff(){
  { const o=getOff(); o.nsEx ||= [];
    $('#nsxCount').textContent = o.nsEx.reduce((a,r)=>a+(+r.n||0),0);
    const R=S.result;
    $('#nsxTbl').innerHTML = `<tr><th>LOB</th><th style="width:120px">Exclude (agents)</th><th>NS% now</th><th></th></tr>` + (o.nsEx.length ? o.nsEx.map((r,i)=>{ const L=R&&R.lobs[r.lob];
      return `<tr><td><select data-x="${i}" data-k="lob" class="btn sm">${CFG.lobs.map(l=>`<option ${l.name===r.lob?'selected':''}>${esc(l.name)}</option>`).join('')}</select></td>
      <td><input type="number" min="0" data-x="${i}" data-k="n" value="${esc(r.n??0)}"></td>
      <td class="num">${L?`${pct(L.ns)} <span class="muted">(${L.nsAdj}/${L.inShift})</span>`:'–'}</td><td><button class="btn sm" data-nsxdel="${i}">✕</button></td></tr>`;}).join('') : `<tr><td colspan="4" class="muted">No exclusions.</td></tr>`);
    document.querySelectorAll('#nsxTbl [data-x]').forEach(el=>el.onchange=()=>{ if (S._offBusy) return; S._offBusy=true; try{ const o=getOff(); o.nsEx ||= []; o.nsEx[+el.dataset.x][el.dataset.k] = el.dataset.k==='n'?Math.max(0,+el.value||0):el.value; setOff(o); compute(); renderOff(); } finally { S._offBusy=false; } });
    document.querySelectorAll('[data-nsxdel]').forEach(b=>b.onclick=()=>{ const o=getOff(); o.nsEx.splice(+b.dataset.nsxdel,1); setOff(o); compute(); renderOff(); });
  }
  const o=getOff(); const byHr=new Map((S.roster?S.roster.agents:[]).map(a=>[a.hrid,a]));
  const info = hr => { const r=byHr.get(String(hr)); return r?{name:r.name,lob:tierToLob(r.tier),sup:r.sup}:{name:'<span class="st warn">not in roster</span>',lob:'',sup:''}; };
  $('#absCount').textContent = o.absent.length;
  $('#absTbl').innerHTML = `<tr><th>HRID</th><th>Agent</th><th>LOB</th><th>Supervisor</th><th></th></tr>` + (o.absent.length? o.absent.map((a,i)=>{const x=info(a.hrid); return `<tr><td class="num">${esc(a.hrid)}</td><td>${x.name.startsWith('<')?x.name:esc(x.name)}</td><td>${esc(x.lob)}</td><td>${esc(x.sup)}</td><td><button class="btn sm" data-absdel="${i}">✕</button></td></tr>`;}).join('') : `<tr><td colspan="5" class="muted">No absent agents pasted for today.</td></tr>`);
  $('#winCount').textContent = o.wins.length;
  $('#winTbl').innerHTML = `<tr><th style="width:120px">HRID</th><th>Agent</th><th style="width:110px">Start (${CFG.displayTz})</th><th style="width:110px">End (${CFG.displayTz})</th><th>Reason</th><th></th><th></th></tr>` +
    (o.wins.length? o.wins.map((w,i)=>{ const x=info(w.hrid); const on = w.hrid && excusedNow(String(w.hrid).trim(), (TIME||nowCtx()).estMin);
      return `<tr><td><input data-w="${i}" data-k="hrid" value="${esc(w.hrid||'')}" placeholder="HRID"></td><td>${w.hrid?(x.name.startsWith('<')?x.name:esc(x.name)):''}</td>
      <td><input type="time" data-w="${i}" data-k="start" value="${esc(w.start||'')}"></td><td><input type="time" data-w="${i}" data-k="end" value="${esc(w.end||'')}"></td>
      <td><input data-w="${i}" data-k="reason" value="${esc(w.reason||'')}" placeholder="optional"></td><td>${on?'<span class="st good">active</span>':''}</td><td><button class="btn sm" data-windel="${i}">✕</button></td></tr>`;}).join('') : `<tr><td colspan="7" class="muted">Press + Add to excuse an agent for a time window.</td></tr>`);
  document.querySelectorAll('[data-absdel]').forEach(b=>b.onclick=()=>{const o=getOff(); o.absent.splice(+b.dataset.absdel,1); setOff(o); compute(); renderOff();});
  document.querySelectorAll('[data-windel]').forEach(b=>b.onclick=()=>{const o=getOff(); o.wins.splice(+b.dataset.windel,1); setOff(o); compute(); renderOff();});
  document.querySelectorAll('#winTbl input[data-w]').forEach(inp=>inp.onchange=()=>{ if (S._offBusy) return; S._offBusy=true; try{ const o=getOff(); o.wins[+inp.dataset.w][inp.dataset.k]=inp.value.trim(); setOff(o); compute(); const k=inp.dataset.k, w=inp.dataset.w; renderOff(); const nx=document.querySelector(`#winTbl input[data-w="${w}"][data-k="${k}"]`); } finally { S._offBusy=false; } });
}
/* ---------- auto-export of pictures for the Teams sender ---------- */
function exportTargets(){
  const R=S.result; if(!R) return [];
  const t=[];
  for (const g of lobGroups()){ const Ls=groupLobs(g.name); if (Ls.some(L=>L.hasRt)) t.push({name:g.name, lobs:Ls}); }
  for (const L of Object.values(R.lobs)) if (L.hasRt) t.push({name:L.name, lobs:[L]});
  return t;
}
async function writeFile(dir, name, blob){ const fh=await dir.getFileHandle(name,{create:true}); const w=await fh.createWritable(); await w.write(blob); await w.close(); }
async function exportPictures(interactive){
  if (!S.outHandle || S._exporting) return;
  try{
    let perm = await S.outHandle.queryPermission({mode:'readwrite'});
    if (perm!=='granted' && interactive) perm = await S.outHandle.requestPermission({mode:'readwrite'});
    if (perm!=='granted'){ S.outMeta={...S.outMeta, needPerm:true}; renderPills(); return; }
    S._exporting = true; S.outMeta={...S.outMeta, needPerm:false};
    const man = {generatedAt:new Date().toISOString(), interval:intLabel(TIME.idx,'CLT')+' CLT', targets:[]};
    for (const t of exportTargets()){
      const cmsM = Math.min(...t.lobs.filter(L=>S.cms[L.name]).map(L=>S.cms[L.name].mtime));
      let pages=1; const files=[];
      for (const kind of picViewsFor(t.name)){
        const n = picPageCount(kind, t.name); if (kind==='flags') pages=n;
        for (let i=0;i<n;i++){
          const c = await picCanvas(kind, t.name, i);
          const blob = await new Promise(r=>c.toBlob(r,'image/png'));
          const fn = `${slug(t.name)}_${kind}${i?'_'+(i+1):''}.png`;
          await writeFile(S.outHandle, fn, blob); files.push(fn);
        }
        for (let i=n;i<8;i++){ try{ await S.outHandle.removeEntry(`${slug(t.name)}_${kind}_${i+1}.png`); }catch(e){} }   // drop stale extra pages
      }
      const la = t.lobs.length===1 ? t.lobs[0] : null;
      man.targets.push({name:t.name, slug:slug(t.name), cmsUpdated:new Date(cmsM).toISOString(), exportedAt:new Date().toISOString(),
        interval:TIME.idx, estDate:TIME.estDate, flagPages:pages, files,
        lobs:t.lobs.map(L=>({name:L.name, la:L.la, proj:L.proj, runLa:L.runLa, status:laStatus(L.proj??L.la).c}))});
    }
    await writeFile(S.outHandle, 'manifest.json', new Blob([JSON.stringify(man,null,2)],{type:'application/json'}));
    S.outMeta = {...S.outMeta, last:Date.now(), n:man.targets.length, err:null};
  }catch(e){ console.error(e); S.outMeta={...S.outMeta, err:e.message}; }
  finally{ S._exporting=false; }
  if (document.querySelector('#page-setup.active')) renderSetup();
}
let exportTimer=null;
function restartExport(){ clearInterval(exportTimer); if (CFG.exportOn) exportTimer=setInterval(()=>exportPictures(false), Math.max(20,+CFG.exportSec||60)*1000); }
function renderSetup(){
  { const m=S.outMeta||{}; const el=$('#infoOut'); if (el){ el.textContent = S.outHandle ? `📁 ${S.outHandle.name}${m.needPerm?' · click Reconnect':''}${m.last?` · last export ${new Date(m.last).toLocaleTimeString()} (${m.n} targets)`:''}${m.err?' · ⚠ '+m.err:''}` : 'Not connected — pick e.g. C:\\RTA\\OUT';
      el.closest('.drop').classList.toggle('ok', !!(S.outHandle && m.last && !m.err)); $('#btnOut').textContent = S.outHandle ? (m.needPerm?'Reconnect':'Change') : 'Connect'; } }
  const info = (id,ok,txt)=>{ $(id).textContent=txt; $(id).closest('.drop').classList.toggle('ok',ok); };
  const t = d => new Date(d).toLocaleString();
  info('#infoLat',!!S.lat, S.lat?`${S.lat.fileName} · ${S.lat.forecasts} forecasts · date ${S.lat.date||'?'} · loaded ${t(S.lat.loadedAt)}`:'Not loaded');
  info('#infoRoster',!!S.roster, S.roster?`${S.roster.fileName} · ${S.roster.agents.length} agents · loaded ${t(S.roster.loadedAt)}`:'Not loaded');
  info('#infoSched',!!S.sched, S.sched?`${S.sched.fileName} · ${Object.keys(S.sched.agents).length} agents · ${S.sched.date||''} · loaded ${t(S.sched.loadedAt)}`:'Not loaded');
  const lobsIn = Object.entries(S.cms).map(([k,v])=>`${k} (${v.rows.length})`).join(', ');
  info('#infoCms', !!Object.keys(S.cms).length, (S.dirHandle?`📁 ${S.dirHandle.name} · `:'') + (lobsIn||'No data') + (S.cmsMeta.lastRead?` · read ${new Date(S.cmsMeta.lastRead).toLocaleTimeString()}`:'') + (S.cmsMeta.errors.length?` · ⚠ ${S.cmsMeta.errors.join('; ')}`:''));
  $('#btnFolder').textContent = S.dirHandle ? (S.cmsMeta.needPerm?'Reconnect folder':'Change folder') : 'Connect folder';
  $('#refreshSec').value = CFG.refreshSec;
  $('#pasteLob').innerHTML = CFG.lobs.map(l=>`<option>${esc(l.name)}</option>`).join('');
  $('#cfgFields').innerHTML = CFG_FIELDS.map(([k,l,t])=>{
    let inp; if (Array.isArray(t)) inp=`<select data-cfg="${k}">${t.map(o=>`<option ${CFG[k]===o?'selected':''}>${o}</option>`).join('')}</select>`;
    else if (t==='bool') inp=`<input type="checkbox" data-cfg="${k}" ${CFG[k]?'checked':''}>`;
    else inp=`<input type="${t==='num'?'number':'text'}" data-cfg="${k}" value="${esc(CFG[k])}" ${t==='text'&&String(CFG[k]).length>20?'style="width:260px"':''}>`;
    return `<label><span>${l}</span>${inp}</label>`; }).join('');
  $('#cfgFields').querySelectorAll('[data-cfg]').forEach(el=>el.onchange=()=>{const k=el.dataset.cfg; CFG[k]= el.type==='checkbox'?el.checked : el.type==='number'?+el.value : el.value; saveCfg(); restartTimer(); restartExport(); compute(); renderAll();});
  renderLobTbl(); renderPicTbl();
}
const VIEW_KINDS = [['view','LA view'],['legacy','Legacy'],['flags','Flags']];
function picViewsFor(name){ const v=(CFG.picViews||{})[name]; return Array.isArray(v)&&v.length ? v : ['view','flags']; }
function renderPicTbl(){
  const el=$('#picTbl'); if(!el) return;
  const names=[...lobGroups().map(g=>g.name), ...CFG.lobs.map(l=>l.name)];
  el.innerHTML = `<tr><th>LOB / group</th>${VIEW_KINDS.map(([k,l])=>`<th style="text-align:center">${l}</th>`).join('')}</tr>` +
    names.map(n=>`<tr><td>${esc(n)}</td>${VIEW_KINDS.map(([k])=>`<td style="text-align:center"><input type="checkbox" data-pv="${esc(n)}" data-k="${k}" ${picViewsFor(n).includes(k)?'checked':''}></td>`).join('')}</tr>`).join('');
  el.querySelectorAll('[data-pv]').forEach(cb=>cb.onchange=()=>{ const n=cb.dataset.pv; CFG.picViews ||= {};
    const cur=new Set(picViewsFor(n)); cb.checked?cur.add(cb.dataset.k):cur.delete(cb.dataset.k);
    CFG.picViews[n]=VIEW_KINDS.map(x=>x[0]).filter(k=>cur.has(k)); if(!CFG.picViews[n].length){ CFG.picViews[n]=['view']; renderPicTbl(); }
    saveCfg(); });
}
function renderLobTbl(){
  const f = ['name','fc','files','tiers','prodAux'];
  $('#lobTbl').innerHTML = `<tr><th>LOB</th><th>Forecast name(s) · LAT</th><th>CMS file name(s)</th><th>Roster tier(s)</th><th>Prod AUX</th><th></th></tr>` +
    CFG.lobs.map((l,i)=>`<tr>${f.map(k=>`<td><input data-i="${i}" data-k="${k}" value="${esc(l[k]||'')}"></td>`).join('')}<td><button class="btn sm" data-del="${i}">✕</button></td></tr>`).join('');
  $('#lobTbl').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{CFG.lobs.splice(+b.dataset.del,1);renderLobTbl();});
}
function saveLobTbl(){
  $('#lobTbl').querySelectorAll('input[data-i]').forEach(el=>{CFG.lobs[+el.dataset.i][el.dataset.k]=el.value.trim();});
  CFG.lobs = CFG.lobs.filter(l=>l.name); saveCfg(); compute(); renderAll(); toast('LOB setup saved');
}

/* ---------- PNG ---------- */
async function picCanvas(kind, lobName, page=0){
  const nm = lobName||S.selLob, grp = isGroup(nm);
  const L = grp ? nm : (S.result && S.result.lobs[nm]); if (!L) throw new Error('No LOB selected');
  const node = document.createElement('div'); node.className='pic'+(kind==='legacy'||kind==='day'?' legacy-pic':'');
  const nLeg = grp ? groupLobs(nm).length : 1;
  const W = kind==='day' ? 1520 : kind==='legacy' ? 40+nLeg*540 : (grp&&kind!=='flags'?1500:1240);
  node.style.cssText = `position:fixed;left:-99999px;top:0;width:${W}px;padding:22px 24px;background:var(--surface-1);border:1px solid var(--border);border-radius:16px;font-family:var(--font);color:var(--text-primary)`;
  document.body.appendChild(node); renderPic(kind, L, node, page);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  try { return await html2canvas(node,{backgroundColor:bg,scale:2,windowWidth:1400,logging:false,onclone:d=>d.documentElement.classList.add('capture')}); }
  finally { node.remove(); }
}
async function copyPic(kind, page=0){
  try{
    const c = await picCanvas(kind, null, page);
    const blob = await new Promise(r=>c.toBlob(r,'image/png'));
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
    toast(`${kind==='flags'?'Flags':kind==='legacy'?'Legacy':kind==='day'?'Day plan':'View'} picture${kind==='flags'?` page ${page+1}`:''} copied — paste it in Teams (Ctrl+V)`);
  }catch(e){ console.error(e); toast('Clipboard blocked here — saving PNG instead',true); savePic(kind); }
}
async function savePic(kind, lob){ const nm=lob||S.selLob; const n=picPageCount(kind,nm);
  for (let i=0;i<n;i++){ const c=await picCanvas(kind, nm, i); await new Promise(res=>c.toBlob(b=>{download(b,`${kind==='flags'?'Flags':kind==='legacy'?'Legacy':kind==='day'?'DayPlan':'LA'}_${nm.replace(/\W+/g,'_')}_${stamp()}${n>1?'_p'+(i+1):''}.png`); res();},'image/png')); } }
async function saveAllPng(){ for (const L of activeLobs().filter(L=>L.hasRt)) { await savePic('view',L.name); await new Promise(r=>setTimeout(r,400)); } }
window.viewToCanvas = () => picCanvas('view');

/* ---------- glue ---------- */
function renderFlagPageBtns(){
  const el=$('#flagPageBtns'); if(!el||!S.result) return;
  let n=1; try{ n=picPageCount('flags', S.selLob); }catch(e){}
  el.innerHTML = n>1 ? Array.from({length:n-1},(_,i)=>`<button class="btn primary" data-fp="${i+1}">⧉ Flags page ${i+2}/${n}</button>`).join(' ') : '';
  el.querySelectorAll('[data-fp]').forEach(b=>b.onclick=()=>copyPic('flags',+b.dataset.fp));
}
function renderAll(){
  if (!S.result) compute();
  renderClock(); renderPills();
  const page = document.querySelector('.page.active').id;
  if (page==='page-overview') renderOverview();
  if (page==='page-lob' && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('.mintbl'))){ renderLobSelect(); renderLobView(S.selLob); renderFlagPageBtns(); }
  if (page==='page-day'){ renderLobSelect(); renderDay(); }
  if (page==='page-legacy'){ renderLobSelect(); $('#legSel').innerHTML=$('#lobSel').innerHTML; $('#legSel').value=S.selLob; if (S.result){ $('#legacyView').innerHTML = legacyHTML(S.selLob); $('#legacyFlags').innerHTML = `<h3 style="margin:4px 0 10px">Flags</h3>`+flagGrid(isGroup(S.selLob)?groupLobs(S.selLob):[S.result.lobs[S.selLob]].filter(Boolean)); } }
  if (page==='page-agents') renderAgents();
  if (page==='page-setup') renderSetup();
  if (page==='page-auto' && window.renderAuto) renderAuto();
  if (page==='page-off' && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('#page-off'))) renderOff();
}
function switchTab(p){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.page===p));
  document.querySelectorAll('.page').forEach(s=>s.classList.toggle('active',s.id==='page-'+p));
  renderAll();
}
window.switchTab = switchTab;
let timer=null;
function restartTimer(){ clearInterval(timer); timer=setInterval(()=>{ if (S.dirHandle) readFolder(false); else { compute(); renderAll(); } }, Math.max(15,+CFG.refreshSec||60)*1000); }

function wire(){
  document.addEventListener('click', e=>{ const g=e.target.closest('[data-goto]'); if(g){ e.preventDefault(); switchTab(g.dataset.goto); } });
  document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>switchTab(t.dataset.page));
  document.querySelectorAll('input[type=file][data-kind]').forEach(inp=>inp.onchange=async()=>{ for (const f of inp.files) await loadDayFile(f, inp.dataset.kind); inp.value=''; compute(); renderAll(); });
  const card = $('#dropLat').closest('.card');
  card.addEventListener('dragover',e=>{e.preventDefault();});
  card.addEventListener('drop',async e=>{e.preventDefault(); for (const f of e.dataTransfer.files) await loadDayFile(f); compute(); renderAll();});
  $('#cmsFiles').onchange = async e => { S.cmsMeta.cycle=(S.cmsMeta.cycle||0)+1; S.cmsMeta.errors=[]; for (const f of e.target.files) await loadCmsFile(f); e.target.value=''; S.cmsMeta.lastRead=Date.now(); compute(); renderAll(); };
  $('#btnFolder').onclick = async () => {
    if (!window.showDirectoryPicker){ toast('Folder access needs Chrome or Edge. Use "Load CMS files manually".',true); return; }
    if (S.dirHandle && S.cmsMeta.needPerm){ return readFolder(true); }
    try{ S.dirHandle = await window.showDirectoryPicker({id:'rta-cms',mode:'read'}); await idb.set('dir',S.dirHandle); await readFolder(true); restartTimer(); }catch(e){ if (e.name!=='AbortError') toast(e.message,true); }
  };
  $('#refreshSec').onchange = e => { CFG.refreshSec=Math.max(15,+e.target.value||60); saveCfg(); restartTimer(); };
  $('#btnPaste').onclick = () => { const lob=$('#pasteLob').value, text=$('#pasteBox').value; if(!text.trim()) return;
    const rows=parseCMS([{rows:splitDelimited(text)}]); if(!rows.length){toast('No agent rows found in paste',true);return;}
    pasted[lob]={text,at:Date.now()}; LS.set('rta_pasted',pasted); S.cms[lob]={rows,fileName:'pasted',mtime:Date.now(),source:'paste'};
    $('#pasteBox').value=''; toast(`${rows.length} agents pasted into ${lob}`); compute(); renderAll(); };
  $('#btnPasteClear').onclick = () => { for (const k of Object.keys(pasted)){ delete pasted[k]; if (S.cms[k]&&S.cms[k].source==='paste') delete S.cms[k]; } LS.del('rta_pasted'); compute(); renderAll(); };
  $('#btnClearDay').onclick = () => { if(!confirm('Clear LAT, roster and schedule?')) return; ['rta_lat','rta_roster','rta_sched'].forEach(LS.del); S.lat=S.roster=S.sched=null; compute(); renderAll(); };
  $('#btnClearSnaps').onclick = () => { Object.keys(localStorage).filter(k=>k.startsWith('rta_snap_')).forEach(k=>localStorage.removeItem(k)); compute(); renderAll(); toast('Intraday history reset'); };
  $('#btnAbsAdd').onclick = () => { const ids=[...new Set(($('#absPaste').value.match(/\b\d{8,10}\b/g)||[]))]; if(!ids.length){toast('No HRIDs found in paste',true);return;}
    const o=getOff(); const have=new Set(o.absent.map(a=>String(a.hrid))); let n=0; for (const h of ids) if(!have.has(h)){o.absent.push({hrid:h}); n++;}
    setOff(o); $('#absPaste').value=''; toast(`${n} absent agent(s) added`); compute(); renderOff(); };
  $('#btnAbsClear').onclick = () => { if(!confirm('Clear the absent list?')) return; const o=getOff(); o.absent=[]; setOff(o); compute(); renderOff(); };
  $('#btnNsxAdd').onclick = () => { const o=getOff(); o.nsEx ||= []; o.nsEx.push({lob:S.selLob||CFG.lobs[0].name, n:1}); setOff(o); compute(); renderOff(); };
  $('#btnWinAdd').onclick = () => { const o=getOff(); o.wins.push({hrid:'',start:'',end:'',reason:''}); setOff(o); renderOff(); const ins=document.querySelectorAll('#winTbl input[data-k="hrid"]'); ins[ins.length-1]?.focus(); };
  $('#btnWinClear').onclick = () => { if(!confirm('Remove all excused windows?')) return; const o=getOff(); o.wins=[]; setOff(o); compute(); renderOff(); };
  $('#btnAddLob').onclick = () => { CFG.lobs.push({name:'New LOB',fc:'',files:'',tiers:'',prodAux:''}); renderLobTbl(); };
  $('#btnSaveLob').onclick = saveLobTbl;
  $('#btnResetCfg').onclick = () => { if(!confirm('Reset thresholds and LOB setup to defaults?')) return; CFG=JSON.parse(JSON.stringify(DEFAULT_CFG)); saveCfg(); compute(); renderAll(); };
  $('#btnOut').onclick = async () => {
    if (!window.showDirectoryPicker){ toast('Needs Chrome or Edge',true); return; }
    if (S.outHandle && (S.outMeta||{}).needPerm) return exportPictures(true);
    try{ S.outHandle = await window.showDirectoryPicker({id:'rta-out',mode:'readwrite'}); await idb.set('outdir',S.outHandle); await exportPictures(true); restartExport(); toast('Export folder connected'); }catch(e){ if (e.name!=='AbortError') toast(e.message,true); }
  };
  $('#btnRefresh').onclick = () => S.dirHandle ? readFolder(true) : (compute(), renderAll());
  $('#btnTheme').onclick = () => { const r=document.documentElement, order=['light','gray','dark']; r.dataset.theme = order[(order.indexOf(r.dataset.theme)+1)%3]; LS.set('rta_theme',r.dataset.theme); toast('Theme: '+r.dataset.theme); renderAll(); };
  $('#legSel').onchange = e => { S.selLob=e.target.value; LS.set('rta_selLob',S.selLob); renderAll(); };
  $('#daySel').onchange = e => { S.selLob=e.target.value; LS.set('rta_selLob',S.selLob); renderAll(); };
  $('#dayAbs').onchange = e => { const Ls = isGroup(S.selLob)?[]:[S.selLob]; if(Ls.length){ CFG.absPct ||= {}; CFG.absPct[Ls[0]] = Math.max(0,Math.min(100,+e.target.value||0)); saveCfg(); renderDay(); } };
  $('#btnCopyDay').onclick = () => copyPic('day'); $('#btnSaveDay').onclick = () => savePic('day');
  $('#btnCopyLeg').onclick = () => copyPic('legacy'); $('#btnSaveLeg').onclick = () => savePic('legacy');
  $('#lobSel').onchange = e => { S.selLob=e.target.value; LS.set('rta_selLob',S.selLob); renderLobView(S.selLob); };
  $('#btnCopyPng').onclick = () => copyPic('view'); $('#btnCopyFlags').onclick = () => copyPic('flags'); $('#btnSavePng').onclick = () => savePic('view'); $('#btnSaveFlags').onclick = () => savePic('flags'); $('#btnAllPng').onclick = saveAllPng; $('#btnCsv').onclick = exportCsv;
  ['#fSearch','#fLob','#fOm','#fSup','#fFlag','#fState','#fStatus','#fFlagged'].forEach(s=>$(s).addEventListener(s==='#fSearch'?'input':'change',renderAgents));
}
(async function init(){
  if (!LS.get('rta_theme_v2',false)){ LS.set('rta_theme','light'); LS.set('rta_theme_v2',true); }
  document.documentElement.dataset.theme = LS.get('rta_theme','light');
  wire(); applyPasted();
  try{ const h = await idb.get('dir'); if (h){ S.dirHandle=h; await readFolder(false); } }catch(e){}
  try{ const o = await idb.get('outdir'); if (o){ S.outHandle=o; S.outMeta={}; } }catch(e){}
  compute(); renderAll(); restartTimer(); restartExport(); if (S.outHandle) exportPictures(false);
  setInterval(renderClock, 15000);
})();
