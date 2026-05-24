@echo off
chcp 65001 >nul
echo.
echo ==============================
echo   RAG Assistant - 停止中...
echo ==============================
echo.

set found=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    set found=1
    echo 发现进程 PID: %%a，正在结束...
    taskkill /PID %%a /F >nul 2>&1
    if errorlevel 1 (
        echo [失败] 无法结束进程 %%a，请尝试以管理员身份运行。
    ) else (
        echo [成功] 端口 3000 已释放。
    )
)

if %found% equ 0 (
    echo 端口 3000 当前没有运行中的服务。
)

echo.
echo ==============================
pause
