@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: Read port from .env
set PORT=3000
if exist .env (
    for /f "tokens=2 delims==" %%a in ('findstr /b "PORT=" .env 2^>nul') do set PORT=%%a
)

echo.
echo ==============================
echo   RAG Assistant - 启动中...
echo ==============================
echo.
echo 📍 服务端口: %PORT%
echo.

:: Check cloudflared
set TUNNEL_NAME=rag-tunnel
set TUNNEL_CONFIG=%USERPROFILE%\.cloudflared\config.yml
where cloudflared >nul 2>nul
if %errorlevel% neq 0 (
    echo ⚠️  未找到 cloudflared，仅启动本地服务
    echo   安装: winget install Cloudflare.cloudflared
    echo.
    start "RAG Assistant Server" cmd /c "cd /d %~dp0 && title RAG Server ^& npm run dev"
    goto :end
)

if not exist "%TUNNEL_CONFIG%" (
    echo ⚠️  隧道配置不存在: %TUNNEL_CONFIG%
    echo   仅启动本地服务
    echo.
    start "RAG Assistant Server" cmd /c "cd /d %~dp0 && title RAG Server ^& npm run dev"
    goto :end
)

echo [1/2] 启动 Web 服务...
start "RAG Assistant Server" cmd /c "cd /d %~dp0 && title RAG Server ^& npm run dev"
echo   等待服务启动...
timeout /t 5 /nobreak >nul

echo [2/2] 启动 Cloudflare 隧道...
start "Cloudflare Tunnel" cmd /c "cd /d %~dp0 && title Cloudflare Tunnel ^& cloudflared tunnel run %TUNNEL_NAME%"
echo   隧道 %TUNNEL_NAME% 已启动

echo.
echo ==============================
echo   ✅ 启动完成！
echo.
echo   本地地址: http://localhost:%PORT%
echo   公网地址: https://rag.chenkk.shop
echo ==============================
echo.
echo 💡 关闭所有窗口即可停止服务

:end
pause
