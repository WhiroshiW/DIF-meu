import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { bloquearSemSessao } from '@/lib/sessao';
import { buscar as buscarNoIndice, buscarPorLocal as buscarPorLocalNoIndice } from '@/lib/indiceGlpi';
import {
  getCaminhoDbGlpi,
  extrairSolicitante,
  resumirLocalizacao,
  departamentosDaBase,
  type ChamadoListaItem,
} from '@/lib/glpiChamados';
import { interpretarTermo } from '@/lib/secretarias';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Abaixo disso a busca não sai: 3 letras casariam em quase tudo da base. */
const MINIMO_CARACTERES = 4;

/**
 * Quantos chamados a rota devolve.
 *
 * Com o índice (FTS5) a consulta é de milissegundos e o teto é só de tela. Sem o
 * índice, a busca cai no `LIKE`, que folheia a base inteira (1,4 GB): aí o teto
 * também ajuda, porque o banco para de varrer assim que encontra o tanto.
 */
const LIMITE_RESULTADOS = 50;

/**
 * Quantos candidatos o índice devolve **antes** do corte por data (Tarefa 91).
 *
 * A busca geral tem de trazer **todos** os chamados, de qualquer departamento e
 * de qualquer status, e o que decide o que fica na tela é a data: id decrescente.
 * Se o índice devolvesse já os 50 mais relevantes, os chamados **novos** ficariam
 * de fora — foi exatamente o defeito reportado: "computador" não trazia os
 * abertos recentes que aparecem nos cards. Medido: os 10 abertos mais recentes
 * com a palavra estavam todos fora do top-50 por relevância.
 *
 * Por isso o índice devolve um conjunto grande, a rota ordena por id decrescente
 * e só então corta em `LIMITE_RESULTADOS`. Este teto existe só para não varrer a
 * base inteira num termo patológico ("de", "a") e estourar memória.
 */
const LIMITE_CANDIDATOS = 20000;

/** Linha da base devolvida pela busca por título/descrição. */
type LinhaBusca = {
  id: number;
  name: string | null;
  content: string | null;
  groups: string | null;
  locations_id: string | null;
  /** Status do GLPI — usado na barrinha de cor do item (Tarefa 90). */
  status: number;
};

/**
 * Escapa os curingas do LIKE para que o termo digitado seja literal: sem isto,
 * um "%" digitado pelo usuário viraria "qualquer coisa" na consulta.
 */
function escaparParaLike(termo: string): string {
  return termo.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}

/** A palavra é só dígitos? Aí pode ser o **id** de um chamado (Tarefa 89). */
function ehNumero(palavra: string): boolean {
  return /^\d+$/.test(palavra);
}

/**
 * Ids dos chamados cuja localização é **exatamente** a sigla (Tarefa 112).
 *
 * "SMCT" entra; "SMCT - Biblioteca Municipal" **não**. A distinção é feita pelo
 * mesmo `resumirLocalizacao` que monta o texto mostrado no item, então a busca e
 * a tela não podem divergir.
 *
 * Os candidatos vêm do índice FTS5 (coluna `local`); sem índice, de um `LIKE`
 * em `raw_json ->> 'locations_id'`. Nos dois casos a decisão final é em
 * JavaScript, lendo a localização de cada candidato — é o que garante a regra
 * "sigla sozinha" sem reescrever a regra de hierarquia em SQL.
 */
