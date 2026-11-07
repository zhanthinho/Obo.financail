@echo off
chcp 65001 >nul
title FINMAN - Ogolaanshaha muhiimka ah: Super Admin keliya
cd /d "%~dp0"
echo  1) Backup buuxa ayaa marka hore la samaynayaa...
node scripts\local-tools.js backup --keep 1000
if errorlevel 1 (
  echo  [X] Backup-ku wuu fashilmay - waxba lama beddelin.
  pause
  exit /b 1
)
echo  2) Ogolaanshaha muhiimka ah (Delete / Reverse / Users / Roles / Settings) waxaa laga qaadayaa doorarka aan Super Admin ahayn...
node scripts\remove-critical-perms.js --confirm > roles-fix.txt 2>&1
type roles-fix.txt
echo.
node scripts\roles-review.js > roles-review.txt 2>&1
echo  Natiijada: %~dp0roles-fix.txt  iyo  %~dp0roles-review.txt
pause
