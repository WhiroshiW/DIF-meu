'use strict';

/**
 * Índice de busca do GLPI (FTS5) — Tarefa 85.
 *
 * POR QUE EXISTE
 * A busca por texto no snapshot com `LIKE '%terro%'` não tem como usar índice: o
 * SQLite folheia a base inteira (1,4 GB, 113 mil chamados e 183 mil acompanhamentos).
 * Medido nesta base: 0,04 s quando o teto de 50 resultados é alcançado antes do fim,
 * ~1,7 s quando não há nada e o arquivo está em cache, e ~39 s na primeira leitura
 * depois de ligado o computador. Pior: `better-sqlite3` é síncrono, então durante a
 * folheia **o servidor inteiro para** (o dashboard que leva 43 ms chegou a 33,6 s).
 *
 * O FTS5 (que já vem dentro do SQLite) troca a folheia por uma consulta ao índice
 * invertido: a mesma busca de 3 palavras cai para **2 ms**, o acento deixa de
 * importar (quem digita "configuracao" acha "configuração") e o servidor não trava.
 * Custo medido: 49,4 s para construir uma vez e 618 MB de índice (43% da base, mas
 * 0,4% dos 158 GB livres na máquina C:).
 *
 * ONDE FICA
 * Em arquivo **separado** do snapshot, por padrão ao lado dele
 * (`../Base_GLPI/glpi_indice.db`), ou no caminho de `GLPI_INDICE_PATH`. Separado
 * porque dá para refazer o índice sem tocar nos 1,4 GB de dados, e porque um índice
 * corrompido se resolve apagando um arquivo.
 *
 * QUEM USA
 * - `scripts/sincronizar-glpi.js`, ao fim de cada execução (ETAPA 6): cria o índice
 *   se ainda não existe e, se já existe, atualiza só o que mudou.
 * - `app/api/glpi/busca/route.ts`: procura no índice; sem índice (ou com ele
 *   quebrado), a rota cai automaticamente na busca antiga por `LIKE`.
 *
 * COMO SE MANTÉM EM DIA
 * Marcador `atualizado_ate` = maior `date_mod` dos chamados já indexados. Como o
 * `date_mod` é a data de alteração do chamado no GLPI, tudo que o script regravou
 * depois do marcador entra na atualização seguinte — e a busca por `date_mod > ?`
 * usa o índice `idx_tickets_date_mod`, então só as linhas novas são lidas.
 * Acompanhamentos não têm `date_mod`; como no GLPI eles não se editam (são um
 * histórico que só cresce), o marcador é o maior `id` indexado. Se ainda assim a
 * contagem não bater com a da base, o índice é refeito inteiro: o sistema prefere
 * gastar 50 s a mostrar resultado velho.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/** Versão do formato do índice; quando muda, a busca recria o índice do zero. */
const VERSAO_INDICE = '2';

/**
 * Deslocamentos de `rowid` para as tres origens conviverem na mesma tabela
 * `acompanhamentos` (Tarefa 87): followups, solutions e tasks vem de sequencias
 * de id diferentes e colidiriam; cada origem ocupa sua faixa.
 */
const OFFSET_SOLUCAO = 1000000000;
const OFFSET_TAREFA = 2000000000;

/** Caminho do snapshot do GLPI (mesma regra de `scripts/sincronizar-glpi.js`). */
function caminhoBase() {
  const doEnv = process.env.GLPI_DB_PATH;
  if (doEnv) return path.resolve(process.cwd(), doEnv);
  return path.resolve(process.cwd(), '..', 'Base_GLPI', 'glpi_local.db');
}

/** Caminho do arquivo de índice (por padrão, ao lado do snapshot). */
function caminhoIndice() {
  const doEnv = process.env.GLPI_INDICE_PATH;
  if (doEnv) return path.resolve(process.cwd(), doEnv);
  return path.resolve(path.dirname(caminhoBase()), 'glpi_indice.db');
}

