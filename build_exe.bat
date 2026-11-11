@echo off
REM Builds RTA_Script_Runner.exe on ANY Windows PC that has Python 3.10+ (e.g. your personal laptop).
REM The work laptop only needs the finished .exe from the "dist" folder - nothing else.
cd /d "%~dp0"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m PyInstaller --noconfirm --onefile --windowed --name "RTA_Script_Runner" --collect-all customtkinter rta_runner.py
echo.
echo Done. Your app is in: %~dp0dist\RTA_Script_Runner.exe
pause
