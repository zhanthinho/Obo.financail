@echo off
chcp 65001 >nul
title FINMAN - furitaanka
cd /d "%~dp0"
rem FINMAN (offline, kombiyuutarkan): wuxuu shidaa system-ka haddii uusan shidnayn,
rem backup toddobaadle ah ayuu sameeyaa, kadibna browser-ka ayuu furaa.

where node >nul 2>nul || ( echo [X] Node.js lama helin. Ka rakib https://nodejs.org & pause & exit /b 1 )

rem Icon Desktop-ka (hal mar)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $l=Join-Path $d 'FINMAN.lnk'; if(-not (Test-Path $l)){ $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath='%~f0'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%SystemRoot%\System32\shell32.dll,43'; $s.Description='FINMAN Financial System'; $s.Save(); Write-Host '    Icon-ka FINMAN waxaa lagu daray Desktop-ka.' }"

powershell -NoProfile -Command "try{ (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:4000/api/health) | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto open

echo [1/3] Database-ka ayaa la hubinayaa...
node scripts\local-mysql-setup.js
if errorlevel 1 ( echo. & pause & exit /b 1 )
if not exist "node_modules\mysql2" ( echo     Rakibaadda... & call npm install --no-audit --no-fund )

echo [2/3] Backup toddobaadle ah (Backups\)...
node scripts\local-tools.js backup --if-older-than 7

echo [3/3] System-ka ayaa la shidayaa...
start "FINMAN server - ha xirin" /min cmd /k "node src\server.js"
node scripts\local-tools.js wait 4000
if errorlevel 1 ( pause & exit /b 1 )

:open
echo.
echo  FINMAN wuu shaqaynayaa:
node scripts\local-tools.js urls 4000
echo.
echo  Joojin: xir daaqadda "FINMAN server - ha xirin" (taskbar-ka hoose).
start "" http://localhost:4000
timeout /t 8 >nul
