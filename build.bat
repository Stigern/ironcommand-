@echo off
title IRON COMMAND — Build
echo.
echo  ================================================
echo   IRON COMMAND — Building executables
echo  ================================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org
    pause & exit /b 1
)

echo  [1/3] Installing dependencies...
call npm install
if %errorlevel% neq 0 ( echo  ERROR: npm install failed & pause & exit /b 1 )

echo.
echo  [2/3] Building game client (with embedded server)...
call npm run build:game
if %errorlevel% neq 0 ( echo  ERROR: game build failed & pause & exit /b 1 )

echo.
echo  [3/3] Packaging into distributable folder + zip...
if exist "dist\IronCommand-Game" rmdir /s /q "dist\IronCommand-Game"
xcopy /e /i /q "dist\game-raw\IronCommand-win32-x64" "dist\IronCommand-Game" >nul 2>&1
rmdir /s /q "dist\game-raw" >nul 2>&1

REM Create zip using PowerShell
if exist "dist\IronCommand-Game" (
    if exist "dist\IronCommand-Game.zip" del /q "dist\IronCommand-Game.zip"
    powershell -Command "Compress-Archive -Path 'dist\IronCommand-Game' -DestinationPath 'dist\IronCommand-Game.zip' -Force"
    echo  Created: dist\IronCommand-Game.zip
)

echo.
echo  ================================================
echo   Build complete! Files in dist\:
echo.
echo     IronCommand-Game\          ^<-- game folder (run .exe inside)
echo     IronCommand-Game.zip       ^<-- zipped game for sharing
echo  ================================================
echo.
echo  HOW TO PLAY:
echo    Solo:    Open IronCommand-Game\IronCommand.exe
echo             Click "PLAY SOLO vs AI"
echo.
echo    Co-op:   Step 1 - Host opens IronCommand.exe, clicks "HOST GAME"
echo                       (server starts automatically)
echo             Step 2 - Guest opens IronCommand.exe, clicks "JOIN SERVER"
echo             Step 3 - Guest enters host's IP or scans LAN
echo             Step 4 - Guest enters the 4-letter room code
echo.
pause