/**
 * Tabelas do índice.
 * - `chamados`: título, descrição, **localização** e **grupo** (Tarefa 87). As
 *   quatro entram no índice sem custo extra de leitura (com `LIKE` a localização
 *   obrigaria o banco a abrir o `raw_json` das 113 mil linhas: 22 s em vez de 1 s).
 * - `acompanhamentos`: o id do chamado não é indexado, só guardado. Junta as tres
 *   origens de texto livre — `followups`, **`solutions`** e **`tasks`** (Tarefa 87) —
 *   separadas pelos deslocamentos de `rowid` (`OFFSET_SOLUCAO`/`OFFSET_TAREFA`).
 *   O `raw_json` dessas tabelas não é indexado porque não tem texto além das
 *   colunas já materializadas (`name`/`content`): só repete os mesmos campos e
 *   os ids numéricos, o que dobraria o tamanho do índice sem ganho de busca.
 * - `remove_diacritics 2` faz o tokenizador ignorar acento: "configuracao" casa
 *   com "configuração". `prefix = '2 3'` indexa os prefixos de 2 e 3 letras, para
 *   a busca aceitar a palavra ainda pela metade.
 */
const SQL_TABELAS = `
CREATE TABLE IF NOT EXISTS controle (chave TEXT PRIMARY KEY, valor TEXT);

CREATE VIRTUAL TABLE IF NOT EXISTS chamados USING fts5(
  titulo, descricao, local, grupo,
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '2 3'
);
CREATE VIRTUAL TABLE IF NOT EXISTS acompanhamentos USING fts5(
  tickets_id UNINDEXED, conteudo,
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '2 3'
);
`;

/** Lê uma chave da tabela de controle do índice (o marcador de progresso). */
function lerControle(db, chave) {
  try {
    const linha = db.prepare('SELECT valor FROM controle WHERE chave = ?').get(chave);
    return linha ? linha.valor : null;
  } catch {
    return null;
  }
}

function gravarControle(db, chave, valor) {
  db.prepare(
    'INSERT INTO controle (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'
  ).run(chave, String(valor));
}

/** Informa o que está acontecendo, para quem chamou mostrar na tela. */
function avisar(aoProgredir, mensagem) {
  if (typeof aoProgredir === 'function') aoProgredir(mensagem);
}

/**
 * Situação do índice sem abrir a base do GLPI: existe, está pronto (a construção
 * terminou) e é de uma versão conhecida?
 */
function estadoIndice() {
  const arquivo = caminhoIndice();
  if (!fs.existsSync(arquivo)) return { existe: false, pronto: false, caminho: arquivo };

  let db;
  try {
    db = new Database(arquivo, { readonly: true, fileMustExist: true });
    const pronto = lerControle(db, 'pronto') === '1';
    const versao = lerControle(db, 'versao');
    return {
      existe: true,
      pronto: pronto && versao === VERSAO_INDICE,
      caminho: arquivo,
      versao,
      chamados: Number(lerControle(db, 'chamados_indexados') || 0),
      reconstruidoEm: lerControle(db, 'reconstruido_em'),
    };
  } catch {
    return { existe: true, pronto: false, caminho: arquivo };
  } finally {
    if (db) db.close();
  }
}

/**
 * Refaz o índice inteiro, lendo do snapshot local.
 *
 * Constrói num arquivo temporário e só então troca pelo definitivo: se a construção
 * falhar no meio, o índice antigo (que ainda funciona) fica no lugar.
 */
