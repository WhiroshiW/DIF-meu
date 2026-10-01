@echo off
setlocal
title DINF - Servidor de desenvolvimento
cd /d "%~dp0"

echo ==========================================================
echo   DINF - Iniciando o projeto
echo ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH.
  echo Instale a versao LTS em https://nodejs.org e execute este arquivo novamente.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/3] Instalando dependencias - primeira execucao, pode demorar alguns minutos...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao instalar as dependencias. Verifique a conexao e tente novamente.
    echo.
    pause
    exit /b 1
  )
) else (
  echo [1/3] Dependencias encontradas em node_modules.
)

echo [2/3] Copiando backup do banco de dados para data\backups...
powershell -NoProfile -Command "$b = Join-Path 'data\backups' (Get-Date -Format 'yyyyMMdd'); if (Test-Path 'data\dinf.db') { New-Item -ItemType Directory -Force -Path $b | Out-Null; Copy-Item 'data\dinf.db' $b -Force -ErrorAction SilentlyContinue; Copy-Item 'data\dinf.db-wal' $b -Force -ErrorAction SilentlyContinue; Copy-Item 'data\dinf.db-shm' $b -Force -ErrorAction SilentlyContinue; Write-Host ('         Backup salvo em ' + $b) } else { Write-Host '         Banco ainda nao existe: backup ignorado.' }"
echo.

echo [3/3] Subindo o servidor de desenvolvimento Next.js...
echo       Endereco: http://localhost:3000
echo       Para encerrar o servidor pressione CTRL+C nesta janela.
echo.

start /min "" powershell -NoProfile -Command "Start-Sleep -Seconds 12; Start-Process 'http://localhost:3000'"

call npm run dev

echo.
echo Servidor encerrado.
pause
endlocal