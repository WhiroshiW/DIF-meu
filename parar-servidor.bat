@echo off
setlocal
title DINF - Parar Servidor
cd /d "%~dp0"

set "PORTA=3000"
set "PID_ALVO="

echo ==========================================================
echo   DINF - Parar o Servidor (porta %PORTA%)
echo ==========================================================
echo.

rem Localiza o PID do processo que esta ESCUTANDO na porta 3000
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:"LISTENING" ^| findstr /C:":%PORTA% "') do (
  if not defined PID_ALVO set "PID_ALVO=%%p"
)

if not defined PID_ALVO (
  echo Nenhum servidor escutando na porta %PORTA%.
  echo Nada a fazer.
  echo.
  pause
  exit /b 0
)

echo Processo encontrado na porta %PORTA%:
tasklist /FI "PID eq %PID_ALVO%"
echo.

set /p CONFIRMA="Encerrar este processo e seus filhos? (S/N): "
if /i not "%CONFIRMA:~0,1%"=="S" (
  echo.
  echo Operacao cancelada pelo usuario. Nada foi encerrado.
  echo.
  pause
  exit /b 0
)

echo.
echo Encerrando...
taskkill /PID %PID_ALVO% /T /F
if errorlevel 1 (
  echo.
  echo [ERRO] Nao foi possivel encerrar o processo %PID_ALVO%.
  echo Feche a janela do servidor manualmente e tente novamente.
  echo.
  pause
  exit /b 1
)

echo.
echo ==========================================================
echo  Servidor encerrado com sucesso!
echo ==========================================================
echo.
pause
endlocal
