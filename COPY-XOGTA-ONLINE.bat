@echo off
chcp 65001 >nul
title FINMAN - Xogta kombiyuutarka u dir online (Aiven)
cd /d "%~dp0"
echo.
echo  Xogta MySQL-ka kombiyuutarkan waxaa loo koobiyeynayaa database ONLINE ah oo MADHAN.
echo  Xogta kombiyuutarka waxba lagama beddelayo. Online-ka haddii uu xog leeyahay, waa la joojinayaa.
echo  (ca.pem ee Aiven ku keydi folder-kan si shahaadada loo hubiyo.)
echo.
where node >nul 2>nul || ( echo [X] Node.js lama helin. & pause & exit /b 1 )
if not exist "node_modules\mysql2" ( echo Rakibaadda... & call npm install --no-audit --no-fund )
node scripts\copy-to-online.js
echo.
pause
