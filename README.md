# RTA Script Runner

## v2.0 — Live (web) tab: everything in one app, no browser extension needed
The app opens its own **RTA browser** (an Edge window with its own profile) that holds:
- the **RTA dashboard** — same tabs as the HTML: Overview, LOB View, Legacy view, Day plan, Agents & Flags, Scheduled off, Data & Setup, **⚙ Automation**;
- the **CMS web** report tabs (reads each report in memory via CMS web's "Export to Clipboard" — no files, no download prompts; logs back in by itself and reopens the reports in fresh tabs);
- one **Teams web** tab per group chat (sends the pictures by pressing the Send button, waits 20 s after each send, reloads the chat link and retries on any error).

Setup (once):
1. **Live (web)** → **Open RTA browser** → sign in to Teams in that window (it stays signed in).
2. In the dashboard → **⚙ Automation**: paste the CMS report links (`LOB: link`), save the CMS login, add the Teams chats.
3. Back in the app: **Start** the CMS web collector and the Teams web sender.
4. Optional: **Day files → dashboard** pulls LAT (every 30 min) and IEX schedules automatically with the logins saved in the Reports tab, and loads your roster file.

Keep the RTA browser open — behind other windows is fine, don't minimise it. Closing it by accident: the app reopens it and the automation resumes.
Web state + browser profile: `%LOCALAPPDATA%\RTA Runner\web`. The other tabs below work as before (CMS scripts, Teams desktop = backup, Reports).

## Older tabs
**CMS scripts** (run CMS export scripts on a timer) and **Teams desktop (backup)** (post the dashboard pictures to Teams group chats with the desktop app).

Runs your CMS export scripts (`.acsauto`, also `.bat`, `.ps1`, `.vbs`, `.exe`) on a timer.

## Use it
1. Open `RTA_Script_Runner.exe` (nothing to install).
2. **+ Add script** → `…` to pick the `.acsauto` file → set **Every (min)** (2 = every 2 minutes, 0.5 = 30 s).
3. Optional **Start at** / **Stop at** (24h `23:00` or `11:00 PM`). A stop time earlier than now means tomorrow (e.g. start 21:00, stop 04:00).
4. **Start** per row, or **Start all**. **Stop all at** + **Apply** sets the same stop time on every row.
5. **Run** = run once right now (test a script).
6. Tick **Start all jobs when the app opens** to resume automatically.

Settings and log: `%APPDATA%\RTA Runner\jobs.json` and `runner.log`.

## Behaviour
- No overlap: if the previous run is still going, the next one is skipped. A run that hangs longer than 120 s is killed.
- No bursts after sleep: if the PC slept, it runs once and continues on schedule.
- `.acsauto` runs through its Windows file association (CMS Supervisor), exactly like double-clicking it. CMS Supervisor must be open and logged in.
- Point every script's export at the folder the dashboard is connected to (e.g. `C:\RTA\CMS\TSX.txt`).

## Build the .exe (once, on any Windows PC with Python — not the work laptop)
Double-click `build_exe.bat` → the app appears in `dist\RTA_Script_Runner.exe`. Copy that one file to the work laptop.

Or with GitHub: push this folder to a repo → Actions → "Build RTA Script Runner" → download the `RTA_Script_Runner` artifact.

If Windows SmartScreen warns ("unrecognized app"): More info → Run anyway. If IT policy blocks unsigned .exe files, ask IT to allow it.

## Teams sending (v1.1)
1. In the dashboard: Data & Setup → **Picture export folder** → Connect `C:\RTA\OUT`. It writes `<LOB>_view.png`, `<LOB>_flags.png` and `manifest.json` every minute.
2. In the app: **Teams sending** tab → set the same folder → **Paste chat list** (`TSX: https://teams…/l/chat/…`, one per line).
3. Press **Send** on one row to test, then **Start all**.

Each send: waits until you stop typing for 3 s → checks the pictures and CMS data are fresh (default ≤ 10 min, else skipped) → opens the chat in the Teams desktop app → checks Teams is the front window → Alt+Shift+C (compose box) → clears any draft → pastes view + flags → Enter → returns you to your window and restores your copied text.
Pause/resume any time: **Ctrl+Alt+P** or the Pause button. Optional "Title contains" = part of the chat name, as an extra check before pasting.

## Reports tab (v1.2)
- **LAT export**: Voice (Detailed Dashboard) and/or Chat → CSV. Pick any date (default = today EST) and the save folder. Files: `LAT_Export_Voice.csv`, `LAT_Export_Chat.csv` (other dates get a date suffix).
- **IEX Agent Schedules** (EG_MU · 1000 COMCAST_EG): pick From/To dates (default today EST) and the save folder. File: `EG_MU_Agent_Schedules`.
- **Open folder** opens the save folder. Logins are stored in Windows Credential Manager. Runs headless in the installed Microsoft Edge.
