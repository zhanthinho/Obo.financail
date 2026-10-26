@echo off
chcp 65001 >nul
title FINMAN - Backup hadda
cd /d "%~dp0"
echo  Backup buuxa oo xogta FINMAN ah ayaa la samaynayaa (folder-ka Backups).
node scripts\local-tools.js backup
echo.
echo  Backups-ka waxay ku jiraan: %~dp0Backups
echo  Nuqul ka koobiyee USB si xogtu u badbaado haddii kombiyuutarku xumaado.
pause