function reconstruir(opcoes) {
  const cfg = opcoes || {};
  const aoProgredir = cfg.aoProgredir;
  const base = cfg.caminhoBase || caminhoBase();
  const destino = cfg.caminhoIndice || caminhoIndice();
  const temporario = `${destino}.temporario`;

  if (!fs.existsSync(base)) {
    throw new Error(`Base do GLPI nao encontrada: ${base}`);
  }
  if (fs.existsSync(temporario)) fs.unlinkSync(temporario);

  const inicio = Date.now();
  avisar(aoProgredir, `Montando o indice de busca a partir de ${path.basename(base)}...`);

  const indice = new Database(temporario);
  // Declaradas aqui porque o resumo do fim precisa delas, e o `try` onde são
  // calculadas tem escopo próprio.
  let totalChamados = 0;
  let totalAcompanhamentos = 0;
  try {
    indice.pragma('journal_mode = WAL');
    indice.pragma('synchronous = NORMAL');
    indice.exec(SQL_TABELAS);
    // ATTACH precisa acontecer fora de transacao.
    indice.prepare('ATTACH DATABASE ? AS base').run(base);

    totalChamados = indice.prepare('SELECT COUNT(*) AS total FROM base.tickets').get().total;
    totalAcompanhamentos = indice
      .prepare(
        'SELECT (SELECT COUNT(*) FROM base.followups) + ' +
          '(SELECT COUNT(*) FROM base.solutions) + (SELECT COUNT(*) FROM base.tasks) AS total'
      )
      .get().total;
    avisar(
      aoProgredir,
      `Indexando ${totalChamados} chamados e ${totalAcompanhamentos} acompanhamentos/tarefas/solucoes (leva ~1 minuto)...`
    );

    indice.exec('BEGIN');
    indice.exec(`
      INSERT INTO chamados (rowid, titulo, descricao, local, grupo)
      SELECT id, name, content, raw_json ->> 'locations_id', groups FROM base.tickets
    `);
    indice.exec(`
      INSERT INTO acompanhamentos (rowid, tickets_id, conteudo)
      SELECT id, tickets_id, COALESCE(content, '') FROM base.followups
    `);
    indice.exec(`
      INSERT INTO acompanhamentos (rowid, tickets_id, conteudo)
      SELECT id + ${OFFSET_SOLUCAO}, tickets_id, COALESCE(content, '') FROM base.solutions
    `);
    indice.exec(`
      INSERT INTO acompanhamentos (rowid, tickets_id, conteudo)
      SELECT id + ${OFFSET_TAREFA}, tickets_id, COALESCE(content, '') FROM base.tasks
    `);
    indice.exec('COMMIT');

    const maiorData = indice.prepare('SELECT MAX(date_mod) AS data FROM base.tickets').get().data || '';
    const maiorIdAcomp = indice.prepare('SELECT MAX(id) AS id FROM base.followups').get().id || 0;
    const maiorIdSol = indice.prepare('SELECT MAX(id) AS id FROM base.solutions').get().id || 0;
    const maiorIdTarefa = indice.prepare('SELECT MAX(id) AS id FROM base.tasks').get().id || 0;

    indice.exec('BEGIN');
    gravarControle(indice, 'versao', VERSAO_INDICE);
    gravarControle(indice, 'chamados_indexados', totalChamados);
    gravarControle(indice, 'acompanhamentos_indexados', totalAcompanhamentos);
    gravarControle(indice, 'atualizado_ate', maiorData);
    gravarControle(indice, 'maior_id_acompanhamento', maiorIdAcomp);
    gravarControle(indice, 'maior_id_solucao', maiorIdSol);
    gravarControle(indice, 'maior_id_tarefa', maiorIdTarefa);
    gravarControle(indice, 'reconstruido_em', new Date().toISOString());
    gravarControle(indice, 'pronto', '1');
    indice.exec('COMMIT');

    indice.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    try {
      indice.exec('DETACH DATABASE base');
    } catch {
      // Ja detached ou base fechada: irrelevante na saida.
    }
    indice.close();
  }

  // Troca do arquivo. No Windows `rename` nao substitui, entao o antigo sai antes
  // (a janela entre os dois e de milissegundos e so afeta quem estiver buscando).
  if (fs.existsSync(destino)) fs.unlinkSync(destino);
  fs.renameSync(temporario, destino);
  for (const sufixo of ['-wal', '-shm']) {
    if (fs.existsSync(`${destino}${sufixo}`)) fs.unlinkSync(`${destino}${sufixo}`);
  }

  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  const tamanho = (fs.statSync(destino).size / 1048576).toFixed(0);
  const resumo =
    `Indice de busca pronto em ${segundos}s: ${totalChamados} chamados, ` +
    `${totalAcompanhamentos} registros (acompanhamento/tarefa/solucao), ${tamanho} MB.`;
  avisar(aoProgredir, resumo);
  return {
    caminho: destino,
    chamados: totalChamados,
    acompanhamentos: totalAcompanhamentos,
    segundos: Number(segundos),
  };
}

