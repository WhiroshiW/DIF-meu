@echo off
echo ========================================
echo  Backup do Projeto DINF
echo ========================================
echo.

rem Diretório onde este bat está (raiz do projeto) — sem barra final
set "SOURCE=%~dp0"
set "SOURCE=%SOURCE:~0,-1%"

rem Destino: pasta DINF Backup um nível acima — já sem barra final (não remover o último caractere)
set "DEST=%~dp0..\DINF Backup"

echo Origem: %SOURCE%
echo Destino: %DEST%
echo.

rem Criar pasta de destino se não existir
if not exist "%DEST%" (
    echo Criando pasta de destino...
    mkdir "%DEST%"
)

rem Copiar arquivos e pastas, excluindo .next e node_modules
echo Iniciando cópia...
robocopy "%SOURCE%" "%DEST%" /E /XD .next node_modules /R:3 /W:5

echo.
echo ========================================
echo  Backup concluído com sucesso!
echo ========================================
echo.

pause
