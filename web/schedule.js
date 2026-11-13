// Pure scheduling helpers (no chrome.* APIs) — shared by the service worker and unit tests.

export function estParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; f.formatToParts(date).forEach(p => o[p.type] = p.value);
  const estMin = (+o.hour) * 60 + (+o.minute) + (+o.second) / 60;
  return { estMin, idx: Math.floor(estMin / 30), estDate: `${o.month}/${o.day}/${o.year}` };
}

export function parseHHMM(s) {
  s = String(s || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?$/);
  if (!m) return NaN;
  let h = +m[1], mi = +m[2];
  if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = 0; if (pm) h += 12; }
  if (h > 23 || mi > 59) return NaN;
  return h * 60 + mi;
}

/** Local (PC clock) start/stop window. Stop earlier than start = overnight. Empty = open. */
export function inWindow(localMin, start, stop) {
  const a = parseHHMM(start), b = parseHHMM(stop);
  if (a == null && b == null) return true;
  if (a != null && b == null) return localMin >= a;
  if (a == null && b != null) return localMin < b;
  if (a === b) return true;
  return a < b ? (localMin >= a && localMin < b) : (localMin >= a || localMin < b);
}

/** Status with hysteresis so a LOB sitting on a threshold does not flip every minute. */
export function statusOf(v, prev, good = 100, warn = 92, margin = 1) {
  if (v == null || isNaN(v)) return prev || 'none';
  const p = v * 100;
  const raw = p > good ? 'good' : p >= warn ? 'warn' : 'crit';
  if (!prev || prev === 'none' || prev === raw) return raw;
  // only leave the previous status once we're clearly past its border
  if (prev === 'good') return p > good - margin ? 'good' : raw;
  if (prev === 'crit') return p < warn + margin ? 'crit' : raw;
  if (prev === 'warn') { if (raw === 'good') return p > good + margin ? 'good' : 'warn'; return p < warn - margin ? 'crit' : 'warn'; }
  return raw;
}

/** Minutes between sends for a target given its mode and status. */
export function everyFor(t, status) {
  if (t.mode === 'status') {
    const m = { crit: t.fail, warn: t.tight, good: t.pass }[status];
    return Math.max(0.5, +(m ?? t.every ?? 5));
  }
  return Math.max(0.5, +(t.every ?? 5));
}

/**
 * Is a send due?  Interval-aligned: first send at interval start + offset (default 1 min, i.e. :01 / :31),
 * then every N minutes, never in the last `tail` minutes of the interval; resets every interval.
 */
export function isDue({ t, last, status, est, localMin, nowMs }) {
  if (!t.enabled) return { due: false, why: 'disabled' };
  if (!inWindow(localMin, t.start, t.stop)) return { due: false, why: 'outside start/stop' };
  const offset = +(t.offsetMin ?? 1), tail = +(t.tailMin ?? 0.75);
  const inInt = est.estMin - est.idx * 30;
  if (inInt < offset) return { due: false, why: `waiting for :${String(offset).padStart(2, '0')} of the interval` };
  if (inInt > 30 - tail) return { due: false, why: 'end of interval' };
  const every = everyFor(t, status);
  if (!last || last.idx !== est.idx || last.estDate !== est.estDate) return { due: true, every, why: 'first send this interval' };
  const mins = (nowMs - last.at) / 60000;
  if (mins + 1e-6 >= every) return { due: true, every, why: `every ${every} min` };
  return { due: false, every, why: `next in ${Math.ceil((every - mins) * 60)}s` };
}

export function webChatLink(link) {
  link = String(link || '').trim();
  if (link.startsWith('msteams:')) link = link.replace(/^msteams:\/?/, 'https://teams.cloud.microsoft/');
  return link;
}

export function serverOf(url) {
  try { const u = new URL(url); return u.origin; } catch { return null; }
}

export function loginUrlFor(reportUrl) {
  try { const u = new URL(reportUrl); return `${u.origin}${u.pathname}#/login`; } catch { return null; }
}

export function looksLikeCmsCsv(text) {
  // needs the header row: without it the dashboard can't tell which column is State/AUX Reason
  if (!text || text.length < 10) return false;
  const hdr = String(text).split(/\r?\n/).slice(0, 30).find(l => /login\s*id/i.test(l));
  return !!hdr && /\bstate\b/i.test(hdr) && /agent\s*name|aux\s*reason/i.test(hdr);
}

export function countCmsRows(text) {
  return (String(text).match(/^[^\n]*?\b\d{8,}\b[^\n]*$/gm) || []).length;
}
