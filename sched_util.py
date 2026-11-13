"""Interval-aligned sending rules shared by the Teams desktop sender (same rules as the web sender / extension).

* intervals are 30 min in EST (America/New_York, DST-aware)
* first send of an interval at :01 / :31 (offset 1 min), then every N minutes
* nothing in the last 45 s of an interval (so an old interval's pictures never post in the new one)
* N can depend on the LOB status: failing / tight / passing (with a 1-point buffer against flip-flopping)
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone


def _us_eastern_offset(utc: datetime) -> timedelta:
    """UTC offset for US Eastern without tz data: DST from 2nd Sunday of March 2:00 to 1st Sunday of November 2:00."""
    y = utc.year

    def nth_sunday(month, n):
        d = datetime(y, month, 1, tzinfo=timezone.utc)
        d += timedelta(days=(6 - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)
    dst_start = nth_sunday(3, 2) + timedelta(hours=7)    # 2:00 EST = 07:00 UTC
    dst_end = nth_sunday(11, 1) + timedelta(hours=6)     # 2:00 EDT = 06:00 UTC
    return timedelta(hours=-4) if dst_start <= utc < dst_end else timedelta(hours=-5)


def est_now(utc: datetime | None = None) -> datetime:
    utc = utc or datetime.now(timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        return utc.astimezone(ZoneInfo("America/New_York"))
    except Exception:
        return (utc + _us_eastern_offset(utc)).replace(tzinfo=None)


def est_parts(utc: datetime | None = None) -> dict:
    e = est_now(utc)
    est_min = e.hour * 60 + e.minute + e.second / 60
    return {"est_min": est_min, "idx": int(est_min // 30), "est_date": e.strftime("%m/%d/%Y")}


def parse_hhmm(s):
    s = str(s or "").strip()
    if not s:
        return None
    m = re.match(r"^(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?$", s)
    if not m:
        raise ValueError(f"Time '{s}' not understood — use 23:00 or 11:00 PM")
    h, mi = int(m.group(1)), int(m.group(2))
    if m.group(3):
        pm = m.group(3).lower().startswith("p")
        if h == 12:
            h = 0
        if pm:
            h += 12
    if h > 23 or mi > 59:
        raise ValueError(f"Time '{s}' not understood")
    return h * 60 + mi


def in_window(local_min: float, start: str, stop: str) -> bool:
    """PC-clock window, repeating daily. Stop earlier than start = overnight. Empty = always."""
    a, b = parse_hhmm(start), parse_hhmm(stop)
    if a is None and b is None:
        return True
    if b is None:
        return local_min >= a
    if a is None:
        return local_min < b
    if a == b:
        return True
    return (a <= local_min < b) if a < b else (local_min >= a or local_min < b)


def status_of(v, prev=None, good=100.0, warn=92.0, margin=1.0) -> str:
    """'crit' (failing) / 'warn' (tight) / 'good' (passing) / 'none'. v = LA as a fraction (0.95)."""
    if v is None:
        return prev or "none"
    p = float(v) * 100
    raw = "good" if p > good else "warn" if p >= warn else "crit"
    if not prev or prev == "none" or prev == raw:
        return raw
    if prev == "good":
        return "good" if p > good - margin else raw
    if prev == "crit":
        return "crit" if p < warn + margin else raw
    if prev == "warn":
        if raw == "good":
            return "good" if p > good + margin else "warn"
        return "crit" if p < warn - margin else "warn"
    return raw


def parse_every(text: str):
    """'3' → (3.0, None);  '1/3/5' → (1.0, (1, 3, 5)) = minutes when failing / tight / passing."""
    t = str(text or "").strip().replace(",", "/").replace(" ", "")
    if "/" in t:
        parts = [float(x) for x in t.split("/") if x]
        if len(parts) != 3 or min(parts) <= 0:
            raise ValueError("By status: write failing/tight/passing minutes, e.g. 1/3/5")
        return min(parts), tuple(parts)
    v = float(t or 0)
    if v <= 0:
        raise ValueError("'Every' must be more than 0 minutes")
    return v, None


def every_for(every_min: float, by_status, status: str) -> float:
    if by_status:
        f, t, p = by_status
        return max(0.5, {"crit": f, "warn": t, "good": p}.get(status, t))
    return max(0.5, float(every_min))


def is_due(*, est: dict, local_min: float, start: str, stop: str, every: float, last: dict | None, now_ts: float,
           offset_min: float = 1.0, tail_min: float = 0.75) -> tuple[bool, str]:
    """last = {'at': epoch seconds, 'idx': interval, 'est_date': 'MM/DD/YYYY'} of the last good send."""
    if not in_window(local_min, start, stop):
        return False, "outside start/stop"
    in_int = est["est_min"] - est["idx"] * 30
    if in_int < offset_min:
        return False, f"waiting for :{int(offset_min):02d} of the interval"
    if in_int > 30 - tail_min:
        return False, "end of interval"
    if not last or last.get("idx") != est["idx"] or last.get("est_date") != est["est_date"]:
        return True, "first send this interval"
    mins = (now_ts - last["at"]) / 60
    if mins + 1e-6 >= every:
        return True, f"every {every:g} min"
    return False, f"next in {int((every - mins) * 60 + 0.999)}s"


def next_due_ts(*, est: dict, now_ts: float, every: float, last: dict | None, offset_min: float = 1.0, tail_min: float = 0.75) -> float:
    """Best guess of the next send time (for the 'Next' column)."""
    in_int = est["est_min"] - est["idx"] * 30
    start_of_int = now_ts - in_int * 60
    nxt_int = start_of_int + 30 * 60 + offset_min * 60
    if in_int < offset_min:
        return start_of_int + offset_min * 60
    if not last or last.get("idx") != est["idx"] or last.get("est_date") != est["est_date"]:
        return now_ts if in_int <= 30 - tail_min else nxt_int
    cand = last["at"] + every * 60
    return cand if cand <= start_of_int + (30 - tail_min) * 60 else nxt_int
