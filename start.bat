@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ==============================
echo   RAG Assistant - 启动中...
echo ==============================
echo.
npm run dev
pause