function idsDaSigla(
  db: Database.Database,
  sigla: string,
  limite: number
): number[] {
  let candidatos: Array<{ id: number; local?: string }> | null = null;
  try {
    // `true` = traz a coluna `local` do índice junto do id. Medido na base real:
    // ler a hierarquia pela base de 1,4 GB leva ~490 ms na SMSA e ~35 ms na
    // SMCT; pelo índice são ~190 ms e ~35 ms, com o **mesmo** conjunto de ids
    // (conferido nos 4 casos). O índice já materializa a localização, então
    // não precisa abrir o `raw_json` de 20 mil linhas.
    candidatos = buscarPorLocalNoIndice(sigla, limite, true);
  } catch {
    candidatos = null;
  }

  let linhas: Array<{ id: number; locations_id: string | null }> = [];
  if (candidatos === null) {
    // Sem índice: `LIKE` na base, já em id decrescente (o mais novo primeiro, como
    // em todos os caminhos).
    const doLike = db
      .prepare(
        `SELECT id, raw_json ->> 'locations_id' AS locations_id FROM tickets
          WHERE raw_json ->> 'locations_id' LIKE ? ESCAPE '\\'
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(`%${escaparParaLike(sigla)}%`, limite) as Array<{
      id: number;
      locations_id: string | null;
    }>;
    linhas = doLike;
  } else {
    linhas = candidatos.map((candidato) => ({
      id: candidato.id,
      locations_id: candidato.local ?? null,
    }));
  }

  if (linhas.length === 0) return [];

  return linhas
    .filter((linha) => resumirLocalizacao(linha.locations_id) === sigla)
    .map((linha) => linha.id);
}

/** GET /api/glpi/busca?termo=... → chamados com o termo em qualquer lugar. */
export async function GET(request: Request) {
  // Tarefa 74: a busca varre a base inteira do GLPI. Exige sessão, como o painel.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const termo = (new URL(request.url).searchParams.get('termo') ?? '').trim();
  // T112: o termo é lido antes de virar consulta — uma palavra que seja o **nome
  // de uma secretaria** ("cultura") vira o filtro de localização pela sigla, e
  // some da busca por texto (ver `interpretarTermo`).
  const leitura = interpretarTermo(termo);
  const siglaAlvo = leitura.sigla;
  const palavrasTermo = leitura.palavras;
  const soNumeros = palavrasTermo.length > 0 && palavrasTermo.every(ehNumero);

  // Resposta vazia enquanto o termo não chega ao mínimo: evita varrer a base à toa.
  //
  // Tarefa 89: um termo **só de números** é dispensado do mínimo a partir de 1
  // dígito. Ele vira uma consulta pela chave primária (`tickets.id`), a mais barata
  // que existe — nada de varrer 1,4 GB. Sem isso, o chamado 5 ou o 47 nunca seriam
  // acháveis, porque o mínimo é 4 caracteres.
  //
  // T112: a sigla tem o mesmo tratamento — `SMH` tem 3 letras, e a consulta de
  // localização é uma leitura do índice, não uma varredura da base.
  if (termo.length < MINIMO_CARACTERES && !soNumeros && !siglaAlvo) {
    return NextResponse.json({ resultados: [], minimo: MINIMO_CARACTERES });
  }

  try {
    const db = new Database(getCaminhoDbGlpi(), { readonly: true, fileMustExist: true });

    try {
      // ==================== 0) Separar NÚMEROS de TEXTO (Tarefa 89) ====================
      //
      // Até aqui a busca por texto nunca trazia o chamado pelo próprio número. O
      // número do chamado não é palavra: ele não está no título, na descrição, no
      // grupo, no acompanhamento, na tarefa nem na solução — então tanto o índice
      // (que só guarda texto) quanto o `LIKE` (idem) não casavam. Digitar `112954`
      // devolvia "nenhum chamado encontrado" mesmo com o chamado de id 112954
      // existindo. Medido no índice real: `buscar('112954')` → 0 resultados.
      //
      // A saída é separar o termo: os **números** viram busca por chave primária
      // (o índice mais rápido que existe) e as **palavras** vão para o índice de
      // texto. Assim "112954 cabo" acha o chamado 112954 cujo texto tem "cabo",
      // em vez de não achar nada.
      const numerosDoTermo = palavrasTermo.filter(ehNumero);
      const textoDoTermo = palavrasTermo.filter((p) => !ehNumero(p)).join(' ');

      // Ids dos chamados cujos **números** foram digitados (vários de uma vez:
      // "112954 10245" traz os dois). `idsPorNumero` fica vazio quando não houve
      // número, para não restringir a busca por texto.
      let idsPorNumero: number[] | null = null;
      if (numerosDoTermo.length > 0) {
        const numeros = numerosDoTermo
          .map((p) => Number(p))
          .filter((n) => Number.isSafeInteger(n) && n > 0);
        idsPorNumero =
          numeros.length > 0
            ? (
                db
                  .prepare(
                    `SELECT id FROM tickets WHERE id IN (${numeros.map(() => '?').join(',')})`
                  )
                  .all(...numeros) as Array<{ id: number }>
              ).map((linha) => linha.id)
            : [];
      }

      // ==================== 1) Descobrir QUAIS chamados casam ====================
      //
      // Caminho preferred: o índice FTS5 (Tarefa 85). Resolve em milissegundos,
      // aceita várias palavras ("nome palavra local"), ignora acento e devolve na
      // ordem de relevância. `buscar()` devolve `null` quando ainda não há índice.
      let ids: number[] | null = null;
      let usouIndice = false;

      // T112: a sigla da secretaria entra como **filtro de localização**, não como
      // palavra de texto. Ela pode vir sozinha ("cultura") ou junto de outras
      // palavras ("cultura biblioteca"), e neste segundo caso o resultado é a
      // interseção: os dois precisam casar.
      const idsPorSigla = siglaAlvo ? idsDaSigla(db, siglaAlvo, LIMITE_CANDIDATOS) : null;

      if (textoDoTermo.length > 0) {
        try {
          // T89: só as palavras de texto vão para o índice — o número do chamado
          // não está indexado e zeraria a busca.
          const encontrados = buscarNoIndice(textoDoTermo, LIMITE_CANDIDATOS);
          if (encontrados !== null) {
            ids = encontrados.map((c) => c.id);
            usouIndice = true;
          }
        } catch {
          // Índice quebrado: segue para o LIKE em vez de falhar a busca.
          ids = null;
        }

        // T89: com número **e** texto ("112954 cabo"), o número manda e o texto
        // só confirma — fica a interseção. Se o texto não casar com aquele
        // chamado, o número sozinho é mais útil do que uma lista vazia.
        if (ids !== null && idsPorNumero !== null) {
          const pedidos = new Set(idsPorNumero);
          const filtrados = ids.filter((id) => pedidos.has(id));
          ids = filtrados.length > 0 ? filtrados : [...idsPorNumero];
        }
      } else if (idsPorNumero !== null) {
        // T89: não há palavra de texto, então o índice não foi consultado e `ids`
        // segue nulo. A resposta é a lista dos números pedidos ("112954 10245").
        ids = [...idsPorNumero];
      }

      // T112: palavra de secretaria **sem** nenhuma outra palavra — a resposta são
      // os chamados da sigla isolada. Sem este desvio, `textoDoTermo` estaria
      // vazio e a busca por texto não reduziria nada, vindo o campo `local` do
      // índice com a hierarquia inteira ("SMCT > Biblioteca…").
      //
      // Só quando não há palavra de texto: se há, o caminho sem índice (o `LIKE`
      // abaixo) ainda precisa rodar, e a sigla entra como interseção no fim.
      if (ids === null && idsPorSigla !== null && textoDoTermo.length === 0) {
        ids = [...idsPorSigla];
      } else if (ids !== null && idsPorSigla !== null) {
        // Sigla + texto: os dois precisam casar.
        const daSigla = new Set(idsPorSigla);
        const filtrados = ids.filter((id) => daSigla.has(id));
        ids = filtrados;
      }

      if (ids === null) {
        // Sem índice: o método antigo, palavra por palavra — a MESMA cobertura do
        // índice (título, descrição, grupo, acompanhamento, tarefa e solução). O AND
        // vale entre palavras dentro de cada tabela e os ids das tabelas são unidos,
        // para achar termos espalhados por registros diferentes (Tarefa 87).
        // T89: aqui entram **só as palavras de texto**. As numéricas já foram
        // resolvidas por chave primária no passo 0; mandá-las para o `LIKE`
        // não encontraria nada (o número não está em nenhum dos campos).
        const palavras = palavrasTermo
          .filter((p) => !ehNumero(p))
          .slice(0, 6)
          .map((p) => `%${escaparParaLike(p)}%`);

        // T89: sem texto nenhum o `LIKE` não tem condição possível (juntar zero
        // palavras viraria um `WHERE ` vazio); a resposta são os números pedidos.
        if (palavras.length === 0) {
          ids = idsPorNumero ? [...idsPorNumero] : [];
        } else {
          const condicoes = (colunas: string[]) =>
            palavras
              .map(
                (valor) =>
                  `(${colunas.map((coluna) => `${coluna} LIKE ? ESCAPE '\\'`).join(' OR ')})`
              )
              .join(' AND ');
          const parametros = (colunas: string[]) =>
            palavras.flatMap((valor) => colunas.map(() => valor));

          const colunasDoChamado = ['name', 'content', 'groups'];
          const consultas = [
            {
              sql: `SELECT id AS id FROM tickets WHERE ${condicoes(colunasDoChamado)} LIMIT ?`,
              params: parametros(colunasDoChamado),
            },
            {
              sql: `SELECT tickets_id AS id FROM followups WHERE ${condicoes(['content'])} LIMIT ?`,
              params: parametros(['content']),
            },
            {
              sql: `SELECT tickets_id AS id FROM solutions WHERE ${condicoes(['content'])} LIMIT ?`,
              params: parametros(['content']),
            },
            {
              sql: `SELECT tickets_id AS id FROM tasks WHERE ${condicoes(['content'])} LIMIT ?`,
              params: parametros(['content']),
            },
          ];

          const vistos = new Set<number>();
          for (const consulta of consultas) {
            // T91: teto de candidatos maior que o da tela, pelo mesmo motivo do
            // índice — cortar aqui por 50 traria os 50 primeiros que o banco
            // encontrasse (sem ordem nenhuma), não os 50 mais recentes.
            const linhas = db.prepare(consulta.sql).all(
              ...consulta.params,
              LIMITE_CANDIDATOS
            ) as Array<{ id: number }>;
            for (const linha of linhas) vistos.add(linha.id);
          }
          // T89: mais recentes primeiro: no histórico de 113 mil, o que interessa é o
          // que aconteceu por último. E a ordem é a mesma em todos os caminhos.
          ids = [...vistos].sort((a, b) => b - a).slice(0, LIMITE_RESULTADOS);

          // T89: com número **e** texto, o número manda: fica a interseção.
          if (idsPorNumero !== null) {
            const pedidos = new Set(idsPorNumero);
            const filtrados = ids.filter((id) => pedidos.has(id));
            // O texto não casou com aquele chamado: o número sozinho é a resposta
            // mais útil do que uma lista vazia.
            ids = filtrados.length > 0 ? filtrados : [...idsPorNumero];
          }

          // T112: no caminho sem índice a sigla ainda não foi aplicada (a linha de
          // interseção antes do `if (ids === null)` só roda quando o índice
          // respondeu). Aqui ela entra como filtro, sem exceção de fallback.
          if (idsPorSigla !== null) {
            const daSigla = new Set(idsPorSigla);
            ids = ids.filter((id) => daSigla.has(id));
          }
        }
      }

      if (ids.length === 0) {
        return NextResponse.json({ resultados: [], minimo: MINIMO_CARACTERES, indice: usouIndice });
      }

      // Tarefa 89: **ordem decrescente de id**, o mesmo em todos os caminhos. O
      // índice FTS5 devolvia por relevância (bm25) e o `LIKE` por ordem de
      // tabelas; aqui os dois viram a mesma lista — do chamado mais novo (id
      // maior) no topo ao mais antigo descendo. Como o id cresce a cada chamado
      // aberto, "id decrescente" e "mais recente primeiro" são a mesma coisa.
      ids = [...ids].sort((a, b) => b - a).slice(0, LIMITE_RESULTADOS);

      // ==================== 2) Trazer os DETALHES dos chamados achados ====================
      // Busca por chave primática: rápido mesmo com o índice, e sem índice só
      // precisa ler as dezenas de linhas que casaram.
      const marcadores = ids.map(() => '?').join(',');
      const achados = db
        .prepare(
          `SELECT id, name, content, groups, status, raw_json ->> 'locations_id' AS locations_id
             FROM tickets
            WHERE id IN (${marcadores})`
        )
        .all(...ids) as LinhaBusca[];
      const porId = new Map(achados.map((linha) => [linha.id, linha]));
      const ordenados = ids.map((id) => porId.get(id)).filter((linha): linha is LinhaBusca => Boolean(linha));

      // Acompanhamentos novos só dos chamados exibidos (mesma técnica do dashboard).
      const naoVistos = new Map<number, number>();
      if (ordenados.length > 0) {
        const marcadores = ordenados.map(() => '?').join(',');
        const contagens = db
          .prepare(
            `SELECT tickets_id, COUNT(*) AS total
               FROM followups
              WHERE visto = 0 AND tickets_id IN (${marcadores})
              GROUP BY tickets_id`
          )
          .all(...ordenados.map((t) => t.id)) as Array<{ tickets_id: number; total: number }>;
        for (const contagem of contagens) naoVistos.set(contagem.tickets_id, contagem.total);
      }

      const resultados: ChamadoListaItem[] = ordenados.map((linha) => ({
        id: linha.id,
        titulo: String(linha.name ?? '').trim(),
        solicitante: extrairSolicitante(linha.content),
        localizacao: resumirLocalizacao(linha.locations_id),
        nao_vistos: naoVistos.get(linha.id) ?? 0,
        departamentos: departamentosDaBase(linha.groups),
        status: linha.status, // T90: barrinha de cor do status na lateral do item
      }));

      return NextResponse.json({
        resultados,
        minimo: MINIMO_CARACTERES,
        /** `indice: true` = resolvido pelo FTS5; `false` = caiu no LIKE antigo. */
        indice: usouIndice,
      });
    } finally {
      db.close();
    }
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : 'erro desconhecido';
    return NextResponse.json({ erro: `Falha na busca: ${mensagem}`, resultados: [] }, { status: 500 });
  }
}
