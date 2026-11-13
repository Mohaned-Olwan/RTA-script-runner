"""Which browser the app drives.

Default: the Chromium that ships INSIDE the app (Playwright's own build). Company Edge policies don't apply to it —
on the work PCs Edge ignores the app's profile folder (IT forces Edge's profile location), hands every launch to the
already-open Edge and closes, so Edge can't be automated there.  RTA_BROWSER=edge → use the installed Edge instead.
"""
from __future__ import annotations

import os
import sys


def setup_env():
    """Must run before Playwright is imported: in the packaged app the browser lives inside the app folder."""
    if getattr(sys, "frozen", False):
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "0")


def launch_kwargs() -> dict:
    exe = os.environ.get("RTA_BROWSER_EXE")
    if exe:
        return {"executable_path": exe}
    if os.environ.get("RTA_BROWSER", "").lower() in ("edge", "msedge"):
        return {"channel": "msedge"}
    return {}   # bundled Chromium
