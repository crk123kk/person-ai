@echo off
chcp 65001 >nul
echo.
echo ==============================
echo   RAG Assistant - 停止中...
echo ==============================

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo 发现进程 PID: %%a，正在结束...
    taskkill /PID %%a /F >nul 2>&1
    echo 端口 3000 已释放。
)

echo ==============================
pause
