#!/usr/bin/env node
/**
 * Sincronizador GLPI -> SQLite (snapshot local do projeto DINF)
 *
 * Fluxo de cada execucao:
 *   ETAPA 1 - Alteracoes: consulta a API de busca do GLPI pelos chamados cuja
 *             "Ultima atualizacao" (date_mod) e maior que o instante da ultima
 *             sincronizacao bem-sucedida (tabela sync_state) e regrava esses
 *             chamados no banco local. Se a API de busca nao estiver
 *             disponivel, cai no modo conservador: regrava todos os chamados
 *             locais que NAO estao fechados (status <> 6).
 *   ETAPA 2 - Novos: checagem CURTA (no maximo MAX_PAGINAS_NOVOS paginas) a partir do
 *             offset do maior id local, para pegar chamados cujo id ainda nao existe
 *             aqui. O catalogo NAO e percorrido por inteiro: um chamado recem-criado
 *             ja aparece na ETAPA 1 (a busca por date_mod traz os novos).
 *   ETAPA 3 - Grupos: popula a coluna `tickets.groups` (JSON com [{id, name}]
 *             dos grupos atribuidos) de TODOS os chamados pendentes ou quando o
 *             modo "sync completo de grupos" estiver ativado (chave
 *             `full_sync_groups` = '1' em `sync_state`). A fonte e o subitem
 *             `Ticket/{id}/Group_Ticket`; o nome de cada grupo e resolvido atraves
 *             do campo de busca "Grupo tecnico" (field 8) e cacheado na execucao.
 *             Chamados sem atribuicao ficam com groups = null (nao []), para nao
 *             confundir com "grupos desconhecidos".
 *   ETAPA 4 - Ligacoes do chamado (Tarefa 98): preenche QUATRO colunas da
 *             tabela `tickets` e um catalogo de pessoas. Nenhuma delas e a
 *             tabela `tecnicos` do sistema (que e a equipe do DINFO), nem o
 *             `tickets.groups`, que ja guarda o departamento atribuido.
 *
 *             Tabela nova `usuarios` (id TEXT, nome, cpf, usuario, atualizado_em):
 *             catalogo das PESSOAS, com nome, cpf e login gravados UMA vez so. Nos
 *             chamados entram apenas os `id`. E o que paga a tabela: como a
 *             sincronizacao so reescreve o chamado que MUDOU, um tecnico
 *             RENOMEADO no GLPI manteria o nome antigo em todos os chamados
 *             dele, para sempre. Com o catalogo, corrigir e um UPDATE de uma
 *             linha, e a etapa ainda revisa todos os usuarios ao fim.
 *             `cpf` e `usuario` sao MUTUAMENTE EXCLUSIVOS: o campo `name` do
 *             GLPI vem ora so numero (CPF) ora no formato nome.sobrenome (login),
 *             conforme o cadastro da pessoa nesta instituicao.
 *
 *             Colunas do chamado (JSON, no mesmo espirito do `tickets.groups`):
 *               requerente   -> "232"  (quem abriu; null se nao houver)
 *               observadores -> ["7"] (quem acompanha)
 *               tecnicos     -> ["1704","2086"] (quem foi atribuido a resolver)
 *               itens        -> [{id, itemtype, classe, nome}] (equipamentos;
 *                                `classe` em pc/monitor/outro, `nome` vem de
 *                                `Computer/{id}`, `Monitor/{id}`, `Printer/{id}`...)
 *
 *             Fontes: `Ticket/{id}/Ticket_User` para as pessoas e
 *             `Ticket/{id}/Item_Ticket` para os itens — os DOIS nomes
 *             confirmados contra o GLPI real (as formas invertidas,
 *             `User_Ticket` e `Ticket_Item`, respondem HTTP 400). Sem `tipo 2`
 *             no subitem entra o `users_id_recipient` da base, MAS so se o
 *             `User/{id}` confirmar que a pessoa existe: em chamados antigos
 *             esse campo guarda CPF em vez de id, e a confirmacao (a mesma
 *             chamada que busca o nome, ja em cache) impede o tecnico-fantasma.
 *             O nome vem de firstname+realname; o CPF e o campo `name` do GLPI.
 *             Pessoas e itens sao lidos de forma INDEPENDENTE: uma falha de um
 *             nao apaga o outro.
 *
 *             ESCOPO: TODOS os chamados que tenham responsavel (os 113.729 da
 *             base; solucionados e fechados entram tambem) — so ficam de fora os
 *             que nao tem `users_id_recipient`. A PRIMEIRA execucao varre do id
 *             1 em diante e sao ~113 mil chamados; as seguintes so pegam os
 *             alterados depois do marcador `sync_state.tecnicos_sync` (maior
 *             `date_mod` processado), gravado a cada 500 chamados para que uma
 *             varredura interrompida continue de onde parou. O marcador final so
 *             avanca se `falhas === 0`.
 *   ETAPA 5 - Motivos: valida o motivo de pendencia (`PendingReason_Item`) dos
 *             chamados com status 4 (pendente) que pertencem ao NOSSO
 *             departamento (Dpto Suporte Tecnico — mesmo criterio do dashboard).
 *             Nao esta no JSON do Ticket nem no dos followups. Se a API nao
 *             devolver motivo, a coluna `tickets.motivo_pendencia` e zerada.
 *   ETAPA 6 - Indice de busca: mantem o indice FTS5 da busca geral em dia
 *             (Tarefa 85). Se o arquivo de indice ainda nao existe, ele e montado
 *             a partir da BASE LOCAL (nada vem da API) — e assim que o servidor de
 *             producao passa a funcionar: o indice nasce na primeira sincronizacao.
 *             Se ja existe, so os chamados alterados (date_mod maior que o
 *             marcador) e os acompanhamentos novos sao reindexados. Falha aqui nao
 *             derruba a sincronizacao: a busca cai no metodo antigo por `LIKE`.
 *   ETAPA 7 - Estado: grava o instante da sincronizacao em sync_state.
 *
 * LOG DA TELA (Tarefa 109): o usuario pediu "somente o necessario". Por isso a
 * saida e apenas `Atualizando <o que>... x de y` (a cada 10) e, no fim,
 * `Concluido.` — sem faixas de `=`, sem contagens auxiliares e sem os avisos de
 * 404 de usuario/grupo/item (que nao sao falha: chamado antigo com CPF no
 * `users_id_recipient`, item sem nome). As ETAPAS 5 e 6 informam
 * `Atualizando busca...` quando fazem trabalho.
 *
 * DESEMPENHO (Tarefa 109): os subitens de um chamado saem em `Promise.all` e as
 * filas andam em blocos de `CONCORRENCIA_CHAMADOS` (3). O cursor de retomada
 * continua avancando na ORDEM DA FILA, nunca pelo chamado que respondeu
 * primeiro.
 *
 * Observacoes:
 *   - Este script e executado como processo filho pelo botao "Sincronizar" da tela
 *     GLPI (`app/api/glpi/sync/route.ts` usa child_process.spawn), para nao bloquear
 *     o servidor Next. O progresso impresso aqui e o que aparece naquela tela.
 *   - Usa `better-sqlite3` (dependencia real deste projeto). O script original
 *     usava o pacote `sqlite3`, que NAO existe no package.json.
 *   - Nenhuma credencial fica no codigo: URL e tokens vem do `.env.local` da
 *     raiz do projeto (GLPI_URL, GLPI_APP_TOKEN, GLPI_USER_TOKEN) ou de
 *     variaveis de ambiente ja definidas no processo.
 *   - Banco local (snapshot): reaproveita o `glpi_local.db` que JA existe fora do
 *     projeto, em `../Base_GLPI/glpi_local.db` (padrao), ou o caminho indicado em
 *     GLPI_DB_PATH. O script NAO grava nada em `data/`: o objetivo e continuar de
 *     onde a base ja baixada parou, sem criar uma base nova nem baixar tudo de novo.
 *   - Download de anexos continua DESATIVADO (blocos comentados), igual ao
 *     script original.
 *
 * Uso:     node scripts/sincronizar-glpi.js
 * Import:  const { GLPIExporter } = require('./scripts/sincronizar-glpi');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ====================== CONFIGURACAO ======================
const RAIZ_PROJETO = path.resolve(__dirname, '..');

carregarEnvLocal(RAIZ_PROJETO);

const GLPI_URL = process.env.GLPI_URL || '';              // ex.: https://sistemas.araucaria.pr.gov.br/apirest.php
const APP_TOKEN = process.env.GLPI_APP_TOKEN || '';
const USER_TOKEN = process.env.GLPI_USER_TOKEN || '';

const DB_PATH = process.env.GLPI_DB_PATH
  ? path.resolve(RAIZ_PROJETO, process.env.GLPI_DB_PATH)
  : path.resolve(RAIZ_PROJETO, '..', 'Base_GLPI', 'glpi_local.db');

// Usado apenas quando os anexos forem reativados
const ATTACHMENTS_DIR = path.join(RAIZ_PROJETO, 'data', 'glpi_anexos');

const PAGE_SIZE = 50;
// Sem pausa entre chamados: cada execucao processa so os alterados desde a ultima
// sincronizacao (dezenas de chamados), o que nao sobrecarrega o servidor do GLPI.
const DELAY_BETWEEN_TICKETS = 0;
const DELAY_BETWEEN_PAGES = 0;
const MAX_RETRIES = 3;
const CLOSED_STATUS = 6;              // ID do status "Fechado"
const JANELA_INICIAL_DIAS = 30;       // usada so na 1a execucao (sem ultimo_sync gravado)
const MARGEM_SEGURANCA_SEG = 300;     // recuo no filtro de alteracoes (evita perder mudancas na fronteira)
// Teto de paginas da checagem de "novos" na ETAPA 2 (1 pagina = 50 ids). A busca de
// alterados ja traz os chamados recem-criados, entao isso e apenas uma rede de
// seguranca: nunca varre o catalogo inteiro.
const MAX_PAGINAS_NOVOS = 3;

// Tarefa 109: quantos chamados andam juntos na fila da API. Cada chamado custa
// ~6 chamadas sequenciais (Ticket + 3 filhos + Ticket_User + Item_Ticket); com 1
// por vez a latencia soma. 3 simultaneos acelera sem sobrecarregar o GLPI —
// acima disso o servidor devolve 429 e o retry anula o ganho.
const CONCORRENCIA_CHAMADOS = 3;

// Tarefa 98: de quantos em quantos chamados o marcador de progresso da ETAPA 4
// e gravado. Define o retrabalho caso a varredura dos 113 mil chamados seja
// interrompida no meio (o servidor caiu, o GLPI saiu, alguem desligou a maquina).
const PASSO_MARCADOR = 500;

// Tarefa 110: de quantos em quantos chamados a tela recebe uma linha de
// progresso. Passou de 10 para **1** a pedido do usuario: ele quer ver o
// contador andar a cada chamado atualizado. A tela guarda so as ultimas 80
// linhas, entao o volume nao pesa.
const PASSO_PROGRESSO = 1;
// ==========================================================

/*
// Mapeamento de MIME types para extensoes de arquivo (Comentado com a rotina de anexos)
const MIME_EXTENSION_MAP = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'text/plain': '.txt',
  'text/csv': '.csv'
};
*/

// ==================== PARADA SOLICITADA ====================
// O botao "Parar sincronizacao" pede a parada por SIGTERM. Em vez de deixar o
// processo morrer no meio de uma escrita no SQLite, um flag e erguido e os
// lacos o verificam: o chamado atual termina, o marcador de progresso e gravado
// e a saida e limpa. Sem isso, uma parada no meio da varredura de 113 mil
// chamados deixaria o trabalho pela metade sem nenhum registro.
let interrompida = false;

