@echo off
setlocal
title DINF - Servidor de Producao
cd /d "%~dp0"

echo ==========================================================
echo   DINF - Iniciando em Modo de Producao
echo ==========================================================
echo.

rem 1. Verificar Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH do sistema.
  echo Instale a versao LTS em https://nodejs.org e tente novamente.
  echo.
  pause
  exit /b 1
)

rem 2. Verificar dependencias instaladas
if not exist "node_modules" (
  echo [1/4] Dependencias nao encontradas. Instalando...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao instalar as dependencias via npm install.
    echo.
    pause
    exit /b 1
  )
) else (
  echo [1/4] Dependencias encontradas em node_modules.
)

rem 3. Backup diario de seguranca do banco de dados
echo [2/4] Criando copia de seguranca do banco de dados em data\backups...
powershell -NoProfile -Command "$b = Join-Path 'data\backups' (Get-Date -Format 'yyyyMMdd'); if (Test-Path 'data\dinf.db') { New-Item -ItemType Directory -Force -Path $b | Out-Null; Copy-Item 'data\dinf.db' $b -Force -ErrorAction SilentlyContinue; Copy-Item 'data\dinf.db-wal' $b -Force -ErrorAction SilentlyContinue; Copy-Item 'data\dinf.db-shm' $b -Force -ErrorAction SilentlyContinue; Write-Host ('         Backup salvo em ' + $b) } else { Write-Host '         Banco ainda nao existe: backup ignorado.' }"
echo.

rem 4. Compilacao de producao (Next.js build)
echo [3/4] Compilando o projeto para producao (Next.js build)...
call npm run build
if errorlevel 1 (
  echo.
  echo [ERRO] Houve uma falha durante a compilacao do projeto.
  echo Revise os erros acima e tente novamente.
  echo.
  pause
  exit /b 1
)
echo       Compilacao concluida com sucesso!
echo.

rem 5. Execucao do servidor em modo producao
echo [4/4] Subindo o servidor de producao Next.js...
echo       Endereco: http://localhost:3000
echo       Para encerrar o servidor pressione CTRL+C nesta janela.
echo.

start /min "" powershell -NoProfile -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000'"

call npm run start

echo.
echo Servidor encerrado.
pause
endlocal
