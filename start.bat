@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: ============================================
::   RAG Assistant - 启动脚本
:: ============================================

:: --- 读取配置 ---
set "PORT=3000"
set "TUNNEL_ID="
set "HOSTNAME="
set "TUNNEL_CONFIG=%USERPROFILE%\.cloudflared\config.yml"

if exist .env (
    for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "PORT=" .env 2^>nul`) do set "PORT=%%b"
)

set "LOCAL_URL=http://localhost:%PORT%"

:: 从 cloudflared config 解析隧道 ID 和域名
set "HAS_TUNNEL=0"
if exist "%TUNNEL_CONFIG%" (
    for /f "usebackq tokens=1,* delims=:" %%a in (`findstr /r "^tunnel:" "%TUNNEL_CONFIG%" 2^>nul`) do (
        set "_val=%%b"
        call :trim TUNNEL_ID !_val!
    )
    for /f "usebackq tokens=1,* delims=:" %%a in (`findstr "hostname:" "%TUNNEL_CONFIG%" 2^>nul`) do (
        set "_val=%%b"
        call :trim HOSTNAME !_val!
    )
    if defined TUNNEL_ID if defined HOSTNAME set "HAS_TUNNEL=1"
)

where cloudflared >nul 2>nul
if %errorlevel% neq 0 set "HAS_TUNNEL=0"

echo.
echo =============================================
echo   RAG Assistant
echo =============================================
echo.
echo   本地地址: %LOCAL_URL%
if "%HAS_TUNNEL%"=="1" (
    echo   公网地址: https://%HOSTNAME%
) else (
    echo   公网地址: (未配置隧道)
)
echo.

:: --- 检查 Node.js ---
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装
    pause
    exit /b 1
)

:: --- 启动 Web 服务 ---
echo [1/2] 启动 Web 服务...

:: 先杀掉可能残留的旧进程（端口占用时）
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING" 2^>nul') do (
    echo   端口 %PORT% 被占用 (PID: %%a)，正在释放...
    taskkill /f /pid %%a >nul 2>nul
    timeout /t 1 /nobreak >nul
)

start "RAG Server" cmd /c "title RAG Server && npm run dev"

:: --- 轮询等待服务就绪 ---
echo   等待服务就绪...
set "READY=0"
for /l %%i in (1,1,30) do (
    curl -s -o NUL "%LOCAL_URL%/api/model/status" 2>nul
    if !errorlevel! equ 0 (
        set "READY=1"
        goto :server_ready
    )
    timeout /t 2 /nobreak >nul
)
:server_ready

if "%READY%"=="0" (
    echo [警告] 服务启动超时，请手动检查
) else (
    echo   服务已就绪
)

:: --- 启动隧道 ---
if "%HAS_TUNNEL%"=="0" goto :done

echo [2/2] 启动 Cloudflare 隧道...

:: 检查旧隧道进程
tasklist /fi "imagename eq cloudflared.exe" /fo csv 2>nul | findstr /i "cloudflared" >nul
if !errorlevel! equ 0 (
    echo   检测到旧隧道进程，正在重启...
    taskkill /f /im cloudflared.exe >nul 2>nul
    timeout /t 2 /nobreak >nul
)

start "Cloudflare Tunnel" cmd /c "title Cloudflare Tunnel && cloudflared tunnel run %TUNNEL_ID%"

:: --- 轮询等待隧道连通 ---
echo   等待隧道连通...
set "TUNNEL_OK=0"
for /l %%i in (1,1,20) do (
    curl -s -o NUL "https://%HOSTNAME%/api/model/status" 2>nul
    if !errorlevel! equ 0 (
        set "TUNNEL_OK=1"
        goto :tunnel_ready
    )
    timeout /t 3 /nobreak >nul
)
:tunnel_ready

if "%TUNNEL_OK%"=="0" (
    echo [警告] 隧道连通超时，请检查 cloudflared 状态
    echo   手动检查: cloudflared tunnel info %TUNNEL_ID%
) else (
    echo   隧道已连通
)

:: --- 完成 ---
:done
echo.
echo =============================================
echo   启动完成！
echo.
echo   本地: %LOCAL_URL%
if "%HAS_TUNNEL%"=="1" echo   公网: https://%HOSTNAME%
echo =============================================
echo.

:: 自动打开浏览器
if "%HAS_TUNNEL%"=="1" (
    start "" "https://%HOSTNAME%"
) else (
    start "" "%LOCAL_URL%"
)

echo 按任意键停止服务...
pause >nul

:: --- 清理：停止所有相关进程 ---
echo.
echo 正在停止服务...
taskkill /f /im cloudflared.exe >nul 2>nul
:: 杀掉占用端口的 node 进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING" 2^>nul') do (
    taskkill /f /pid %%a >nul 2>nul
)
echo 服务已停止
goto :eof

:: --- 工具函数：去除变量值的前后空格 ---
:trim
setlocal
set "_out=%~1"
set "_str=%~2"
:trim_loop
if "%_str:~0,1%"==" " set "_str=%_str:~1%" & goto trim_loop
if "%_str:~-1%"==" " set "_str=%_str:~0,-1%" & goto trim_loop
endlocal & set "%_out%=%_str%"
goto :eof