function foiInterrompida() {
  return interrompida;
}

// Tarefa 109: log enxuto — a tela mostra só "Atualizando <o quê>... x de y" e
// "Concluído". Sem faixa de "=", sem contagens auxiliares, sem catálogo de
// usuários: era esse ruído que deixava a mensagem parada sem dizer se andava.
function informar(feitos, total, rotulo) {
  console.log(`Atualizando ${rotulo}... ${feitos} de ${total}`);
}

function informarEtapa(rotulo) {
  console.log(`Atualizando ${rotulo}...`);
}

function registrarParada() {
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.on(sinal, () => {
      if (interrompida) return;
      interrompida = true;
      console.log('\nParada solicitada: concluindo o chamado atual e salvando o progresso...\n');
    });
  }
}

registrarParada();

/**
 * Le pares CHAVE=VALOR de `.env.local` (e `.env` como reserva) sem sobrescrever
 * variaveis que ja existam no ambiente. Implementacao minima e propria, para o
 * script rodar com `node` puro, sem dependencia extra de dotenv.
 */
function carregarEnvLocal(raiz) {
  const arquivos = [path.join(raiz, '.env.local'), path.join(raiz, '.env')];

  for (const arquivo of arquivos) {
    if (!fs.existsSync(arquivo)) continue;

    const conteudo = fs.readFileSync(arquivo, 'utf8');

    for (const linha of conteudo.split(/\r?\n/)) {
      const texto = linha.trim();
      if (!texto || texto.startsWith('#')) continue;

      const separador = texto.indexOf('=');
      if (separador < 1) continue;

      const chave = texto.slice(0, separador).replace(/^export\s+/, '').trim();
      let valor = texto.slice(separador + 1).trim();

      if (
        (valor.startsWith('"') && valor.endsWith('"')) ||
        (valor.startsWith("'") && valor.endsWith("'"))
      ) {
        valor = valor.slice(1, -1);
      }

      if (!(chave in process.env)) process.env[chave] = valor;
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Data no formato aceito/filtrado pelo GLPI (AAAA-MM-DD HH:MM:SS, hora local do servidor). */
function formatarDataGlpi(data) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())} ` +
    `${p(data.getHours())}:${p(data.getMinutes())}:${p(data.getSeconds())}`
  );
}

function dataRecuadaDias(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
}

/** Interpreta a data no formato do GLPI (AAAA-MM-DD HH:MM:SS) como hora local. */
function parseDataGlpi(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(texto || '').trim());
  if (!m) return null;

  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])
  );
}

function validarConfiguracao() {
  const faltando = [];
  if (!GLPI_URL) faltando.push('GLPI_URL');
  if (!APP_TOKEN) faltando.push('GLPI_APP_TOKEN');
  if (!USER_TOKEN) faltando.push('GLPI_USER_TOKEN');

  if (faltando.length > 0) {
    throw new Error(
      `Credenciais do GLPI ausentes: ${faltando.join(', ')}. ` +
        'Preencha o arquivo .env.local na raiz do projeto (modelo comentado dentro dele).'
    );
  }
}

class GLPIExporter {
  constructor() {
    this.sessionToken = null;
    this.db = null;
    this.openTicketIds = new Set();
    this.idsSincronizados = new Set();  // evita processar o mesmo chamado 2x na mesma execucao
    this.opcoesBusca = null;            // cache dos IDs de campo da API de busca
    this.grupoNomeCache = Object.create(null); // cache de groups_id -> nome completo do grupo
    this.grupoFetchCount = 0;           // contador de chamados que teve grupo obtido
    this.usuarioCache = Object.create(null); // cache de users_id -> { nome, cpf, usuario } (T98)
    this.usuarioFalhou = false;         // true quando GET /User foi barrado por permissao
    this.itemCache = Object.create(null); // cache de "Computer/268" -> nome (T98)
    this.itemFalhou = false;            // true quando o nome do item nao pode ser lido
  }

  // --- BANCO DE DADOS (SQLite via better-sqlite3) ---
  initDb() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY,
        name TEXT,
        content TEXT,
        status INTEGER,
        date TEXT,
        closedate TEXT,
        solvedate TEXT,
        date_mod TEXT,
        urgency INTEGER,
        impact INTEGER,
        priority INTEGER,
        itilcategories_id INTEGER,
        type INTEGER,
        entities_id INTEGER,
        users_id_recipient INTEGER,
        raw_json TEXT,
        updated_at TEXT,
        motivo_pendencia TEXT,
        groups TEXT
      );

      CREATE TABLE IF NOT EXISTS followups (
        id INTEGER PRIMARY KEY,
        tickets_id INTEGER,
        content TEXT,
        date TEXT,
        users_id INTEGER,
        is_private INTEGER,
        raw_json TEXT,
        visto INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (tickets_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS solutions (
        id INTEGER PRIMARY KEY,
        tickets_id INTEGER,
        content TEXT,
        date TEXT,
        users_id INTEGER,
        status INTEGER,
        raw_json TEXT,
        FOREIGN KEY (tickets_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        tickets_id INTEGER,
        content TEXT,
        date TEXT,
        users_id INTEGER,
        actiontime INTEGER,
        state INTEGER,
        raw_json TEXT,
        FOREIGN KEY (tickets_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY,
        tickets_id INTEGER,
        documents_id INTEGER,
        filename TEXT,
        local_path TEXT,
        mime TEXT,
        filesize INTEGER,
        date_creation TEXT,
        raw_json TEXT,
        FOREIGN KEY (tickets_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL,
        atualizado_em TEXT NOT NULL
      );

      -- Catalogo de PESSOAS do GLPI (Tarefa 98). O nome e o CPF ficam aqui, uma
      -- vez so; nos chamados entram apenas os "id". Isso existe por um motivo
      -- concreto: como a sincronizacao so reescreve o chamado que MUDOU, um
      -- tecnico renomeado no GLPI manteria o nome antigo em todos os chamados
      -- dele, para sempre. Com o catalogo, corrigir e um UPDATE de uma linha, e
      -- a etapa pode ainda revisar todos os usuarios a cada execucao.
      -- "id" e TEXT porque o GLPI devolve identificadores de formatos diferentes.
      CREATE TABLE IF NOT EXISTS usuarios (
        id TEXT PRIMARY KEY,
        nome TEXT,
        cpf TEXT,
        usuario TEXT,
        atualizado_em TEXT
      );

    `);

    // `usuarios` pode ter sido criada numa versao anterior, sem a coluna `usuario`.
    this.garantirColuna('usuarios', 'usuario', 'TEXT');

    // Ligacoes do chamado (Tarefa 98). Cada coluna e um JSON, no mesmo espirito
    // do `tickets.groups`, para nao espalhar tabelas. Guardam SO o `id` da
    // pessoa; o nome e o CPF ficam na tabela `usuarios` acima.
    // Nenhuma delas e a tabela `tecnicos` do sistema (que e a equipe do DINFO),
    // nem o `tickets.groups`, que ja guarda o departamento atribuido.
    //   requerente  -> quem abriu      (1 id, ou null)
    //   observadores-> quem acompanha   (array de ids)
    //   tecnicos    -> quem foi escalado para resolver (array de ids, "tipo 2")
    //   itens       -> o que foi atribuido ao chamado (array, classe pc/monitor/outro)
    this.garantirColuna('tickets', 'requerente', 'TEXT');
    this.garantirColuna('tickets', 'observadores', 'TEXT');
    this.garantirColuna('tickets', 'tecnicos', 'TEXT');
    this.garantirColuna('tickets', 'itens', 'TEXT');

    // Bases geradas pelo script antigo (sem date_mod) precisam da coluna nova.
    // ATENCAO: tem de vir ANTES dos indices, pois `idx_tickets_date_mod` usa essa
    // coluna — em base antiga o CREATE INDEX falhava com "no such column: date_mod".
    this.garantirColuna('tickets', 'date_mod', 'TEXT');

    // Coluna de motivo de pendencia (apenas para status 4 = Pendente).
    // Extraida do conteudo do ultimo followup; nao e gravada para status outros.
    this.garantirColuna('tickets', 'motivo_pendencia', 'TEXT');

    // Coluna de grupos atribuidos (atualizada pelo sync e usada pelo dashboard
    // para filtrar chamados por departamento / subgrupo, ex.:
    // "Superintendência de TI > Dpto Suporte Técnico > Manutenção").
    this.garantirColuna('tickets', 'groups', 'TEXT');

    // Acompanhamento visto (Tarefa 35): 1 = visto, 0 = novo nao lido.
    // Em base ja existente o ALTER preenche as linhas atuais com o DEFAULT 1;
    // o INSERT de followup novo em reconciliarFilhos() grava 0 explicito.
    this.garantirColuna('followups', 'visto', 'INTEGER NOT NULL DEFAULT 1');

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_date_mod ON tickets(date_mod);
      CREATE INDEX IF NOT EXISTS idx_followups_ticket ON followups(tickets_id);
      CREATE INDEX IF NOT EXISTS idx_solutions_ticket ON solutions(tickets_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_ticket ON tasks(tickets_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(tickets_id);
    `);
  }

  /** Adiciona a coluna em bases ja existentes (ALTER TABLE e idempotente aqui). */
  garantirColuna(tabela, coluna, tipo) {
    const colunas = this.db.prepare(`PRAGMA table_info(${tabela})`).all();
    if (!colunas.some((c) => c.name === coluna)) {
      this.db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
    }
  }

  /** Consolida o WAL no arquivo principal e fecha a conexao (banco autocontido). */
  fecharBanco() {
    if (!this.db) return;

    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      // checkpoint e apenas otimizacao — nao interrompe o encerramento
    }

    this.db.close();
    this.db = null;
  }

  // --- REQUISICOES HTTP COM RETRY ---
  async request(endpoint, options = {}) {
    const url = `${GLPI_URL}/${endpoint.replace(/^\//, '')}`;
    const headers = {
      'Content-Type': 'application/json',
      'App-Token': APP_TOKEN,
      ...(this.sessionToken ? { 'Session-Token': this.sessionToken } : {}),
      ...(options.headers || {})
    };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, { ...options, headers });

        if ([429, 502, 503].includes(response.status)) {
          const wait = 1000 * Math.pow(2, attempt);
          console.log(`    [Aviso] Servidor ocupado (${response.status}). Aguardando ${(wait / 1000).toFixed(1)}s...`);
          await sleep(wait);
          continue;
        }

        if (!response.ok) {
          const erro = new Error(`HTTP ${response.status}: ${response.statusText}`);
          // 400/404 nao melhoram com nova tentativa: falha imediatamente. Ex.: pedir
          // uma pagina alem do total do catalogo faz o GLPI responder 400 (nao lista vazia).
          if (response.status === 400 || response.status === 404) erro.semRetentativa = true;
          throw erro;
        }

        return response;
      } catch (err) {
        if (err.semRetentativa || attempt === MAX_RETRIES) throw err;
        const wait = 1000 * attempt;
        console.log(`    [Aviso] Erro: ${err.message}. Tentativa ${attempt}/${MAX_RETRIES}. Aguardando ${(wait / 1000).toFixed(1)}s...`);
        await sleep(wait);
      }
    }

    throw new Error('Falha apos multiplas tentativas.');
  }

  // --- AUTENTICACAO E SESSAO ---
  async login() {
    const res = await this.request('initSession', {
      headers: { Authorization: `user_token ${USER_TOKEN}` }
    });
    const data = await res.json();
    this.sessionToken = data.session_token;

    try {
      await this.request('changeActiveEntities', {
        method: 'POST',
        body: JSON.stringify({ entities_id: 'all', is_recursive: true })
      });
    } catch (e) {
      // Entidade 'all' indisponivel: segue com a entidade padrao da sessao.
    }
  }

  async killSession() {
    if (this.sessionToken) {
      try {
        await this.request('killSession');
      } catch (e) {
        // encerramento de sessao e best-effort
      }
    }
  }

  // --- CONSULTAS NA API DO GLPI ---
  /**
   * IDs de uma pagina do catalogo. Quando o offset passa do total de chamados o
   * GLPI responde HTTP 400 (Bad Request) em vez de lista vazia — tratamos isso
   * como "acabou o catalogo" e devolvemos [], para a paginacao encerrar normalmente.
   */
  async getTicketIdsPage(start) {
    const range = `${start}-${start + PAGE_SIZE - 1}`;
    let res;

    try {
      res = await this.request(`Ticket?range=${range}&only_id=true`);
    } catch (e) {
      if (/HTTP 400/.test(e.message)) return [];
      throw e;
    }

    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) return [];
    return data.map((item) => (typeof item === 'object' ? item.id : parseInt(item, 10)));
  }

  async getTicketFull(id) {
    const res = await this.request(`Ticket/${id}?expand_dropdowns=true`);
    return await res.json();
  }

  async getSubItems(id, subitem) {
    // Busca ESTRITA (Tarefa 34): falha de rede, JSON invalido ou resposta que
    // nao seja lista propaga erro. Devolver [] em erro faria a reconciliacao de
    // filhos apagar os locais como se tivessem sido removidos no GLPI. [] ou
    // null = GLPI confirmou que nao ha filhos (ai sim ha exclusao legitima).
    const res = await this.request(`Ticket/${id}/${subitem}`);
    const data = await res.json();
    if (data == null) return [];
    if (!Array.isArray(data)) {
      throw new Error(`Resposta inesperada de Ticket/${id}/${subitem}: nao e lista.`);
    }
    return data;
  }

  /**
   * Grupos atribuidos ao chamado (Ticket/{id}/Group_Ticket).
   * Resolve o nome completo de cada grupo (cache local) e retorna
   * [{ id, name }], onde `name` is the full hierarchy like
   * "Superintendência de TI > Dpto Suporte Técnico > Manutenção".
   *
   * None of the GLPI API methods that return group names (GET /Group/{id},
   * search/Group) are available to this API user (ERROR_RIGHT_MISSING), so the
   * group name is obtained by querying the Ticket "Grupo técnico" search field
   * (field 8) for tickets already assigned to that group — the search response
   * includes the full completename. This is only done once per group_id and
   * cached for the rest of the execution.
   */
  async fetchTicketGroups(id) {
    const items = await this.getSubItems(id, 'Group_Ticket');
    if (items.length === 0) return [];

    const uniqueGroupIds = [...new Set(items.map((it) => it.groups_id).filter((g) => Number.isFinite(Number(g))))];

    const groups = [];
    for (const gid of uniqueGroupIds) {
      let nome = this.grupoNomeCache[gid];
      if (nome === undefined) {
        nome = await this.resolverNomeGrupo(gid);
        this.grupoNomeCache[gid] = nome;
      }
      if (nome) {
        groups.push({ id: gid, name: nome });
      }
    }

    if (groups.length > 0) {
      this.grupoFetchCount += 1;
    }

    return groups.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  }

  // ==================== TECNICOS ATRIBUIDOS (Tarefa 98) ====================
  //
  // Guarda, em `tecnicos_atribuidos`, QUEM esta atribuido a cada chamado. Ate aqui
  // o sistema so tinha `tickets.users_id_recipient`, que e um identificador cru:
  // o nome do tecnico nunca era trazido do GLPI, e por isso a busca por "lanconi"
  // (nome de tecnico) nao achava o chamado 10245.
  //
  // A fonte da atribuicao e o subitem `Ticket/{id}/User_Ticket` (o mesmo padrao
  // usado pelos grupos). O NOME exige uma segunda consulta, `User/{id}`, que fica
  // em cache por execucao: sao poucos tecnicos para muitos chamados.

  /**
   * Resolve nome, cpf e usuario de uma pessoa do GLPI (cache por execucao).
   *
   * Devolve `{ nome, cpf, usuario, existe }`:
   *   nome    -> "Vagner Eduardo Tavares" (firstname + realname)
   *   cpf     -> "00000000000"  — quando o campo `name` do GLPI e so numero
   *   usuario -> "amauri.chaves" — quando o `name` vem no formato nome.sobrenome
   *   existe  -> false quando o GLPI nao devolveu essa pessoa. E o que separa
   *              um login real de um valor lixo gravado em `users_id_recipient`.
   *
   * `cpf` e `usuario` sao MUTUAMENTE EXCLUSIVOS: o mesmo campo `name` do GLPI
   * aparece ora como numero, ora como login, conforme o cadastro da pessoa
   * nesta instituicao (medido na base local: um CPF e um `nome.sobrenome`).
   * Os exemplos aqui sao ficticios: o repositorio e publico.
   *
   * Erro de rede/permissao NAO estoura: devolve `existe: false` e avisa uma
   * unica vez. O id continua sendo gravado, so os dados ficam vazios.
   */
  async resolverUsuario(usersId) {
    if (this.usuarioCache[usersId] !== undefined) return this.usuarioCache[usersId];

    let resposta = { nome: null, cpf: null, usuario: null, existe: false };

    try {
      const res = await this.request(`User/${encodeURIComponent(usersId)}`);
      const dados = await res.json();

      if (dados && typeof dados === 'object' && !Array.isArray(dados)) {
        // IMPORTANTE (medido no GLPI real): o campo `name` NAO e o nome da
        // pessoa nesta instalacao — vem o login/CPF (ex.: um `User/{id}`
        // devolve `name` com so digitos). O nome de verdade esta em
        // firstname+realname (ex.: "Vagner" + "Eduardo Tavares").
        const nomeProprio = [dados.firstname, dados.realname].filter(Boolean).join(' ').trim();
        const name = dados.name ? String(dados.name) : null;

        resposta = {
          nome: nomeProprio || null,
          cpf: name && /^\d+$/.test(name) ? name : null,
          usuario: name && !/^\d+$/.test(name) ? name : null,
          existe: true,
        };
      }
    } catch (e) {
      if (!this.usuarioFalhou) {
        this.usuarioFalhou = true;
        // Tarefa 109: silencioso na tela — chamado antigo com CPF em
        // `users_id_recipient` dá 404 e é ignorado (não conta como falha).
      }
    }

    this.usuarioCache[usersId] = resposta;
    return resposta;
  }

  /**
   * Upsert no catalogo `usuarios`: so escreve quando algo mudou, para que
   * `atualizado_em` signifique "ultima mudanca real" da pessoa.
   * Retorna true se a linha foi mexida.
   */
  gravarUsuario(id, nome, cpf, usuario) {
    const atual = this.db.prepare('SELECT nome, cpf, usuario FROM usuarios WHERE id = ?').get(id);

    if (atual) {
      const mudou =
        this.valorDiferente(atual.nome, nome) ||
        this.valorDiferente(atual.cpf, cpf) ||
        this.valorDiferente(atual.usuario, usuario);
      if (!mudou) return false;

      this.db
        .prepare('UPDATE usuarios SET nome = ?, cpf = ?, usuario = ?, atualizado_em = ? WHERE id = ?')
        .run(nome, cpf, usuario, new Date().toISOString(), id);
      return true;
    }

    this.db
      .prepare('INSERT INTO usuarios (id, nome, cpf, usuario, atualizado_em) VALUES (?, ?, ?, ?, ?)')
      .run(id, nome, cpf, usuario, new Date().toISOString());
    return true;
  }

  /**
   * Revisa TODOS os usuarios ja catalogados. E o que paga a tabela: como a
   * sincronizacao so reescreve o chamado que mudou, um tecnico renomeado no
   * GLPI jamais voltaria a aparecer. Aqui ele volta — sao algumas centenas de
   * pessoas (e nao 113 mil chamados), entao o custo e pequeno, e o cache por
   * execucao evita repetir quem ja foi consultado na varredura.
   */
  async atualizarUsuariosConhecidos() {
    const ids = this.db.prepare('SELECT id FROM usuarios ORDER BY id').all().map((r) => r.id);
    if (ids.length === 0) {
      return 0;
    }

    let corrigidos = 0;
    for (const id of ids) {
      const pessoa = await this.resolverUsuario(id);
      if (pessoa.existe && this.gravarUsuario(id, pessoa.nome, pessoa.cpf, pessoa.usuario)) {
        corrigidos += 1;
      }
    }

    return corrigidos;
  }

  /**
   * Pessoas ligadas ao chamado, via `Ticket/{id}/Ticket_User`.
   *
   * Devolve [{ id, tipo, nome, cpf, existe }]. O nome e o CPF vao para a tabela
   * `usuarios` (uma vez so); no chamado grava-se apenas o `id`. Um chamado pode
   * ter VARIOS: junta as associacoes do subitem com o `users_id_recipient`.
   *
   * A leitura e ESTRITA (mesma regra de `getSubItems`): erro de rede propaga, para
   * que uma falha momentanea nunca seja lida como "o chamado ficou sem tecnico" e
   * apague o que estava gravado.
   */
  async fetchTicketTecnicos(id, usersIdReserva) {
    // Nome do subitem CONFIRMADO contra o GLPI real: e `Ticket_User`, e nao
    // `User_Ticket`. As tres formas invertidas (`User_Ticket`, `UserTicket`,
    // `Users`) respondem HTTP 400; `Ticket/{id}/Ticket_User` responde 200.
    const itens = await this.getSubItems(id, 'Ticket_User');

    // type: 1 = solicitante (quem abriu), 2 = atribuido, 3 = observador.
    const porUsuario = new Map();
    for (const item of itens) {
      const uid = item && item.users_id != null ? String(item.users_id) : null;
      if (!uid) continue;
      if (!porUsuario.has(uid)) porUsuario.set(uid, { id: uid, tipo: item.type ?? null });
    }

    // O subitem traz as ASSOCIACOES (inclui o solicitante, type 1), mas pode
    // nao trazer o atribuido. Medido no chamado 1: o subitem devolveu SO o
    // type 1. Entao: se o subitem JA trouxe alguem com type 2 (atribuido), ele
    // manda e o `users_id_recipient` e ignorado — caso contrario entraria um
    // tecnico-fantasma quando os dois divergissem (o subitem e a fonte da
    // verdade; o campo da base pode estar defasado).
    //
    // Sem type 2 no subitem, entra o `users_id_recipient` — que em GLPI e o
    // campo "Atribuido a". MAS so se ele for uma pessoa de verdade: em chamados
    // antigos esse campo guarda CPF em vez de id (ex.: "5298076963"), e o GLPI
    // responde 404. A confirmacao e a mesma chamada `User/{id}` que ja era feita
    // para buscar o nome, entao custa nada (o cache por execucao cobre as repeticoes).
    const temAtribuidoNoSubitem = [...porUsuario.values()].some((u) => u.tipo === 2);
    if (
      !temAtribuidoNoSubitem &&
      usersIdReserva != null &&
      String(usersIdReserva) !== ''
    ) {
      const reserva = String(usersIdReserva);
      const pessoa = await this.resolverUsuario(reserva);
      if (pessoa.existe && !porUsuario.has(reserva)) {
        porUsuario.set(reserva, { id: reserva, tipo: 2 });
      }
    }

    const saida = [];
    const pendentes = [];
    for (const bruto of porUsuario.values()) {
      const emCache = this.usuarioCache[bruto.id];
      if (emCache !== undefined) {
        saida.push({
          id: bruto.id,
          tipo: bruto.tipo,
          nome: emCache.nome,
          cpf: emCache.cpf,
          usuario: emCache.usuario,
          existe: emCache.existe,
        });
      } else {
        pendentes.push(bruto);
      }
    }

    // Tarefa 109: usuários novos do bloco saem juntos — eram N chamadas
    // sequenciais por chamado (uma por pessoa), agora é 1 rodada paralela.
    const resolvidos = await Promise.all(pendentes.map((bruto) => this.resolverUsuario(bruto.id)));
    for (let i = 0; i < pendentes.length; i += 1) {
      const bruto = pendentes[i];
      const usuario = resolvidos[i];
      saida.push({
        id: bruto.id,
        tipo: bruto.tipo,
        nome: usuario.nome,
        cpf: usuario.cpf,
        usuario: usuario.usuario,
        existe: usuario.existe,
      });
    }

    return saida.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  /**
   * Nome de um equipamento (Computer/{id}, Monitor/{id}, Peripheral/{id}...).
   * O `itemtype` da resposta do subitem ja diz qual endpoint usar.
   *
   * O CACHE e essencial: o mesmo equipamento aparece em centenas de chamados, e
   * sem ele seriam centenas de chamadas a mais por execucao. Como sao poucos
   * equipamentos distintos, o custo real fica proximo do numero de maquinas.
   *
   * Falha aqui (sem permissao, item apagado) nao derruba nada: o item continua
   * gravado, so sem o nome.
   */
  async resolverItem(itemtype, itemId) {
    const chave = `${itemtype}/${itemId}`;
    if (this.itemCache[chave] !== undefined) return this.itemCache[chave];

    let nome = null;

    try {
      // `itemtype` vem da API: codificado para nunca virar parte do caminho.
      const res = await this.request(
        `${encodeURIComponent(itemtype)}/${encodeURIComponent(itemId)}`
      );
      const dados = await res.json();
      if (dados && typeof dados === 'object' && !Array.isArray(dados) && dados.name) {
        nome = String(dados.name);
      }
    } catch (e) {
      if (!this.itemFalhou) {
        this.itemFalhou = true;
        // Tarefa 109: silencioso na tela — o item segue gravado, só sem o nome.
      }
    }

    this.itemCache[chave] = nome;
    return nome;
  }

  /**
   * Itens (equipamentos) ligados ao chamado, via `Ticket/{id}/Item_Ticket`.
   *
   * Nome confirmado contra o GLPI real: `Item_Ticket` (NAO `Ticket_Item`, que
   * devolve 400 — ao contrario de `Ticket_User`, aqui o GLPI nomeia pelo item).
   * Pode vir nenhum, um ou varios. A resposta ja traz o `itemtype` pronto
   * (ex.: "Computer", "Monitor"), entao nao ha tabela de tipos para consultar.
   * O id do equipamento vem em `items_id` (Peripheral) OU em `itemid`
   * (Computer/Monitor) — os dois sao aceitos.
   *
   * `classe` reduz o tipo a tres grupos, que e o que interessa aqui:
   * "pc" (Computer), "monitor" (Monitor) e "outro" para todo o resto
   * (Impressora, Periferico, Telefone, Software, Equipamento de rede...).
   */
  async fetchTicketItens(id) {
    const itens = await this.getSubItems(id, 'Item_Ticket');
    const CLASSES = { computer: 'pc', monitor: 'monitor' };

    const saida = [];
    const pendentes = [];
    for (const item of itens) {
      if (!item) continue;

      // O GLPI nao usa o mesmo nome de campo para todos os tipos: num
      // equipamento vem `items_id`, em computador/monitor vem `itemid`
      // (medido: Ticket/2/Item_Ticket -> {id, itemtype, itemid, tickets_id}).
      // Aceitar os dois evita perder o item inteiro por um detalhe de nome.
      const idBruto = item.items_id ?? item.itemid ?? item.id;
      const itemtype = item.itemtype || item.type || null;
      const classe = itemtype ? CLASSES[String(itemtype).toLowerCase()] || 'outro' : 'outro';
      const itemId = idBruto != null ? String(idBruto) : null;

      // O nome do equipamento vem do endpoint do proprio tipo. Sem `itemtype` ou
      // sem `id` nao ha o que consultar — o item e gravado assim mesmo.
      // Tarefa 109: nomes fora do cache saem juntos (Promise.all) — antes era
      // 1 chamada sequencial por item do chamado.
      const chave = itemtype && itemId ? `${itemtype}/${itemId}` : null;
      const emCache = chave ? this.itemCache[chave] : undefined;
      if (chave && emCache === undefined) {
        pendentes.push({ itemtype, itemId, chave });
      }

      saida.push({ id: itemId, itemtype: itemtype ? String(itemtype) : null, classe, nome: emCache ?? null, chave });
    }

    const resolvidos = await Promise.all(pendentes.map((p) => this.resolverItem(p.itemtype, p.itemId)));
    const nomes = new Map(pendentes.map((p, i) => [p.chave, resolvidos[i]]));
    for (const linha of saida) {
      if (linha.chave && nomes.has(linha.chave)) linha.nome = nomes.get(linha.chave);
      delete linha.chave;
    }

    return saida.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  }

  /**
   * Grava as colunas de ligacao do chamado. Cada uma e um JSON, e em todas
   * entra SO o `id` da pessoa — o nome e o CPF vao para a tabela `usuarios`:
   *
   *   requerente    -> "232"  (ou null)
   *   observadores  -> ["232", "7"]
   *   tecnicos      -> ["1704", "2086"]
   *   itens         -> [{id, itemtype, classe}]
   *
   * `pessoas` ou `itens` vindo `null` significa que aquela leitura FALHOU: as
   * colunas dela nao sao tocadas, e o que ja estiver gravado sobrevive. E assim
   * que uma falha de `Ticket_User` nao apaga o item, nem o contrario.
   *
   * So escreve as colunas que realmente mudaram: um chamado estavel nao gera
   * escrita nenhuma.
   */
  gravarLigacoesDoChamado(ticketsId, pessoas, itens) {
    const alvos = [];

    if (pessoas !== null) {
      const requerente = pessoas.find((p) => p.tipo === 1) || null;
      alvos.push(['requerente', requerente ? requerente.id : null]);
      alvos.push([
        'observadores',
        pessoas.filter((p) => p.tipo === 3).map((p) => p.id),
      ]);
      alvos.push([
        'tecnicos',
        pessoas.filter((p) => p.tipo === 2).map((p) => p.id),
      ]);
    }
    if (itens !== null) alvos.push(['itens', itens]);

    if (alvos.length === 0) return [];

    const atual = this.db
      .prepare(`SELECT requerente, observadores, tecnicos, itens FROM tickets WHERE id = ?`)
      .get(ticketsId);

    const mudou = [];
    const escrita = this.db.transaction(() => {
      for (const [coluna, valor] of alvos) {
        const ehLista = Array.isArray(valor);
        const novoValor =
          valor === null || valor === '' || (ehLista && valor.length === 0)
            ? null
            : JSON.stringify(valor);
        const valorAtual = atual && atual[coluna] ? atual[coluna] : null;
        if (valorAtual === novoValor) continue;

        this.db.prepare(`UPDATE tickets SET ${coluna} = ? WHERE id = ?`).run(novoValor, ticketsId);
        mudou.push(coluna);
      }
    });

    escrita();
    return mudou;
  }

  /**
   * Cataloga as pessoas do chamado na tabela `usuarios`. So grava quem o GLPI
   * confirmou existir — assim o CPF que aparece por engano em
   * `users_id_recipient` de chamados antigos nunca vira uma linha do catalogo.
   */
  catalogarUsuarios(pessoas) {
    if (!pessoas) return 0;
    let gravados = 0;
    for (const pessoa of pessoas) {
      if (!pessoa.existe) continue;
      if (this.gravarUsuario(pessoa.id, pessoa.nome, pessoa.cpf, pessoa.usuario)) gravados += 1;
    }
    return gravados;
  }

  // ---------- ETAPA 4: tecnicos atribuidos (Tarefa 98) ----------

  /** Le/escreve o marcador do date_mod processado por essa etapa. */
  lerMarcadorTecnicos() {
    const linha = this.db.prepare("SELECT valor FROM sync_state WHERE chave = 'tecnicos_sync'").get();
    return linha ? linha.valor : null;
  }

  /**
   * Maior id de chamado CONCLUIDO no preenchimento inicial (T98). E este, e nao
   * uma data, que marca a retomada: a varredura inicial anda por id, e um
   * chamado de id 5 (criado em 2020, mexido hoje) tem data de hoje — usar a
   * data aqui fazia o marco andar para tras e a retomada recomecar.
   * `null` = preenchimento ainda nao comecou, ou ja terminou.
   */
  lerMarcadorTecnicosId() {
    const linha = this.db
      .prepare("SELECT valor FROM sync_state WHERE chave = 'tecnicos_sync_id'")
      .get();
    return linha ? Number(linha.valor) : null;
  }

  gravarMarcadorTecnicosId(id) {
    this.db
      .prepare(
        `INSERT INTO sync_state (chave, valor, atualizado_em) VALUES ('tecnicos_sync_id', ?, ?)
         ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`
      )
      .run(String(id), new Date().toISOString());
  }

  gravarMarcadorTecnicos(valor) {
    this.db
      .prepare(
        `INSERT INTO sync_state (chave, valor, atualizado_em) VALUES ('tecnicos_sync', ?, ?)
         ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`
      )
      .run(valor, new Date().toISOString());
  }

  /**
   * Cursor do INCREMENTAL: id do ultimo chamado concluido, que faz par com
   * `tecnicos_sync` (a data dele). Os dois juntos sao a posicao exata na
   * ordenacao por (date_mod, id) — sem o id, uma parada devolveria a fila toda.
   */
  lerCursorIncremental() {
    const linha = this.db
      .prepare("SELECT valor FROM sync_state WHERE chave = 'tecnicos_sync_pos'")
      .get();
    return linha ? Number(linha.valor) : null;
  }

  /** Grava o par (data, id) do ultimo chamado concluido do incremental. */
  gravarCursorIncremental(data, id) {
    const gravar = (chave, valor) =>
      this.db
        .prepare(
          `INSERT INTO sync_state (chave, valor, atualizado_em) VALUES (?, ?, ?)
           ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`
        )
        .run(chave, String(valor), new Date().toISOString());

    gravar('tecnicos_sync', data);
    gravar('tecnicos_sync_pos', id);
  }

  /**
   * ETAPA 4 - tecnicos atribuidos (Tarefa 98).
   *
   * ALCANCE: TODOS os chamados que tenham responsavel — os 113.509 da base, e
   * nao so os abertos (ampliado por decisao do usuario depois de a 1a versao
   * ficar so nos 252 abertos). Nao ha corte de status: chamados solucionados (5)
   * e fechados (6) tambem entram. So ficam de fora os chamados sem
   * `users_id_recipient`, que nao teriam o que gravar.
   *
   * ATENCAO AO VOLUME: sao ~113 mil chamadas de API na 1a execucao. Como o
   * marcador e gravado a cada `PASSO_MARCADOR` chamados, uma varredura
   * interrompida (servidor parado, GLPI fora) continua de onde parou em vez de
   * recomecar do id 1 — da para rodar em etapas sem medo de perder trabalho.
   *
   * Primeira execucao: varre do id 1 em diante. Execucoes seguintes: so os
   * chamados alterados depois do marcador (`sync_state.tecnicos_sync`, que guarda
   * o maior `date_mod` ja processado), ou seja, os que mudaram e os novos. O
   * filtro usa `date_mod` da base local, que NUNCA esta desatualizado em relacao
   * ao GLPI, entao a selecao nao custa API.
   *
   * Para forcar a varredura completa de novo, grave `full_sync_tecnicos = '1'` em
   * `sync_state` (a flag e removida ao final, como em `full_sync_groups`).
   */
  async sincronizarTecnicosAtribuidos() {
    // Filtro comum aos dois modos: chamado com responsavel conhecido (sem
    // responsavel nao haveria o que gravar). NAO ha corte de status: a T98 foi
    // ampliada para TODOS os chamados por decisao do usuario.
    const WHERE_COM_RESPONSAVEL = "users_id_recipient IS NOT NULL AND users_id_recipient <> ''";

    const forcar = this.db
      .prepare("SELECT valor FROM sync_state WHERE chave = 'full_sync_tecnicos'")
      .get();
    const forcado = Boolean(forcar && forcar.valor === '1');

    // A flag e CONSUMIDA AQUI, no comeco da execucao — e nao no fim. Se ela
    // ficasse de pe durante uma varredura interrompida, a proxima execucao a
    // leria de novo e comecaria do id 1, jogando fora todo o progresso. E o
    // que o usuario viu: parou nos 2 mil, voltou, e a tela annunciou 113 mil.
    if (forcado) this.db.prepare("DELETE FROM sync_state WHERE chave = 'full_sync_tecnicos'").run();

    // DOIS marcadores, porque sao dois criterios diferentes:
    //
    //   `tecnicos_sync_id` -> maior id CONCLUIDO. Marca o preenchimento inicial,
    //     que anda por id. E exato: nao pula nem repete chamado algum.
    //   `tecnicos_sync`    -> maior date_mod processado. Vale so DEPOIS que o
    //     preenchimento terminou, para a execucao diaria pegar o que mudou.
    //
    // A versao anterior usava uma data para os dois casos, e isso nao funciona:
    // durante o preenchimento os ids andam em ordem de criacao e as datas nao
    // accompanyam (um chamado de 2020 mexido hoje tem data de hoje). O marco
    // ficava congelado e a retomada voltava quase do comeco.
    const marcadorId = this.lerMarcadorTecnicosId();
    const marcadorData = this.lerMarcadorTecnicos();
    const cursorPos = this.lerCursorIncremental();

    // "Preenchendo" = ainda estamos na varredura inicial (que anda por id).
    const preenchendo = forcado || marcadorId !== null || marcadorData === null;
    const maxId = this.db.prepare('SELECT MAX(id) AS m FROM tickets').get().m || 0;

    // `dataChave` ordena os NULLs como '' (primeiros), para que a chave de
    // ordenacao seja sempre um texto e o cursor possa ser comparado com `>`.
    const dataChave = "COALESCE(tickets.date_mod, '')";

    let chamadas;
    if (forcado || (marcadorId === null && marcadorData === null)) {
      // Primeira vez (ou flag): do id 1 em diante.
      chamadas = this.db
        .prepare(
          `SELECT id, users_id_recipient, ${dataChave} AS data
             FROM tickets WHERE ${WHERE_COM_RESPONSAVEL} ORDER BY id`
        )
        .all();
    } else if (marcadorId !== null) {
      // Retomada do preenchimento: continua pelo id, sem depender de data.
      chamadas = this.db
        .prepare(
          `SELECT id, users_id_recipient, ${dataChave} AS data FROM tickets
            WHERE ${WHERE_COM_RESPONSAVEL} AND id > ?
            ORDER BY id`
        )
        .all(marcadorId);
    } else {
      // INCREMENTAL, com PAGINACAO POR CHAVE (date_mod, id).
      //
      // Antes este modo filtrava so por `date_mod > marcador` e ordenava por id.
      // Salvar "o maior date_mod ate aqui" ao parar nao serve: os ids nao andam
      // junto com as datas, entao chamados com data antiga e id alto ficavam
      // para tras e PULADOS para sempre — e, enquanto nao houvesse cursor, a
      // parada nao salvava nada e a fila inteira voltava (o sintoma de producao:
      // 600 chamados, parou, voltou 600).
      // Ordenando por (data, id) e guardando o par do ultimo concluido, a
      // retomada e exata: nao pula nem repete.
      chamadas = this.db
        .prepare(
          `SELECT id, users_id_recipient, ${dataChave} AS data FROM tickets
            WHERE ${WHERE_COM_RESPONSAVEL}
              AND (${dataChave} > ? OR (${dataChave} = ? AND id > ?))
            ORDER BY ${dataChave}, id`
        )
        .all(marcadorData, marcadorData, cursorPos || 0);
    }

    if (chamadas.length === 0) {
      return;
    }

    let processados = 0;
    let falhas = 0;
    let ultimoConcluido = null; // id do ultimo chamado que terminou bem
    const errosVistos = new Map(); // mensagem de erro -> quantas vezes

    // De quanto em quanto o ponto de retomada e gravado. Em fila grande, a cada
    // 500; em fila pequena, a cada 1/20 dela — com 65 chamados, o passo fixo de
    // 500 NUNCA era atingido e uma parada no meio deixava o marcador vazio.
    const passoMarca = Math.max(1, Math.min(PASSO_MARCADOR, Math.floor(chamadas.length / 20)));

    // Tarefa 109: ETAPA 4 também anda em blocos de CONCORRENCIA_CHAMADOS —
    // mesma regra da fila principal (pessoas/itens de chamados diferentes não
    // disputam nada entre si; o cursor de retomada usa o último concluído).
    let base4 = 0;
    while (base4 < chamadas.length) {
      // Parada pedida pela tela. Grava o ponto EXATO antes de sair: e o que
      // garante a retomada, e nao depende de a fila ser grande o bastante para
      // atingir o passo periodico.
      if (interrompida) {
        if (ultimoConcluido !== null) {
          if (preenchendo) {
            this.gravarMarcadorTecnicosId(ultimoConcluido.id);
          } else {
            // Incremental: grava o PAR (data, id) do ultimo concluido. Antes
            // este ramo so valia no preenchimento, entao parar no incremental
            // nao salvava NADA e a fila voltava inteira.
            this.gravarCursorIncremental(ultimoConcluido.data, ultimoConcluido.id);
          }
        }
        console.log(`Parada solicitada: ${processados} de ${chamadas.length} responsáveis.`);
        break;
      }

      const bloco = chamadas.slice(base4, base4 + CONCORRENCIA_CHAMADOS);
      base4 += bloco.length;

      const resultados = await Promise.all(
        bloco.map(async (linha) => {
          // Pessoas e itens sao leituras INDEPENDENTES: uma falha em `Ticket_User`
          // nao pode impedir que os itens sejam gravados, e vice-versa. Por isso
          // cada uma e tentada por conta propria e `null` significa "falhou" —
          // e coluna com `null` NAO e tocada, o que ja estava gravado sobrevive.
          let pessoas = null;
          let itens = null;
          let erro = null;

          try {
            pessoas = await this.fetchTicketTecnicos(linha.id, linha.users_id_recipient);
          } catch (e) {
            erro = e;
          }

          // Nome e CPF vao para a tabela `usuarios` (uma vez so, nao por chamado).
          try {
            this.catalogarUsuarios(pessoas);
          } catch (e) {
            if (!erro) erro = e;
          }

          try {
            itens = await this.fetchTicketItens(linha.id);
          } catch (e) {
            if (!erro) erro = e;
          }

          if (pessoas !== null || itens !== null) {
            this.gravarLigacoesDoChamado(linha.id, pessoas, itens);
          }

          return { linha, erro };
        })
      );

      // Ordem de conclusão preservada: o cursor avança na ordem da fila, nunca
      // pelo chamado que respondeu primeiro.
      for (const { linha, erro } of resultados) {
        processados += 1;
        if (processados === 1 || processados % PASSO_PROGRESSO === 0 || processados === chamadas.length) {
          informar(processados, chamadas.length, 'responsáveis');
        }

        // Só conta como concluido se nenhuma das leituras estourou: com falha, o
        // chamado fica para a proxima tentativa. Guarda data E id — no incremental
        // os dois formam o cursor de retomada.
        if (!erro) ultimoConcluido = { id: linha.id, data: linha.data };

        if (erro) {
          // Falha pontual: o que estava gravado e preservado (nada e apagado).
          falhas += 1;

          // Guarda a mensagem pelo motivo: sem isso o log so dizia QUANTOS
          // falharam, e nao POR QUE. Se os 113 mil falhassem pelo mesmo motivo,
          // bastava um exemplo para achar a causa.
          const motivo = erro && erro.message ? erro.message : String(erro);
          if (!errosVistos.has(motivo)) {
            errosVistos.set(motivo, { total: 0, primeiro: linha.id });
          }
          errosVistos.get(motivo).total += 1;
        }

        if (processados % passoMarca === 0 && ultimoConcluido !== null) {
          if (preenchendo) {
            // Durante o preenchimento o marco e o ID, que e exato. Gravar uma
            // data aqui era o que travava a retomada.
            this.gravarMarcadorTecnicosId(ultimoConcluido.id);
          } else {
            // Incremental: o marco e o par (data, id). Um "MAX(date_mod) ate
            // aqui" nao serviria — a varredura anda por (data, id), e avancar so
            // pela data perderia chamados de data antiga e id alto.
            this.gravarCursorIncremental(ultimoConcluido.data, ultimoConcluido.id);
          }
        }

        if (DELAY_BETWEEN_TICKETS > 0) await sleep(DELAY_BETWEEN_TICKETS);
      }
    }

    // Fechamento: so marca tudo como pronto quando a varredura TERMINOU sem
    // falha. Nos dois casos contrario o estado parcial e preservado, e a proxima
    // execucao continua de onde parou.
    const varreduraTerminou = !interrompida;
    if (falhas === 0 && varreduraTerminou) {
      const maior = this.db.prepare("SELECT MAX(COALESCE(date_mod, '')) AS m FROM tickets").get();

      if (maior && maior.m) {
        // Guarda o par (data, MAIOR id nessa data) nos DOIS modos. Todo chamado
        // com data ate ali ja foi processado, entao a proxima execucao comeca
        // depois dela. So guardar a data deixaria o cursor em 0 e reconsultaria a
        // fronteira inteira a cada rodada.
        const ultimo = this.db
          .prepare("SELECT MAX(id) AS m FROM tickets WHERE COALESCE(date_mod, '') = ?")
          .get(maior.m);
        this.gravarCursorIncremental(maior.m, ultimo && ultimo.m ? ultimo.m : 0);
      }

      if (preenchendo) {
        // Preenchimento inicial concluido: o marco de id deixa de valer (e e
        // apagado) e o incremental por data assume daqui em diante.
        this.db.prepare("DELETE FROM sync_state WHERE chave = 'tecnicos_sync_id'").run();
      }
    } else if (!interrompida && falhas > 0) {
      console.log(`Atualizando responsáveis... ${processados} de ${chamadas.length} (${falhas} com falha, voltam na próxima).`);
    }

    // Revisao do catalogo: e o que faz um tecnico RENOMEADO no GLPI aparecer
    // com o nome novo. Sem isso, como a varredura so reescreve o chamado que
    // mudou, o nome antigo ficaria em todos os chamados dele, para sempre.
    // O cache da execucao evita repetir quem ja foi consultado acima.
    // Tarefa 109: silenciosa — o usuário pediu para não mostrar "pessoas no
    // catalogo usuarios" na tela.
    try {
      await this.atualizarUsuariosConhecidos();
    } catch (e) {
      // Catalogo indisponivel: a proxima execucao tenta de novo.
    }

    // Por que falhou — agrupado por mensagem, com o primeiro chamado que
    // apresentou o erro. Sem isso so sobraria a contagem, que nao diz nada.
    if (errosVistos.size > 0) {
      console.log(`Atualizando responsáveis... ${processados} de ${chamadas.length} (${falhas} com falha, voltam na próxima).`);
    }
  }


  /**
   * Resolve o nome completo de um grupo atraves da busca de tickets.
   * Usa a API search/Ticket com o campo "Grupo técnico" forçando a
   * exibição desse campo — o response traz o nome completo (completename)
   * do grupo como string (ex.: "Superintendência de TI > Dpto Suporte Técnico > Manutenção").
   *
   * A busca e restrita ao primeiro resultado (range 0-0) apenas para
   * extrair o nome; qualquer ticket atribuido ao grupo serve.
   */
  async resolverNomeGrupo(groupsId) {
    const { campoId } = await this.descobrirOpcoesBusca();

    const params = new URLSearchParams();
    params.set('criteria[0][field]', '8');
    params.set('criteria[0][searchtype]', 'equals');
    params.set('criteria[0][value]', String(groupsId));
    params.set('forcedisplay[0]', '8');
    params.set('range', '0-0');

    // Variável de retorno — inicializada aqui para estar no escopo externo.
    let nome = null;

    try {
      const res = await this.request(`search/Ticket?${params.toString()}`);
      const corpo = await res.json();

      const linhas = [];
      if (Array.isArray(corpo)) {
        linhas.push(corpo);
      } else if (corpo && Array.isArray(corpo.data)) {
        linhas.push(...corpo.data);
      } else if (corpo && corpo.data && typeof corpo.data === 'object') {
        linhas.push(corpo.data);
      }

      for (const linha of linhas) {
        const candidato = linha[8] ?? linha['8'] ?? null;
        if (typeof candidato === 'string' && candidato.trim().length > 0) {
          // Campo 8 do search retorna o grupo como chave de busca; o valor
          // retornado é o "Grupo técnico" formatado como caminho completo.
          if (candidato.startsWith('0') && candidato.length > 1) {
            // O campo de busca às vezes devolve "0<id> <nome>" em algumas
            // versões; limpia o prefixo numérico somente se houver espaço.
            const spacePos = candidato.indexOf(' ');
            if (spacePos > 1) {
              nome = candidato.slice(spacePos + 1).trim();
              break;
            }
          }
          nome = candidato.trim();
          break;
        }
      }
    } catch (e) {
      // Grupo sem nome resolvido: o id segue gravado, só o nome fica vazio.
    }

    return nome;
  }

  /**
   * Descobre os IDs dos campos (search options) usados pela API de busca de
   * Ticket, casando pelo nome real da coluna no banco do GLPI (glpi_tickets.id
   * e glpi_tickets.date_mod). Evita depender de numeros fixos, que variam entre
   * versoes/plugins. Se a consulta falhar, usa os valores classicos 2 e 19.
   */
  async descobrirOpcoesBusca() {
    if (this.opcoesBusca) return this.opcoesBusca;

    const padrao = { campoId: '2', campoDateMod: '19' };

    try {
      const res = await this.request('listSearchOptions/Ticket');
      const opcoes = await res.json();

      let campoId = null;
      let campoDateMod = null;

      for (const [chave, opt] of Object.entries(opcoes)) {
        if (!opt || typeof opt !== 'object') continue;
        if (opt.table !== 'glpi_tickets') continue;

        if (opt.field === 'id' && !campoId) campoId = String(chave);
        if (opt.field === 'date_mod' && !campoDateMod) campoDateMod = String(chave);
      }

      this.opcoesBusca = {
        campoId: campoId || padrao.campoId,
        campoDateMod: campoDateMod || padrao.campoDateMod
      };
    } catch (e) {
      this.opcoesBusca = padrao;
    }

    return this.opcoesBusca;
  }

  /**
   * IDs dos chamados cuja ultima atualizacao (date_mod) e maior que `desde`
   * (formato AAAA-MM-DD HH:MM:SS). Cobre inclusive chamados ja fechados que
   * receberam novo acompanhamento/solucao.
   */
  async getTicketsAlteradosDesde(desde) {
    const { campoId, campoDateMod } = await this.descobrirOpcoesBusca();
    const ids = [];
    const dateModMap = Object.create(null);
    let start = 0;

    while (true) {
      const params = new URLSearchParams();
      params.set('criteria[0][field]', campoDateMod);
      params.set('criteria[0][searchtype]', 'morethan');
      params.set('criteria[0][value]', desde);
      params.set('criteria[0][link]', 'AND');
      params.set('forcedisplay[0]', campoId);
      params.set('forcedisplay[1]', campoDateMod);
      params.set('sort', campoDateMod);
      params.set('order', 'ASC');
      params.set('range', `${start}-${start + PAGE_SIZE - 1}`);

      const res = await this.request(`search/Ticket?${params.toString()}`);
      const corpo = await res.json();

      let linhas = [];
      if (Array.isArray(corpo)) {
        linhas = corpo;
      } else if (corpo && Array.isArray(corpo.data)) {
        linhas = corpo.data;
      } else if (corpo && corpo.data && typeof corpo.data === 'object') {
        linhas = [corpo.data];
      } else if (corpo && typeof corpo === 'object' && !('totalcount' in corpo)) {
        linhas = [corpo];
      }

      if (linhas.length === 0) break;

      for (const linha of linhas) {
        const id = Number(linha[campoId] ?? linha.id);
        if (Number.isFinite(id) && id > 0) {
          ids.push(id);
          const rawDateMod = linha[campoDateMod] ?? linha.date_mod ?? null;
          if (typeof rawDateMod === 'string' && rawDateMod.trim().length > 0) {
            dateModMap[id] = rawDateMod.trim();
          }
        }
      }

      if (linhas.length < PAGE_SIZE) break;

      start += PAGE_SIZE;
      if (DELAY_BETWEEN_PAGES > 0) await sleep(DELAY_BETWEEN_PAGES);
    }

    return { ids, dateModMap };
  }

  // --- ESTADO LOCAL (better-sqlite3 e sincrono) ---
  loadStateFromDb() {
    const rows = this.db.prepare('SELECT id, status FROM tickets').all();

    let maxId = 0;
    this.openTicketIds.clear();

    for (const r of rows) {
      if (r.id > maxId) maxId = r.id;
      if (r.status !== CLOSED_STATUS) this.openTicketIds.add(r.id);
    }

    return { maxId, openCount: this.openTicketIds.size };
  }

  lerUltimoSync() {
    const linha = this.db.prepare("SELECT valor FROM sync_state WHERE chave = 'ultimo_sync'").get();
    return linha ? linha.valor : null;
  }

  gravarUltimoSync(valor) {
    this.db
      .prepare(
        `INSERT INTO sync_state (chave, valor, atualizado_em) VALUES ('ultimo_sync', ?, ?)
         ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`
      )
      .run(valor, new Date().toISOString());
  }

  /** Mapa pendingreasons_id -> nome. Os nomes exatos sao resolvidos na primeira
   * chamada via `Ticket/{id}/PendingReason_Item?expand_dropdowns=true`
   * (ex.: 1 -> "Aguardando Equipamento", 3 -> "Aguardando Retirada").
   * Se a chamada com expand falhar individualmente, cai nos nomes conhecidos. */
  mapPendingReasonIdToName(id) {
    return (
      (this.mapaPendingReasons && this.mapaPendingReasons[id]) ||
      { 1: 'Aguardando Equipamento', 3: 'Aguardando Retirada' }[id] ||
      null
    );
  }

  /** Busca o motivo de pendencia OFICIAL do chamado (API), sem adivinhar texto.
   * Fonte: subitem `Ticket/{id}/PendingReason_Item` (nao esta no JSON do Ticket
   * nem dos followups). Regras:
   *   - sem item                -> null  (ex.: 113197: [] = sem motivo)
   *   - pendingreasons_id = 0   -> null  (ex.: 113140: item existe mas sem motivo)
   *   - id numerico > 0         -> resolve o nome via `PendingReason/{id}`
   *   - string (expand_dropdowns) -> usa o proprio nome devolvido
   * Retorna o NOME do motivo (ex.: "Aguardando Retirada") ou null. */
  async buscarMotivoPendenciaApi(tid) {
    let items;
    try {
      const res = await this.request(`Ticket/${tid}/PendingReason_Item?expand_dropdowns=true`);
      items = await res.json();
    } catch (e) {
      throw new Error(`PendingReason_Item indisponivel: ${e.message}`);
    }

    if (!Array.isArray(items)) items = items == null ? [] : [items];
    if (items.length === 0) return null;

    this.mapaPendingReasons = this.mapaPendingReasons || {};

    for (const it of items) {
      const pid = it.pendingreasons_id;

      // Sem motivo: 0, "0", null, undefined ou string vazia.
      if (pid === 0 || pid === '0' || pid == null || pid === '') continue;

      // Com expand_dropdowns o proprio campo ja traz o NOME do motivo.
      if (typeof pid === 'string' && pid.trim()) return pid.trim();

      // Numerico: resolve o nome uma unica vez por id (cache).
      if (!(pid in this.mapaPendingReasons)) {
        let nome = null;
        try {
          const res = await this.request(`PendingReason/${pid}`);
          const pr = await res.json();
          nome = pr.name || pr.completename || null;
        } catch (e) {
          nome = null;
        }
        this.mapaPendingReasons[pid] = nome || this.mapPendingReasonIdToName(pid);
      }
      if (this.mapaPendingReasons[pid]) return this.mapaPendingReasons[pid];
    }

    return null;
  }

  /** Lista dos 6 motivos de pendencia validos (nomes exatos do GLPI). */
  motivosValidos() {
    return [
      'Aguardando Equipamento',
      'Aguardando Resposta',
      'Aguardando Resposta da IPM',
      'Aguardando Retirada',
      'Garantia',
      'Serviço de Terceiros',
    ];
  }

  // Extrai o motivo de pendencia (status 4) a partir do item OFICIAL
  // (Ticket/{id}/PendingReason_Item). Nao adivinha pelo texto do followup:
  // "foi comunicado sobre a retirada" ou "computador retirado" NAO sao motivo.
  // Recebe o NOME oficial do motivo (ou null) resolvido por
  // `buscarMotivoPendenciaApi` em `processTicket`. Mantida a assinatura antiga
  // por compatibilidade, mas o texto do followup NAO e mais usado como fonte.
  extrairMotivoPendencia(motivoOficial) {
    if (typeof motivoOficial === 'string') {
      const nome = motivoOficial.trim();
      return this.motivosValidos().includes(nome) ? nome : null;
    }
    return null;
  }

  // --- SALVAMENTO NO SQLITE ---
  salvarTicket(ticket, followups, solutions, tasks) {
    const tid = ticket.id;
    const agora = new Date().toISOString();

    const gravar = this.db.transaction(() => {
      // Leitura unica do estado atual do chamado (Tarefa 34): alimenta a
      // preservacao de motivo_pendencia/groups e o diff de escrita abaixo.
      const atual = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(tid) || null;

      // motivo_pendencia: gravado SOMENTE quando o chamado esta pendente (status 4)
      // e a execucao definiu o motivo (`__definirMotivo`). Nos demais casos a
      // coluna fica intacta: para fechados (6) e solucionados (5) o valor atual
      // e simplesmente preservado, conforme pedido ("nao precisamos mexer").
      let motivoParaGravar;
      if (ticket.status === 4 && ticket.__definirMotivo) {
        motivoParaGravar = ticket.motivo_pendencia || null;
      } else {
        motivoParaGravar = atual ? (atual.motivo_pendencia ?? null) : null;
      }

      // groups: gravado SOMENTE quando a busca de grupos teve sucesso
      // (`__definirGrupos === true`). Nos demais casos o valor atual e
      // preservado (busca falhou ou chamado sem atribuicao).
      let groupsParaGravar;
      if (ticket.__definirGrupos) {
        groupsParaGravar = ticket.groups ? JSON.stringify(ticket.groups) : null;
      } else {
        groupsParaGravar = atual ? (atual.groups ?? null) : null;
      }

      // Diff da linha do chamado: compara apenas as colunas materializadas
      // (`date_mod` e o proprio sentinela de mudanca do GLPI). raw_json fica de
      // fora da comparacao (ordem de chave geraria falso-mudado) e e regravado
      // junto quando qualquer coluna mudar. Sem mudanca: nenhuma escrita —
      // `updated_at` permanece como a ultima mudanca REAL do chamado.
      const colunasTicket = [
        'name', 'content', 'status', 'date', 'closedate', 'solvedate', 'date_mod',
        'urgency', 'impact', 'priority', 'itilcategories_id', 'type',
        'entities_id', 'users_id_recipient', 'motivo_pendencia', 'groups',
      ];
      const valoresTicket = [
        ticket.name ?? null, ticket.content ?? null, ticket.status ?? null,
        ticket.date ?? null, ticket.closedate ?? null, ticket.solvedate ?? null,
        ticket.date_mod || null, ticket.urgency ?? null, ticket.impact ?? null,
        ticket.priority ?? null, ticket.itilcategories_id ?? null,
        ticket.type ?? null, ticket.entities_id ?? null,
        ticket.users_id_recipient ?? null, motivoParaGravar, groupsParaGravar,
      ];

      if (!atual) {
        this.db
          .prepare(
            `INSERT INTO tickets (id, ${colunasTicket.join(', ')}, raw_json, updated_at)
             VALUES (?, ${colunasTicket.map(() => '?').join(', ')}, ?, ?)`
          )
          .run(tid, ...valoresTicket, JSON.stringify(ticket), agora);
      } else if (colunasTicket.some((c, i) => this.valorDiferente(atual[c], valoresTicket[i]))) {
        this.db
          .prepare(
            `UPDATE tickets SET ${colunasTicket.map((c) => `${c} = ?`).join(', ')},
               raw_json = ?, updated_at = ? WHERE id = ?`
          )
          .run(...valoresTicket, JSON.stringify(ticket), agora, tid);
      }
      // Chaves identicas: nenhuma escrita (evita IO e mantem updated_at honesto).

      // Filhos: reconciliacao por diff (Tarefa 34) — insere so os novos,
      // atualiza so os alterados, nao mexe nos identicos e apaga so os que
      // sumiram no GLPI. So chega aqui com busca bem-sucedida
      // (getSubItems estrito propaga erro antes).
      this.reconciliarFilhos('followups', tid, followups, ['content', 'date', 'users_id', 'is_private']);
      this.reconciliarFilhos('solutions', tid, solutions, ['content', 'date', 'users_id', 'status']);
      this.reconciliarFilhos('tasks', tid, tasks, ['content', 'date', 'users_id', 'actiontime', 'state']);

      // Solucionado/fechado (Tarefa 42): acompanhamento ja foi visto — zera o
      // amarelo marcando `visto = 1` em todos os followups do chamado. Vem
      // DEPOIS do reconciliarFilhos para cobrir tambem os INSERTs novos (0).
      if (ticket.status === 5 || ticket.status === 6) {
        this.db.prepare('UPDATE followups SET visto = 1 WHERE tickets_id = ? AND visto <> 1').run(tid);
      }

      // Anexos: gravacao segue DESATIVADA (bloco comentado abaixo). O DELETE e
      // mantido igual ao comportamento atual — nada le esta tabela hoje.
      this.db.prepare('DELETE FROM attachments WHERE tickets_id = ?').run(tid);

      /*
      // --- GRAVACAO DE ANEXOS DESATIVADA (junto com o download acima) ---
      for (const d of docs) {
        const docId = d.documents_id || d.id;
        let docInfo = d;

        if (!docInfo.filename && !docInfo.filepath) {
          try {
            const resDoc = await this.request(`Document/${docId}`);
            docInfo = await resDoc.json();
          } catch (e) {}
        }

        const rawFilename = docInfo.filename || docInfo.filepath || docInfo.name || `doc_${docId}`;
        const mimeType = docInfo.mime || d.mime;

        const downloadResult = await this.downloadDocument(docId, tid, rawFilename, mimeType);

        const localPath = downloadResult ? downloadResult.localPath : null;
        const finalFilename = downloadResult ? downloadResult.filename : rawFilename;

        this.db.run(`
          INSERT OR REPLACE INTO attachments (id, tickets_id, documents_id, filename, local_path, mime, filesize, date_creation, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          d.id || docId, tid, docId, finalFilename, localPath,
          mimeType, docInfo.filesize || d.filesize,
          docInfo.date_creation || d.date_creation,
          JSON.stringify(docInfo)
        ]);
      }
      */
    });

    gravar();
  }

  // Compara valores de forma normalizada (SQLite devolve number, API pode
  // devolver string; null/undefined equivalentes) — base do diff de escrita.
  valorDiferente(a, b) {
    const n = (v) => (v == null ? null : String(v));
    return n(a) !== n(b);
  }

  /**
   * Reconciliacao por diff dos filhos de um chamado (Tarefa 34). `colunas`
   * lista apenas as colunas materializadas; colunas de estado (ex.: `visto`
   * em followups) ficam FORA da lista e nunca sao tocadas pelo UPDATE. O
   * INSERT de followup novo grava `visto = 0` (nao lido — Tarefa 35).
   * - id novo                     -> INSERT;
   * - id existente com diferenca  -> UPDATE (somente as colunas da lista);
   * - id identico                 -> nenhuma escrita;
   * - id local fora da resposta   -> DELETE (removido no GLPI).
   * Apenas uma busca bem-sucedida (getSubItems estrito) deve chegar aqui —
   * nunca se reconcilia exclusao a partir de falha de rede.
   */
  reconciliarFilhos(tabela, ticketsId, novos, colunas) {
    if (!['followups', 'solutions', 'tasks'].includes(tabela)) {
      throw new Error(`Tabela de filhos nao suportada: ${tabela}`);
    }

    const selecionar = this.db.prepare(
      `SELECT id, ${colunas.join(', ')}, raw_json FROM ${tabela} WHERE tickets_id = ?`
    );
    // `visto` entra SO no INSERT de followups (Tarefa 35): linha nova nasce
    // como nao lida (0). Como fica fora de `colunas`, o diff/UPDATE nunca toca
    // nela e uma marcacao futura de leitura sobrevive ao re-sync.
    const colunasInsert = tabela === 'followups' ? [...colunas, 'visto'] : colunas;
    const inserir = this.db.prepare(
      `INSERT OR REPLACE INTO ${tabela} (id, tickets_id, ${colunasInsert.join(', ')}, raw_json)
       VALUES (?, ?, ${colunasInsert.map(() => '?').join(', ')}, ?)`
    );
    const atualizar = this.db.prepare(
      `UPDATE ${tabela} SET ${colunas.map((c) => `${c} = ?`).join(', ')}, raw_json = ? WHERE id = ?`
    );
    const apagar = this.db.prepare(`DELETE FROM ${tabela} WHERE id = ?`);

    const atuais = new Map(selecionar.all(ticketsId).map((r) => [r.id, r]));
    const presentes = new Set();

    for (const item of novos) {
      if (item == null || item.id == null) continue;
      presentes.add(item.id);

      const valores = colunas.map((c) => (item[c] ?? null));
      const existente = atuais.get(item.id);

      if (!existente) {
        const extras = tabela === 'followups' ? [0] : [];
        inserir.run(item.id, ticketsId, ...valores, ...extras, JSON.stringify(item));
        continue;
      }

      const mudou = colunas.some((c, i) => this.valorDiferente(existente[c], valores[i]));
      if (mudou) atualizar.run(...valores, JSON.stringify(item), item.id);
      // identico: nenhuma escrita.
    }

    for (const id of atuais.keys()) {
      if (!presentes.has(id)) apagar.run(id);
    }
  }

  /** Mesmo criterio do dashboard: algum grupo com "dpto suporte técnico". */
  ehDoDepartamento(groups) {
    if (!Array.isArray(groups)) return false;
    return groups.some((g) =>
      String(g && g.name ? g.name : '').toLowerCase().includes('dpto suporte técnico')
    );
  }

  // --- PROCESSAMENTO DE CHAMADOS ---
  // Tarefa 109: os 4 subitens independentes saem juntos (Promise.all), e o
  // motivo de pendência só é buscado para quem é pendente do nosso
  // departamento — antes eram até 7 chamadas sequenciais por chamado, e a
  // ETAPA 5 ainda repetia o motivo para todos os pendentes.
  async processTicket(tid, origem = 'novo') {
    if (this.idsSincronizados.has(tid)) return false;
    this.idsSincronizados.add(tid);

    try {
      const ticket = await this.getTicketFull(tid);
      const [followups, solutions, tasks, groupsResult] = await Promise.all([
        this.getSubItems(tid, 'ITILFollowup'),
        this.getSubItems(tid, 'ITILSolution'),
        this.getSubItems(tid, 'TicketTask'),
        this.fetchTicketGroups(tid).then(
          (groups) => ({ ok: true, groups }),
          () => ({ ok: false, groups: null })
        ),
      ]);

      // Grupos atribuidos ao chamado (Ticket/{id}/Group_Ticket).
      // Fonte: subitem oficial `Ticket/{id}/Group_Ticket` (não está no JSON do
      // Ticket nem no dos followups). O nome completo de cada grupo é resolvido
      // uma única vez via `search/Ticket` (campo "Grupo técnico") e cacheado
      // durante a execução. Chamados sem atribuição retornam [].
      // Falha de rede nesse subitem: preserva o valor já gravado.
      if (groupsResult.ok) {
        ticket.groups = groupsResult.groups;
        ticket.__definirGrupos = true;
      } else {
        ticket.__definirGrupos = false;
        delete ticket.groups;
      }

      // Motivo de pendencia - SOMENTE para chamado pendente (status 4) do NOSSO
      // departamento. Fonte: subitem OFICIAL `Ticket/{id}/PendingReason_Item`.
      // O texto do followup NAO e usado (gerava falsos positivos). A API e a
      // fonte da verdade: sem motivo, grava null. Demais casos mantêm o valor
      // atual (ver `salvarTicket`); a ETAPA 5 não repete esta leitura.
      if (ticket.status === 4 && this.ehDoDepartamento(ticket.groups)) {
        try {
          ticket.motivo_pendencia = this.extrairMotivoPendencia(
            await this.buscarMotivoPendenciaApi(tid)
          );
          ticket.__definirMotivo = true;
        } catch (e) {
          // Falha de rede/item nesta chamada: preserva o que ja estava gravado.
          ticket.__definirMotivo = false;
          delete ticket.motivo_pendencia;
        }
      }

      // Referencias de documentos: mantidas vazias junto com o bloco de anexos
      const docs = [];

      this.salvarTicket(ticket, followups, solutions, tasks);

      // Nenhum detalhe do chamado e impresso: o progresso ("1 de 47") e mostrado
      // por quem chama processTicket, na tela da sincronizacao.
      return true;
    } catch (e) {
      // Falha pontual: o chamado volta na proxima execucao (conta em `falhas`).
      return false;
    }
  }

  // --- FLUXO PRINCIPAL ---
  async run() {
    validarConfiguracao();

    const startTime = Date.now();
    const instanteSync = formatarDataGlpi(new Date());

    this.initDb();

    const { maxId } = this.loadStateFromDb();
    const ultimoSync = this.lerUltimoSync();

    const baseAlteracoes = ultimoSync ? parseDataGlpi(ultimoSync) : null;
    const desde = formatarDataGlpi(
      baseAlteracoes
        ? new Date(baseAlteracoes.getTime() - MARGEM_SEGURANCA_SEG * 1000)
        : dataRecuadaDias(JANELA_INICIAL_DIAS)
    );

    await this.login();

    try {
      // ETAPA 1: chamados alterados desde a ultima sincronizacao

      let alterados = [];
      let buscaDisponivel = true;

      try {
        const resultadoAlterados = await this.getTicketsAlteradosDesde(desde);
        alterados = resultadoAlterados.ids;
      } catch (e) {
        buscaDisponivel = false;
      }

      if (!buscaDisponivel) {
        alterados = Array.from(this.openTicketIds);
      }

      // ETAPA 2: checagem CURTA de chamados novos (id maior que o maior id local).
      // Nao varre o catalogo: no maximo MAX_PAGINAS_NOVOS paginas, a partir do fim.

      const novos = [];
      let start = Math.max(0, maxId - PAGE_SIZE);
      let paginasLidas = 0;

      while (paginasLidas < MAX_PAGINAS_NOVOS) {
        const pageIds = await this.getTicketIdsPage(start);
        paginasLidas += 1;

        if (pageIds.length === 0) break;

        for (const tid of pageIds) {
          if (tid > maxId) novos.push(tid);
        }

        // Pagina incompleta = ultima pagina do catalogo.
        if (pageIds.length < PAGE_SIZE) break;

        start += PAGE_SIZE;
        if (DELAY_BETWEEN_PAGES > 0) await sleep(DELAY_BETWEEN_PAGES);
      }

      // FILA UNICA: alterados primeiro, depois os novos, sem ids repetidos.
      // O tamanho da fila e a estimativa mostrada no progresso ("1 de N").
      const fila = [];
      const naFila = new Set();

      for (const id of alterados) {
        if (naFila.has(id)) continue;
        naFila.add(id);
        fila.push({ id, origem: buscaDisponivel ? 'alterado' : 'aberto' });
      }

      for (const id of novos) {
        if (naFila.has(id)) continue;
        naFila.add(id);
        fila.push({ id, origem: 'novo' });
      }

      let processados = 0;
      let falhas = 0;

      // Tarefa 109: a primeira etapa mostrava "x de y" sem dizer o quê. Agora
      // diz: "Atualizando chamados... x de y" a cada 10. Os chamados andam em
      // blocos de CONCORRENCIA_CHAMADOS (3) — cada um custa ~5 chamadas à API
      // (Ticket + 3 subitens + grupos juntos); em fila 1 por 1 a latência soma.
      for (let base = 0; base < fila.length; base += CONCORRENCIA_CHAMADOS) {
        // Parada pedida pela tela: encerra a fila aqui. O que ja foi gravado
        // fica; os chamados restantes voltam na proxima execucao, porque a
        // ETAPA 1 consulta pela data de alteracao e eles continuam la.
        if (interrompida) {
          console.log(`Parada solicitada: ${processados} de ${fila.length} chamados.`);
          break;
        }

        const bloco = fila.slice(base, base + CONCORRENCIA_CHAMADOS);
        const resultados = await Promise.all(bloco.map((item) => this.processTicket(item.id, item.origem)));

        for (let i = 0; i < bloco.length; i += 1) {
          processados += 1;
          if (!resultados[i]) falhas += 1;
          if (processados === 1 || processados % PASSO_PROGRESSO === 0 || processados === fila.length) {
            informar(processados, fila.length, 'chamados');
          }
        }

        if (DELAY_BETWEEN_TICKETS > 0) await sleep(DELAY_BETWEEN_TICKETS);
      }

      if (!interrompida && fila.length > 0 && falhas > 0) {
        console.log(`Atualizando chamados... ${fila.length} de ${fila.length} (${falhas} com falha, voltam na proxima).`);
      }

      // ETAPA 3: popula a coluna `tickets.groups` de chamados que ainda não
      // têm grupos atribuidos no banco local, OU quando o modo "sincronizacao
      // completa de grupos" estiver ativado (chave `full_sync_groups = '1' em
      // `sync_state`). A fonte e o subitem `Ticket/{id}/Group_Ticket`; o nome
      // de cada grupo e resolvido atraves do campo de busca "Grupo tecnico"
      // (field 8) e cacheado durante a execucao. Chamados sem atribuicao
      // recebem groups = null (nao []).
      // Isso garante que, na proxima vez que o dashboard precisar filtrar por
      // departamento/subgrupo, a informacao ja estara no SQLite.
      const fullSyncGroups = this.db
        .prepare("SELECT valor FROM sync_state WHERE chave = 'full_sync_groups'")
        .get();
      const modoCompletoGrupos = fullSyncGroups && fullSyncGroups.valor === '1';

      if (modoCompletoGrupos) {
        const todosLocal = this.db
          .prepare('SELECT id FROM tickets ORDER BY id')
          .all()
          .map((r) => r.id);

        let gruposPopulados = 0;

        for (const id of todosLocal) {
          // Parada pedida pela tela — a varredura de grupos tambem pode ser longa.
          if (interrompida) {
            console.log(`Parada solicitada: ${gruposPopulados} de ${todosLocal.length} grupos.`);
            break;
          }

          gruposPopulados += 1;
          if (gruposPopulados === 1 || gruposPopulados % PASSO_PROGRESSO === 0 || gruposPopulados === todosLocal.length) {
            informar(gruposPopulados, todosLocal.length, 'grupos');
          }

          try {
            // Roda o fetch fora da transacao de salvarTicket para nao
            // abrir/comer transacoes muito grandes durante o scan total.
            const groups = await this.fetchTicketGroups(id);
            this.db
              .prepare(
                `INSERT INTO tickets (id, groups) VALUES (?, ?)
                 ON CONFLICT(id) DO UPDATE SET groups = excluded.groups`
              )
              .run(id, groups ? JSON.stringify(groups) : null);
          } catch (e) {
            // Falha pontual: preserva o valor ja gravado (se existir).
          }

          if (DELAY_BETWEEN_TICKETS > 0) await sleep(DELAY_BETWEEN_TICKETS);
        }

        // Após concluir, remove a flag para nao repetir na proxima execucao
        // (a menos que o usuario queira forçar de novo).
        this.db
          .prepare("DELETE FROM sync_state WHERE chave = 'full_sync_groups'")
          .run();
      } else {
        // Sem flag: popula grupos dos chamados PENDENTES (status = 4) que ainda
        // não têm grupos gravados no banco local. O filtro por status evita
        // reprocessar toda a base (~113 mil chamados) a cada execução — apenas
        // os pendentes são varridos. Chamados que já possuem grupos válidos
        // são ignorados (groups NULL, '' ou '[]' entram).
        const precisaGrupo = this.db
          .prepare(
            `SELECT id FROM tickets WHERE status = 4
               AND (groups IS NULL OR groups = '' OR groups = '[]'
                    OR (groups IS NOT NULL AND json_valid(groups) = 0))
             ORDER BY id`
          )
          .all()
          .map((r) => r.id);

        if (precisaGrupo.length > 0) {
          let populados = 0;
          for (const id of precisaGrupo) {
            if (interrompida) {
              console.log(`Parada solicitada: ${populados} de ${precisaGrupo.length} grupos.`);
              break;
            }

            populados += 1;
            if (populados === 1 || populados % PASSO_PROGRESSO === 0 || populados === precisaGrupo.length) {
              informar(populados, precisaGrupo.length, 'grupos');
            }

            try {
              const groups = await this.fetchTicketGroups(id);
              this.db
                .prepare(
                  `INSERT INTO tickets (id, groups) VALUES (?, ?)
                   ON CONFLICT(id) DO UPDATE SET groups = excluded.groups`
                )
                .run(id, groups ? JSON.stringify(groups) : null);
            } catch (e) {
              // Falha pontual: preserva o valor ja gravado (se existir).
            }

            if (DELAY_BETWEEN_TICKETS > 0) await sleep(DELAY_BETWEEN_TICKETS);
          }
        }
      }

      // ETAPA 4 (Tarefa 98): tecnicos atribuidos a cada chamado, na tabela nova
      // `tecnicos_atribuidos`. Vai DEPOIS dos grupos e ANTES dos motivos, porque
      // faz as mesmas chamadas por chamado (subitem `Ticket/{id}/...`) e assim
      // aproveita o mesmo padrao de la. A tabela `tecnicos` do sistema NAO e
      // tocada: aquela e a equipe do DINFO, nao o GLPI.
      await this.sincronizarTecnicosAtribuidos();

      // PARADA SOLICITADA PELA TELA (T99).
      //
      // O `break` acima tirou o processo do laco da ETAPA 4, mas o `run()`
      // seguiria para as etapas 5, 6 e 7 — e a 6 (indice FTS5) pode levar
      // minutos. Era por isso que a tela ficava presa em "Parando..." depois do
      // clique. Aqui a sincronizacao encerra de vez: as etapas restantes sao
      // puladas e o `ultimo_sync` NAO e gravado, para que a proxima execucao
      // volte a buscar os chamados alterados desde a ultima vez que realmente
      // terminou.
      if (interrompida) {
        console.log('Sincronização interrompida. O progresso foi salvo.');
        return;
      }

      // ETAPA 5 (motivos de pendência): **Tarefa 109** — deixou de ser uma
      // varredura à parte. A leitura de `PendingReason_Item` passou para dentro
      // do `processTicket`, só para pendente (status 4) do NOSSO departamento.
      // Antes a etapa refazia a leitura de TODOS os pendentes a cada execução,
      // mesmo sem alteração; quem não mudou mantém o motivo gravado.

      // ETAPA 6: indice de busca (Tarefa 85).
      // Cria o indice FTS5 a partir da BASE LOCAL (nada e baixado da API) se ele
      // ainda nao existe — e esse e o caminho do servidor de producao, onde o
      // arquivo nao existe e nasce na primeira sincronizacao. Se ja existe, atualiza
      // somente os chamados alterados e os acompanhamentos novos. Um aperto no botao
      // "Sincronizar" popula; depois disso, cada rodada mantem em dia.
      // Tarefa 109: o indice informa "Atualizando busca..."; linha técnica
      // ("x chamado(s) reindexado(s)") não vai para a tela.
      informarEtapa('busca');
      const { garantirIndice } = require('../lib/indiceGlpi');
      garantirIndice({});

      // ETAPA 7: grava o estado da sincronizacao
      this.gravarUltimoSync(instanteSync);

      console.log('Concluído.');
    } finally {
      await this.killSession();
      this.fecharBanco();
    }
  }
}

// Captura excecoes nao tratadas para evitar encerramento inesperado
process.on('uncaughtException', (err) => {
  console.error(' [CRITICAL ERROR] Excecao nao capturada:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error(' [CRITICAL ERROR] Promise rejeitada sem catch:', reason);
});

if (require.main === module) {
  const exporter = new GLPIExporter();
  exporter
    .run()
    .then(() => {
      // Saida 143 (128 + SIGTERM) quando a parada foi pedida pela tela: e o que
      // faz a interface mostrar "Sincronizacao interrompida" em vez de
      // "concluida". O progresso ja foi gravado, entao nada se perde.
      if (foiInterrompida()) {
        console.log('Sincronizacao interrompida pelo usuario. O progresso foi salvo.');
        process.exitCode = 143;
      }
    })
    .catch((err) => {
      console.error('Erro fatal na execucao:', err.message);
      process.exitCode = 1;
    });
}

module.exports = { GLPIExporter };