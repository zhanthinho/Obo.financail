@echo off
chcp 65001 >nul
title FINMAN - MySQL (kombiyuutarkan oo keliya)
cd /d "%~dp0"
echo ============================================================
echo  FINMAN - version-ka MySQL, kombiyuutarkan (localhost)
echo  Site-ka Railway waxba lagama beddelayo.
echo ============================================================
echo.

where node >nul 2>nul || ( echo [X] Node.js lama helin. Ka rakib https://nodejs.org & pause & exit /b 1 )

echo [1/5] Database-ka MySQL ayaa la diyaarinayaa...
node scripts\local-mysql-setup.js
if errorlevel 1 ( echo. & pause & exit /b 1 )
echo.

echo [2/5] Faylasha duugga ah ee SQLite (aan la isticmaalin) ayaa la saarayaa...
if exist "src\schema.sql" del /q "src\schema.sql"
if exist "src\routes\restore.js" del /q "src\routes\restore.js"
if exist "scripts\export-db.js" del /q "scripts\export-db.js"
echo     OK
echo.

echo [3/5] Packages-ka ayaa la rakibayaa (daqiiqad)...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo [X] npm install wuu fashilmay. Qoraalka kore ii soo dir. & pause & exit /b 1 )
echo.

if exist "migration-done.txt" goto start
if not exist "data\geeska.sqlite" goto start

echo [4/5] Xogtaada SQLite (data\) waxaa loo wareejinayaa MySQL.
echo       Marka hore: TIJAABO - MySQL waxba laguma qorayo...
node scripts\migrate-sqlite-to-mysql.js --source data\geeska.sqlite --dry-run
if errorlevel 1 ( echo. & echo [X] Tijaabadu waxay heshay dhibaato. Waxba lama beddelin. Qoraalka kore ii soo dir. & pause & exit /b 1 )
echo.
choice /c HM /m "Tijaabadu waa OK. Ma la wareejiyaa xogta hadda? (H=haa, M=maya)"
if errorlevel 2 ( echo Waa la joojiyay. Waxba lama beddelin. & pause & exit /b 0 )
node scripts\migrate-sqlite-to-mysql.js --source data\geeska.sqlite --execute
if errorlevel 1 ( echo. & echo [X] Wareejintu way joogsatay. Faylasha SQLite waa sidoodii. Qoraalka kore ii soo dir. & pause & exit /b 1 )
echo done > migration-done.txt
echo.

:start
echo [5/5] System-ka ayaa la shidayaa: http://localhost:4000
echo       (Daaqaddan ha xirin inta aad isticmaalayso. Joojin: Ctrl+C)
start "" cmd /c "timeout /t 6 >nul & start http://localhost:4000"
call npm start
pause
