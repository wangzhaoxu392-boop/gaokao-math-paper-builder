@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo First run: installing local document dependencies...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0gui\setup.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0gui\launcher.ps1"
if errorlevel 1 pause
endlocal