/**
 * Atualiza so o que mudou desde a ultima vez, sem refazer o indice inteiro.
/**
 * Atualiza so o que mudou desde a ultima vez, sem refazer o indice inteiro.
 * Chamados: os que tem `date_mod` maior que o marcador (consulta indexada).
 * Acompanhamentos: os de `id` maior que o maior id indexado.
 */
function atualizarIncremental(opcoes) {
  const cfg = opcoes || {};
  const aoProgredir = cfg.aoProgredir;
  const base = cfg.caminhoBase || caminhoBase();
  const destino = cfg.caminhoIndice || caminhoIndice();

  if (!fs.existsSync(destino)) return reconstruir(cfg);

  const indice = new Database(destino);
  // O Windows nao deixa trocar um arquivo que esteja aberto: quando o indice esta
  // defasado e precisa ser refeito, a conexao tem de ser fechada ANTES de chamar
  // `reconstruir` (sem isso: EBUSY ao renomear).
  let aberto = true;
  const fecharIndice = () => {
    if (!aberto) return;
    aberto = false;
    try {
      indice.exec('DETACH DATABASE base');
    } catch {
      // Ignorar: so importa na saida.
    }
    indice.close();
  };

  try {
    indice.pragma('journal_mode = WAL');
    indice.pragma('synchronous = NORMAL');
    indice.exec(SQL_TABELAS);
    indice.prepare('ATTACH DATABASE ? AS base').run(base);

    const marcado = lerControle(indice, 'atualizado_ate') || '';
    const totalChamados = indice.prepare('SELECT COUNT(*) AS total FROM base.tickets').get().total;
    const totalAcompanhamentos = indice
      .prepare('SELECT COUNT(*) AS total FROM base.followups')
      .get().total;

    // Sem alarme aqui: chamado novo e acompanhamento novo sao o caso NORMAL e nao
    // justificam refazer 618 MB de indice — eles entram pelo `date_mod`/`id` abaixo.
    // O que dispara reconstrucao e so o indice ficar com MAIS linhas que a base
    // (linhas orfas, que nenhum `date_mod` remove), e isso e conferido no fim.

    const inicio = Date.now();

    const lerChamado = indice.prepare(
      "SELECT id, name, content, raw_json ->> 'locations_id' AS local, groups FROM base.tickets WHERE id = ?"
    );
    // Numa tabela FTS5 normal o proprio texto fica guardado dentro dela, entao o
    // `DELETE` comum sabe remover os termos certos. (O comando 'delete' com os
    // valores antigos exigiria uma tabela-espelho e, nesta build do SQLite, devolve
    // "SQL logic error".)
    const apagarChamado = indice.prepare('DELETE FROM chamados WHERE rowid = ?');
    const gravarChamado = indice.prepare(
      'INSERT INTO chamados (rowid, titulo, descricao, local, grupo) VALUES (?, ?, ?, ?, ?)'
    );
    const lerAcomp = indice.prepare(
      'SELECT id, tickets_id, content FROM base.followups WHERE id = ?'
    );
    const apagarAcomp = indice.prepare('DELETE FROM acompanhamentos WHERE rowid = ?');
    const gravarAcomp = indice.prepare(
      'INSERT INTO acompanhamentos (rowid, tickets_id, conteudo) VALUES (?, ?, ?)'
    );

    indice.exec('BEGIN');
    try {
      const novosChamados = indice
        .prepare('SELECT id FROM base.tickets WHERE date_mod > ? ORDER BY id')
        .all(marcado);
      let feitos = 0;
      for (const alvo of novosChamados) {
        const linha = lerChamado.get(alvo.id);
        if (!linha) continue;
        apagarChamado.run(linha.id);
        gravarChamado.run(linha.id, linha.name, linha.content, linha.local, linha.grupo);
        feitos += 1;
      }
      if (feitos > 0) avisar(aoProgredir, `Indice: ${feitos} chamado(s) alterado(s) reindexado(s).`);

      const maiorIdMarcado = Number(lerControle(indice, 'maior_id_acompanhamento') || 0);
      const novosAcomp = indice
        .prepare('SELECT id FROM base.followups WHERE id > ? ORDER BY id')
        .all(maiorIdMarcado);
      let feitosAcomp = 0;
      for (const alvo of novosAcomp) {
        const linha = lerAcomp.get(alvo.id);
        if (!linha) continue;
        apagarAcomp.run(linha.id);
        gravarAcomp.run(linha.id, linha.tickets_id, linha.content);
        feitosAcomp += 1;
      }
      if (feitosAcomp > 0) {
        avisar(aoProgredir, `Indice: ${feitosAcomp} acompanhamento(s) novo(s) indexado(s).`);
      }

      // Solucoes e tarefas (Tarefa 87): mesmo diff por `id`, na faixa de rowid de
      // cada origem, com marcador proprio em `controle`.
      const lerSol = indice.prepare('SELECT id, tickets_id, content FROM base.solutions WHERE id = ?');
      const lerTarefa = indice.prepare('SELECT id, tickets_id, content FROM base.tasks WHERE id = ?');

      const maiorIdSolMarcado = Number(lerControle(indice, 'maior_id_solucao') || 0);
      const novasSols = indice
        .prepare('SELECT id FROM base.solutions WHERE id > ? ORDER BY id')
        .all(maiorIdSolMarcado);
      let feitosSol = 0;
      for (const alvo of novasSols) {
        const linha = lerSol.get(alvo.id);
        if (!linha) continue;
        const rowid = linha.id + OFFSET_SOLUCAO;
        apagarAcomp.run(rowid);
        gravarAcomp.run(rowid, linha.tickets_id, linha.content || '');
        feitosSol += 1;
      }
      if (feitosSol > 0) {
        avisar(aoProgredir, `Indice: ${feitosSol} solucao(oes) nova(s) indexada(s).`);
      }

      const maiorIdTarefaMarcado = Number(lerControle(indice, 'maior_id_tarefa') || 0);
      const novasTarefas = indice
        .prepare('SELECT id FROM base.tasks WHERE id > ? ORDER BY id')
        .all(maiorIdTarefaMarcado);
      let feitosTarefa = 0;
      for (const alvo of novasTarefas) {
        const linha = lerTarefa.get(alvo.id);
        if (!linha) continue;
        const rowid = linha.id + OFFSET_TAREFA;
        apagarAcomp.run(rowid);
        gravarAcomp.run(rowid, linha.tickets_id, linha.content || '');
        feitosTarefa += 1;
      }
      if (feitosTarefa > 0) {
        avisar(aoProgredir, `Indice: ${feitosTarefa} tarefa(s) nova(s) indexada(s).`);
      }

      const maiorData = indice.prepare('SELECT MAX(date_mod) AS data FROM base.tickets').get().data || '';
      const maiorIdAcomp = indice.prepare('SELECT MAX(id) AS id FROM base.followups').get().id || 0;
      const maiorIdSolFinal = indice.prepare('SELECT MAX(id) AS id FROM base.solutions').get().id || 0;
      const maiorIdTarefaFinal = indice.prepare('SELECT MAX(id) AS id FROM base.tasks').get().id || 0;
      gravarControle(indice, 'atualizado_ate', maiorData);
      gravarControle(indice, 'maior_id_acompanhamento', maiorIdAcomp);
      gravarControle(indice, 'maior_id_solucao', maiorIdSolFinal);
      gravarControle(indice, 'maior_id_tarefa', maiorIdTarefaFinal);
      indice.exec('COMMIT');

      // ---------- conferencia: sobrou ou faltou linha? ----------
      const noIndice = indice.prepare('SELECT COUNT(*) AS total FROM chamados').get().total;
      if (noIndice > totalChamados) {
        avisar(
          aoProgredir,
          `O indice tem ${noIndice} chamados e a base ${totalChamados}: ha linhas orfas. Refazendo...`
        );
        fecharIndice();
        return reconstruir(cfg);
      }

      if (noIndice < totalChamados) {
        // Faltam linhas — normalmente porque entraram chamados com `date_mod` antigo.
        // Se a quantidade for grande demais, so o servico pesado resolve.
        const faltando = indice
          .prepare(
            'SELECT t.id FROM base.tickets t LEFT JOIN chamados c ON c.rowid = t.id ' +
              'WHERE c.rowid IS NULL ORDER BY t.id'
          )
          .all();
        if (faltando.length > 1000) {
          avisar(aoProgredir, `Faltam ${faltando.length} chamados (limite 1000). Refazendo...`);
          fecharIndice();
          return reconstruir(cfg);
        }
        let repostos = 0;
        for (const alvo of faltando) {
          const linha = lerChamado.get(alvo.id);
          if (!linha) continue;
          gravarChamado.run(linha.id, linha.name, linha.content, linha.local, linha.grupo);
          repostos += 1;
        }
        feitos += repostos;
        if (repostos > 0) {
          avisar(aoProgredir, `Indice: ${repostos} chamado(s) que faltavam foram indexados.`);
        }
      }

      const totalIndiceFinal = indice.prepare('SELECT COUNT(*) AS total FROM chamados').get().total;
      const totalAcompFinal = indice.prepare('SELECT COUNT(*) AS total FROM acompanhamentos').get().total;
      indice.exec('BEGIN');
      gravarControle(indice, 'chamados_indexados', totalIndiceFinal);
      gravarControle(indice, 'acompanhamentos_indexados', totalAcompFinal);
      indice.exec('COMMIT');

      if (feitos > 0 || feitosAcomp > 0 || feitosSol > 0 || feitosTarefa > 0) {
        const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
        avisar(
          aoProgredir,
          `Indice atualizado em ${segundos}s (${feitos} chamado(s), ${feitosAcomp} acompanhamento(s), ` +
            `${feitosSol} solucao(oes), ${feitosTarefa} tarefa(s)).`
        );
      } else {
        avisar(aoProgredir, 'Indice de busca ja estava em dia.');
      }
    } catch (erro) {
      indice.exec('ROLLBACK');
      throw erro;
    }
  } finally {
    fecharIndice();
  }
  return { incremental: true };
}

