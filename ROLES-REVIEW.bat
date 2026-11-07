@echo off
chcp 65001 >nul
title FINMAN - Dib u eegista Roles (akhris keliya)
cd /d "%~dp0"
echo  Roles-ka shirkad kasta iyo ogolaanshahooda muhiimka ah (AKHRIS KELIYA - waxba lama beddelayo)...
node scripts\roles-review.js > roles-review.txt 2>&1
type roles-review.txt
echo.
echo  Natiijada waxay ku jirtaa: %~dp0roles-review.txt
pause
