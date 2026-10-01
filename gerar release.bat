@echo off
echo ========================================
echo  Gerar Release - Projeto DINF (GLPI)
echo ========================================
echo.

rem Diretorio onde este bat esta (raiz do projeto) - sem barra final
set "SOURCE=%~dp0"
set "SOURCE=%SOURCE:~0,-1%"

rem Destino: pasta "release GLPI" um nivel acima
set "DEST=%~dp0..\release GLPI"

echo Origem: %SOURCE%
echo Destino: %DEST%
echo.

rem Criar pasta de destino se nao existir
if not exist "%DEST%" (
    echo Criando pasta de destino...
    mkdir "%DEST%"
)

rem Copiar arquivos e pastas, excluindo arquivos de DEV, documentacao e
rem artefatos que nao sao necessarios para EXECUTAR o sistema no servidor:
rem
rem   .next        - cache de build (regeneravel com npm run build)
rem   node_modules  - dependencias (instalaveis via npm install no servidor)
rem   data         - banco local (dinf.db, segredos e backups): NAO vai para o release.
rem                   O servidor cria a pasta sozinho no primeiro start (lib/db.ts monta o
rem                   esquema e lib/sessao.ts gera o segredo). Em atualizacao, o robocopy
rem                   NAO apaga a pasta data que ja existe no servidor, entao o banco de
rem                   producao fica intacto.
rem   .git          - repositorio (nao necessario para rodar)
rem   .clinerules   - regras e mapa do agente Cline (nao necessarios para rodar)
rem   *.tsbuildinfo - artefato de TypeScript (regenerado pelo tsc)
rem   *.log         - arquivos de log
rem   *.bat         - utilitarios e scripts de arranque (apenas dev)
rem   .gitignore    - metadado do git (nao necessario para rodar)
rem   ARCHITECTURE.md, CONTEXTO_ATUAL.md, TASK_LOG.md - documentos de dev
rem   .clineignore, tmp_map_fix.js - arquivos do agente Cline (nao necessarios)
echo Copiando arquivos do release...
echo Excluindo: .next, node_modules, data, .git, .clinerules, *.tsbuildinfo, *.log
echo Excluindo: *.bat
echo Excluindo: ARCHITECTURE.md, CONTEXTO_ATUAL.md, TASK_LOG.md, .clineignore, tmp_map_fix.js
robocopy "%SOURCE%" "%DEST%" /E /XD .next node_modules data .git .clinerules /XF *.tsbuildinfo *.log "*.bat" ".gitignore" "ARCHITECTURE.md" "CONTEXTO_ATUAL.md" "TASK_LOG.md" ".clineignore" "tmp_map_fix.js" /R:3 /W:5

echo.
echo ========================================
echo  Release gerado com sucesso!
echo ========================================
echo.
echo Para rodar em outro PC:
echo   1. Extraia a pasta "release GLPI"
echo   2. Execute: npm install   ^(instala dependencias^)
echo   3. Execute: npm run dev    ^(ou npm run build + npm run start^)
echo.
echo IMPORTANTE - o release NAO leva a pasta data (banco local e segredos).
echo O servidor cria a pasta data sozinho no primeiro start:
echo   - data\dinf.db: nasce vazio, com o esquema das tabelas (sem tecnicos e sem agenda)
echo   - data\.segredo_sessao: segredo gerado na hora, que assina o cookie de sessao
echo Nao copie o data do PC de desenvolvimento para o servidor: o banco local de
echo tecnicos/agenda nao e o do servidor e o segredo novo invalida as sessoes antigas.
echo Copie manualmente apenas o .env.local (credenciais do GLPI: GLPI_URL, GLPI_APP_TOKEN,
echo GLPI_USER_TOKEN). O snapshot do GLPI fica FORA do projeto (GLPI_DB_PATH, por padrao
echo ..\Base_GLPI\glpi_local.db) e precisa existir no PC de destino.
echo.