/**
 * Ponto de entrada do script de sincronizacao: cria o indice se nao existir e, se
 * ja existir, atualiza so o que mudou. Nunca lanca — se o indice falhar, a
 * sincronizacao dos chamados continua e a busca cai no `LIKE`.
 */
function garantirIndice(opcoes) {
  const cfg = opcoes || {};
  try {
    const estado = estadoIndice();
    if (!estado.existe || !estado.pronto) {
      return { acao: 'reconstruido', detalhe: reconstruir(cfg) };
    }
    return { acao: 'atualizado', detalhe: atualizarIncremental(cfg) };
  } catch (erro) {
    const mensagem =
      `Nao foi possivel atualizar o indice de busca: ${erro.message}. ` +
      'A busca continua funcionando pelo metodo antigo.';
    avisar(cfg.aoProgredir, mensagem);
    return { acao: 'falhou', erro: mensagem };
  }
}

/**
 * As palavras que o usuario digitou, ja limpas para o FTS5: descarta o que viraria
 * operador (aspas, dois-pontos, asterisco, parenteses, hifen e circunflexo) e corta
 * em no maximo 6 termos.
 */
function palavrasDe(termo) {
  return String(termo || '')
    .split(/\s+/)
    .map((p) => p.replace(/["*():^\-]+/g, ' ').trim())
    .filter((p) => p.length >= 2)
    .slice(0, 6);
}

/**
 * Monta "termo"* — o asterisco e o prefixo, que faz "Julian" achar "Juliana".
 * Com varias palavras junta com AND; a interseccao de fato acontece palavra a
 * palavra em `buscar`, porque o AND do FTS5 so vale dentro de uma mesma linha.
 */
function montarConsulta(termo) {
  const palavras = palavrasDe(termo);
  if (palavras.length === 0) return null;
  return palavras.map((p) => `"${p}"*`).join(' AND ');
}

/**
 * Procura no indice e devolve os ids dos chamados, do mais relevante para o menos.
 *
 * Cada palavra e consultada SEPARADAMENTE em cada tabela e os resultados sao
 * INTERSECTADOS: o chamado tem de ter todas as palavras, mas cada uma pode estar
 * em um campo ou em um registro diferente — um AND direto no FTS5 exigiria tudo
 * na mesma linha (Tarefa 87). `acompanhamentos` junta followups, solucoes e
 * tarefas, entao a solucao e a propria tarefa entram na busca.
 *
 * Pesos do bm25: titulo 3, descricao 1, local 2, grupo 1,5. Nas origens de texto
 * livre vale o score melhor (mais negativo) de cada palavra e a pontuacao final
 * delas e a soma. Sem indice pronto, devolve `null`, e a rota usa o `LIKE`.
 */
function buscar(termo, limite) {
  const palavras = palavrasDe(termo);
  if (palavras.length === 0) return [];

  const estado = estadoIndice();
  if (!estado.existe || !estado.pronto) return null;

  const teto = limite || 50;
  // Teto de ids candidatos por palavra e por tabela.
  //
  // Tarefa 91: era 5000 e **ordenado por relevância (bm25)**, e isso escondia
  // chamado novo. Medido com "computador" (24.631 linhas casam): o teto de 5000
  // ficava só com os mais relevantes, e os chamados recentes — que têm a
  // palavra num acompanhamento longo, não no título — nunca entravam. Os 10
  // chamados abertos mais recentes com a palavra sumiam todos. O corte, quando
  // existe, é o **id decrescente** feito pela rota depois, então aqui o papel
  // deste teto é só não prender memória num termo patológico ("a", "de").
  const tetoPorPalavra = 50000;
  const db = new Database(caminhoIndice(), { readonly: true, fileMustExist: true });
  try {
    const porPalavra = [];

    for (const palavra of palavras) {
      const consulta = montarConsulta(palavra);
      const mapa = new Map();

      const dentroDoChamado = db
        .prepare(
          'SELECT rowid AS id, bm25(chamados, 3.0, 1.0, 2.0, 1.5) AS score ' +
            'FROM chamados WHERE chamados MATCH ? ORDER BY score LIMIT ?'
        )
        .all(consulta, tetoPorPalavra);
      for (const linha of dentroDoChamado) {
        const melhor = mapa.get(linha.id);
        if (!melhor || linha.score < melhor.score) {
          mapa.set(linha.id, { id: linha.id, score: linha.score });
        }
      }

      // Sem `GROUP BY` de propósito: as funções auxiliares do FTS5 (`bm25`) não podem
      // ser usadas dentro de agregação ("unable to use function bm25 in the requested
      // context"). A deduplicação por chamado é feita aqui em JavaScript.
      const emRegistro = db
        .prepare(
          'SELECT tickets_id AS id, bm25(acompanhamentos) AS score ' +
            'FROM acompanhamentos WHERE acompanhamentos MATCH ? ' +
            'ORDER BY score LIMIT ?'
        )
        .all(consulta, tetoPorPalavra);
      for (const linha of emRegistro) {
        if (linha.id == null) continue;
        const melhor = mapa.get(linha.id);
        if (!melhor || linha.score < melhor.score) {
          mapa.set(linha.id, { id: linha.id, score: linha.score });
        }
      }

      porPalavra.push(mapa);
      if (mapa.size === 0) return [];
    }

    // Interseccao: so seguem os chamados que aparecem em TODAS as palavras.
    let comuns = [...porPalavra[0].keys()];
    for (let i = 1; i < porPalavra.length && comuns.length > 0; i += 1) {
      const seguinte = porPalavra[i];
      comuns = comuns.filter((id) => seguinte.has(id));
    }
    if (comuns.length === 0) return [];

    // Pontuacao final: soma dos bm25 por palavra (bm25 vem negativo; quanto mais
    // negativo, melhor — por isso o sort crescente leva os melhores para o topo).
    const finais = comuns.map((id) => {
      let score = 0;
      for (const mapa of porPalavra) {
        const parcial = mapa.get(id);
        if (parcial) score += parcial.score;
      }
      return { id, score };
    });

    return finais.sort((a, b) => a.score - b.score).slice(0, teto);
  } finally {
    db.close();
  }
}

/**
 * Ids dos chamados cuja **localizacao** contem a sigla (Tarefa 112).
 *
 * A coluna `local` do indice guarda a localizacao crua do GLPI, com a hierarquia
 * inteira: "Secretaria Municipal de Cultura e Turismo - SMCT &#62; Biblioteca ...".
 * Por isso aqui sai **tudo** que tem a sigla, com ou sem segundo nivel — quem
 * decide se o resumo e exatamente a sigla e a rota, que ja tem
 * `resumirLocalizacao` e le a localizacao de cada candidato.
 *
 * Sem indice pronto devolve `null`, para a rota cair no `LIKE` da base.
 */
function buscarPorLocal(sigla, limite, comLocal) {
  const estado = estadoIndice();
  if (!estado.existe || !estado.pronto) return null;
  if (!sigla) return [];

  // Filtro de coluna do FTS5: `{local} : termo`. O prefixo `*` pega "SMCT" e
  // variantes com sufixo, e as entidades HTML (`&#62;`) viram tokens separados,
  // entao a hierarquia nao atrapalha.
  //
  // `ORDER BY rowid DESC` (rowid = id do ticket) com o teto em 20000: sem ordem o
  // FTS5 entrega na ordem do indice, e numa secretaria grande (SMSA tem muito
  // mais de 20 mil chamados com a sigla em qualquer nivel) o corte pegaria os
  // mais antigos e o chamado novo da sigla **isolada** nunca entraria — o mesmo
  // defeito que a T91 corrigiu na busca por texto. Medido: SMSA estourava o teto.
  //
  // `comLocal` traz a propria coluna `local` junto do id (Tarefa 112). Ler a
  // hierarquia da base de 1,4 GB custava 5,6 s na SMSA; pelo indice são ~40 ms,
  // porque a coluna ja esta materializada e nao precisa abrir o `raw_json`.
  const consulta = `{local} : "${String(sigla).replace(/"/g, '')}"*`;
  const colunas = comLocal ? 'rowid AS id, local AS local' : 'rowid AS id';
  const db = new Database(caminhoIndice(), { readonly: true, fileMustExist: true });
  try {
    const linhas = db
      .prepare(
        `SELECT ${colunas} FROM chamados WHERE chamados MATCH ? ORDER BY rowid DESC LIMIT ?`
      )
      .all(consulta, limite || 20000);
    return linhas;
  } finally {
    db.close();
  }
}

module.exports = {
  VERSAO_INDICE,
  caminhoBase,
  caminhoIndice,
  estadoIndice,
  reconstruir,
  atualizarIncremental,
  garantirIndice,
  montarConsulta,
  buscar,
  buscarPorLocal,
};
