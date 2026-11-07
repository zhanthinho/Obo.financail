@echo off
chcp 65001 >nul
title FINMAN - Hubinta xogta (akhris keliya)
cd /d "%~dp0"
echo  Hubinta xogta lacageed ee shirkad kasta ayaa socota (AKHRIS KELIYA - waxba lama beddelayo)...
node scripts\integrity-check.js > integrity-report.txt 2>&1
type integrity-report.txt
echo.
echo  Natiijada waxay ku jirtaa: %~dp0integrity-report.txt
pause
