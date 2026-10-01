import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { bloquearSemSessao } from '@/lib/sessao';
import {
  getCaminhoDbGlpi,
  decodificarHtml,
  extrairSolicitante,
  resumirLocalizacao,
  normalizarDepartamento,
  extrairDepartamento,
  departamentosDaBase,
  type ChamadoListaItem,
} from '@/lib/glpiChamados';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 60; // Cache por 60 segundos para não consultar o banco a cada requisição

/**
 * Caminho do banco local do GLPI (snapshot).
 * Tarefa 84: a função passou para `lib/glpiChamados.ts`, agora compartilhada com a
 * rota da busca geral. Aqui continua o mesmo alias, para não mexer em quem chama.
 */
const getCaminhoDb = getCaminhoDbGlpi;

/** Linha mínima da base filtrada (uma única passada `status <> 6`, depto em JS). */
type LinhaBaseDepartamento = {
  id: number;
  name: string | null;
  content: string | null;
  status: number;
  date_mod: string | null;
  /** Data de criação do chamado no GLPI (coluna `date`), em "AAAA-MM-DD HH:MM:SS". */
  data_criacao: string | null;
  solvedate: string | null;
  motivo_pendencia: string | null;
  groups: string | null;
  locations_id: string | null;
};

/** Data local atual em AAAA-MM-DD (equivale a `date('now','localtime')` do SQLite). */
function hojeLocalIso(): string {
  const agora = new Date();
  const aaaa = agora.getFullYear();
  const mm = String(agora.getMonth() + 1).padStart(2, '0');
  const dd = String(agora.getDate()).padStart(2, '0');
  return `${aaaa}-${mm}-${dd}`;
}

/** Ordem fixa da faixa larga "Chamados abertos" (mostra 0 quando zerado). */
const ORDEM_DEPARTAMENTOS = ['Triagem', 'N1', 'N2', 'N3', 'Manutenção', 'Externo', 'Estoque'] as const;

/**
 * Status do GLPI que significam "ainda não solucionado". O 6 é o de solucionado.
 *
 * Importa estar **escrito como lista**, e não como `status <> 6`: com o operador `<>` o
 * SQLite desiste de usar o índice `idx_tickets_status` e varre a tabela inteira (medido:
 * 683 ms com varredura contra **10 ms** usando o índice, na mesma base de 113 mil
 * chamados). Na lista, o banco vai direto nas linhas de cada status.
 *
 * Consequência: se o GLPI passar a usar um status novo fora desta lista, ele precisa ser
 * acrescentado aqui, senão os chamados nele não entram como "abertos".
 */
const STATUS_NAO_SOLUCIONADOS = [1, 2, 3, 4, 5] as const;

/** Colunas que o painel precisa, com a localização extraída do JSON do GLPI. */
const SQL_COLUNAS_DO_PAINEL = `id, name, content, status, date_mod, date AS data_criacao, solvedate, motivo_pendencia, groups,
                               raw_json ->> 'locations_id' AS locations_id`;

/** Só os chamados do Dpto Suporte Técnico (o grupo, no GLPI, é uma árvore de nomes). */
const CONDICAO_DEPARTAMENTO = `groups LIKE '%dpto suporte técnico%'`;

/**
 * Base do painel, em **duas consultas** (Tarefa 81), como o usuário propôs:
 *
 * 1. todos os chamados **não solucionados** do departamento (usa `idx_tickets_status`);
 * 2. os chamados do departamento **solucionados hoje** (usa `idx_tickets_date_mod`;
 *    `date_mod >= hoje` funciona porque a coluna guarda data e hora em texto
 *    "AAAA-MM-DD HH:MM:SS", e não há data futura na base).
 *
 * A ideia de "pesquisar de trás pra frente" ficou dispensada: com o índice, o banco já
 * salta direto para as linhas de cada status e para o dia de hoje — não há varredura
 * para "andar" de trás para frente. O que importa é que **nenhum chamado é mais
 * descartado por ser antigo**: a versão anterior usava uma janela de 3000 ids, e um
 * chamado aberto de id baixo simplesmente sumia do painel.
 *
 * As duas listas podem ter um chamado em comum (não solucionado *e* solucionado hoje
 * não é possível, mas o filtro é por `solvedate`, então a interseção é removida pelo
 * `Map` por id). Regra preservada da Tarefa 42: entra quem não está solucionado **ou**
 * quem tem `solvedate` de hoje.
 */
function carregarBaseDepartamento(db: Database.Database): LinhaBaseDepartamento[] {
  const hoje = hojeLocalIso();
  const marcadores = STATUS_NAO_SOLUCIONADOS.map(() => '?').join(',');

  const abertos = db
    .prepare(
      `SELECT ${SQL_COLUNAS_DO_PAINEL}
         FROM tickets
        WHERE status IN (${marcadores}) AND ${CONDICAO_DEPARTAMENTO}`
    )
    .all(...STATUS_NAO_SOLUCIONADOS) as LinhaBaseDepartamento[];

  const solucionadosHoje = db
    .prepare(
      `SELECT ${SQL_COLUNAS_DO_PAINEL}
         FROM tickets
        WHERE date_mod >= ? AND substr(solvedate, 1, 10) = ? AND ${CONDICAO_DEPARTAMENTO}`
    )
    .all(hoje, hoje) as LinhaBaseDepartamento[];

  const porId = new Map<number, LinhaBaseDepartamento>();
  for (const linha of abertos.concat(solucionadosHoje)) {
    if (!porId.has(linha.id)) porId.set(linha.id, linha);
  }

  return [...porId.values()];
}

/**
 * Contagem de chamados abertos (status <> 5 e <> 6) do Dpto Suporte Técnico agrupados
 * por subdepartamento. Extrai apenas o nome do departamento (último segmento após o último "> "),
 * ex.: "Superintendência de TI > Dpto Suporte Técnico > Manutenção" → "Manutenção".
 * Um chamado com grupos em mais de um subdepartamento aparece em cada um deles.
 */
function contarAbertosPorDepartamento(base: LinhaBaseDepartamento[]): Array<{ departamento: string; total: number }> {
  const contagem: Record<string, number> = {};
  for (const d of ORDEM_DEPARTAMENTOS) contagem[d] = 0;
  for (const t of base) {
    if (t.status === 5 || t.status === 6) continue;
    if (!t.groups) continue;
    let grupos: Array<{ name?: unknown }> = [];
    try {
      const parsed = JSON.parse(t.groups) as Array<{ name?: unknown }>;
      if (Array.isArray(parsed)) grupos = parsed;
    } catch {
      continue;
    }
    const nomes = new Set<string>();
    for (const g of grupos) {
      const nome = String(g && g.name ? g.name : '');
      if (!nome.toLowerCase().includes('dpto suporte técnico')) continue;
      const rotulo = normalizarDepartamento(extrairDepartamento(nome));
      if (rotulo) nomes.add(rotulo);
    }
    for (const d of nomes) contagem[d] = (contagem[d] || 0) + 1;
  }
  return ORDEM_DEPARTAMENTOS.map((departamento) => ({ departamento, total: contagem[departamento] }));
}

/** Soma total de chamados abertos do Dpto Suporte Técnico (status diferente de 5 e 6). */
function contarAbertos(base: LinhaBaseDepartamento[]): number {
  return base.filter((t) => t.status !== 5 && t.status !== 6).length;
}

/**
 * Contagem de chamados com um determinado motivo de pendência (status 4)
 * no Dpto Suporte Técnico.
 */
function contarPorMotivo(base: LinhaBaseDepartamento[], motivo: string): number {
  return base.filter((t) => t.status === 4 && (t.motivo_pendencia ?? '') === motivo).length;
}

/** Verifica se o chamado pertence ao grupo Manutenção do Dpto Suporte Técnico. */
function pertenceManutencao(t: LinhaBaseDepartamento): boolean {
  if (!t.groups) return false;
  try {
    const grupos = JSON.parse(t.groups) as Array<{ name?: unknown }>;
    if (!Array.isArray(grupos)) return false;
    return grupos.some((g) => {
      const nome = String(g && g.name ? g.name : '');
      return (
        nome.toLowerCase().includes('dpto suporte técnico') &&
        normalizarDepartamento(extrairDepartamento(nome)) === 'Manutenção'
      );
    });
  } catch {
    return false;
  }
}

/**
 * Contagem dos chamados abertos do grupo Manutenção que NÃO estão pendentes
 * (abertos = status <> 5 e <> 6, excluindo status 4).
 */
function contarFilaManutencao(base: LinhaBaseDepartamento[]): number {
  return base.filter((t) => t.status !== 5 && t.status !== 6 && t.status !== 4 && pertenceManutencao(t)).length;
}

/**
 * Departamentos (rótulos fixos) de um chamado do Dpto Suporte Técnico.
 * Tarefa 84: a extração em si foi para `lib/glpiChamados.ts` (`departamentosDaBase`);
 * aqui fica só o atalho que recebe a linha inteira.
 */
function departamentosDoChamado(t: LinhaBaseDepartamento): string[] {
  return departamentosDaBase(t.groups);
}

/**
 * Listas separadas por departamento, nos 7 rótulos fixos (Tarefa 101). O `filtro`
 * decide o que entra em cada lista; as chaves são sempre as de
 * `ORDEM_DEPARTAMENTOS`, então um chamado que também esteja em
 * Infraestrutura/Sistemas/Suporte SMED não cria lista nova — é o mesmo cuidado da
 * faixa (T88). A da faixa de abertos (T41) virou uma chamada desta.
 */
function listarPorDepartamento(
  base: LinhaBaseDepartamento[],
  naoVistos: Map<number, number>,
  filtro: (t: LinhaBaseDepartamento) => boolean
): Record<string, ChamadoPendenteLista[]> {
  const listas: Record<string, ChamadoPendenteLista[]> = {};
  for (const departamento of ORDEM_DEPARTAMENTOS) listas[departamento] = [];
  for (const t of base) {
    if (!filtro(t)) continue;
    const item = {
      id: t.id,
      titulo: String(t.name ?? '').trim(),
      solicitante: extrairSolicitante(t.content),
      localizacao: resumirLocalizacao(t.locations_id),
      nao_vistos: naoVistos.get(t.id) ?? 0,
      departamentos: departamentosDoChamado(t),
      status: t.status,
      // T101: o card "Pendente" da Manutenção separa pendente SEM motivo
      // (que não cai em Retirada nem em Equipamento).
      motivo_pendencia: t.motivo_pendencia,
    };
    for (const departamento of departamentosDoChamado(t)) {
      if (listas[departamento]) listas[departamento].push(item);
    }
  }
  for (const departamento of ORDEM_DEPARTAMENTOS) listas[departamento].sort(ordenarPorLocalizacao);
  return listas;
}

/**
 * Chamados abertos por departamento (ordem fixa da faixa).
 * (Tarefa 41 — alimenta um modal por quadrado da faixa "Chamados abertos")
 */
function listarAbertosPorDepartamento(
  base: LinhaBaseDepartamento[],
  naoVistos: Map<number, number>
): Record<string, ChamadoPendenteLista[]> {
  return listarPorDepartamento(base, naoVistos, (t) => t.status !== 5 && t.status !== 6);
}

/**
 * Lista de TODOS os chamados abertos do Dpto Suporte Técnico (status <> 5 e <> 6),
 * no mesmo padrão das listas dos cards (id + título + solicitante + localização).
 * (Tarefa 40 — alimenta o modal aberto pelo número do primeiro card)
 */
function listarAbertos(base: LinhaBaseDepartamento[], naoVistos: Map<number, number>): ChamadoPendenteLista[] {
  return base
    .filter((t) => t.status !== 5 && t.status !== 6)
    .map((l) => ({
      id: l.id,
      titulo: String(l.name ?? '').trim(),
      solicitante: extrairSolicitante(l.content),
      localizacao: resumirLocalizacao(l.locations_id),
      nao_vistos: naoVistos.get(l.id) ?? 0,
      departamentos: departamentosDoChamado(l),
      status: l.status, // T90: barrinha de cor do status na lateral do item
    }))
    .sort(ordenarPorLocalizacao);
}

/**
 * Lista dos chamados abertos do grupo Manutenção que NÃO estão pendentes,
 * mesmo padrão dos outros cards (id + título + solicitante + localização).
 */
function listarFilaManutencao(base: LinhaBaseDepartamento[], naoVistos: Map<number, number>): ChamadoPendenteLista[] {
  return base
    .filter((t) => t.status !== 5 && t.status !== 6 && t.status !== 4 && pertenceManutencao(t))
    .map((l) => ({
      id: l.id,
      titulo: String(l.name ?? '').trim(),
      solicitante: extrairSolicitante(l.content),
      localizacao: resumirLocalizacao(l.locations_id),
      nao_vistos: naoVistos.get(l.id) ?? 0,
      departamentos: departamentosDoChamado(l),
      status: l.status, // T90: barrinha de cor do status na lateral do item
    }))
    .sort(ordenarPorLocalizacao);
}

/**
 * Lista dos chamados do Dpto Suporte Técnico com um determinado motivo de pendência
 * (status 4), para exibição na lista abaixo do card correspondente no dashboard.
 */
function listarPorMotivo(base: LinhaBaseDepartamento[], motivo: string, naoVistos: Map<number, number>): ChamadoPendenteLista[] {
  return base
    .filter((t) => t.status === 4 && (t.motivo_pendencia ?? '') === motivo)
    .map((l) => ({
      id: l.id,
      titulo: String(l.name ?? '').trim(),
      solicitante: extrairSolicitante(l.content),
      localizacao: resumirLocalizacao(l.locations_id),
      nao_vistos: naoVistos.get(l.id) ?? 0,
      departamentos: departamentosDoChamado(l),
      status: l.status, // T90: barrinha de cor do status na lateral do item
    }))
    .sort(ordenarPorLocalizacao);
}

/**
 * Diz se o chamado entra na contagem de "solucionados hoje" (Tarefa 103).
 *
 * Regra do GLPI: status 5 (solucionado) ou 6 (fechado) com `solvedate` de hoje.
 * Fechado hoje mas solucionado em outro dia fica fora.
 *
 * A regra morava duplicada em `contarSolucionadosHoje` e `listarSolucionadosHoje`;
 * agora é esta função que as três chamam, para não divergirem entre si.
 */
function ehSolucionadoHoje(t: LinhaBaseDepartamento, hoje: string): boolean {
  if (t.status !== 5 && t.status !== 6) return false;
  if (t.status === 6) return (t.solvedate ?? '').slice(0, 10) === hoje;
  const fonte = t.solvedate ?? t.date_mod ?? '';
  return fonte.slice(0, 10) === hoje;
}

/** Números resumidos de um departamento, mostrados ao lado do total nos cards. */
type ResumoDepartamento = {
  /** Abertos (status diferente de 5 e 6) — é o número grande do card. */
  abertos: number;
  /** Desses abertos, quantos estão pendentes (status 4). */
  pendentes: number;
  /** Solucionados hoje (status 5, ou 6-fechado com `solvedate` de hoje). */
  solucionados_hoje: number;
  /**
   * Abertos hoje = criados hoje (coluna `date`). Como o chamado nasce na Triagem e
   * depois é repassado ao departamento, a Triagem costuma mostrar 0 aqui e quem
   * recebe mostra o chamado.
   */
  abertos_hoje: number;
};

/**
 * Resumo por departamento para os cards do painel (Tarefa 103). Só contagem, sem
 * lista — assim não pesa o JSON nem o DOM. Chamado em dois departamentos entra
 * nos dois resumos, como nas listas.
 */
function resumoPorDepartamento(base: LinhaBaseDepartamento[]): Record<string, ResumoDepartamento> {
  const hoje = hojeLocalIso();
  const resumo: Record<string, ResumoDepartamento> = {};
  for (const departamento of ORDEM_DEPARTAMENTOS) {
    resumo[departamento] = { abertos: 0, pendentes: 0, solucionados_hoje: 0, abertos_hoje: 0 };
  }
  for (const t of base) {
    const solucaoHoje = ehSolucionadoHoje(t, hoje);
    const criadoHoje = (t.data_criacao ?? '').slice(0, 10) === hoje;
    for (const departamento of departamentosDoChamado(t)) {
      const linha = resumo[departamento];
      if (!linha) continue;
      if (t.status !== 5 && t.status !== 6) {
        linha.abertos += 1;
        if (t.status === 4) linha.pendentes += 1;
      }
      if (criadoHoje) linha.abertos_hoje += 1;
      if (solucaoHoje) linha.solucionados_hoje += 1;
    }
  }

  // "Abertos hoje" responde QUANDO o chamado foi criado, não o estado em que está.
  // Por isso conta também o 113783, criado de manhã e já solucionado à tarde.
  //
  // A Triagem mostra o total do Suporte Técnico inteiro: é lá que o chamado
  // nasce, para depois ser retirado e repassado ao departamento que vai atender.
  // Contar só o que ficou na Triagem daria quase sempre zero.
  resumo.Triagem.abertos_hoje = ORDEM_DEPARTAMENTOS.reduce(
    (soma, departamento) => soma + resumo[departamento].abertos_hoje,
    0
  );
  return resumo;
}

/**
 * Contagem de chamados solucionados HOJE no Dpto Suporte Técnico. Fechado hoje mas
 * solucionado em outro dia fica fora. (Tarefa 42)
 */
function contarSolucionadosHoje(base: LinhaBaseDepartamento[]): number {
  const hoje = hojeLocalIso();
  return base.filter((t) => ehSolucionadoHoje(t, hoje)).length;
}

/**
 * Lista dos chamados do Dpto Suporte Técnico solucionados hoje (status 5, ou
 * 6-fechado com `solvedate` hoje), para a lista abaixo do card correspondente.
 * (Tarefa 42 — solucionados nunca ficam amarelos: `nao_vistos` zerado aqui)
 */
function listarSolucionadosHoje(base: LinhaBaseDepartamento[], naoVistos: Map<number, number>): ChamadoPendenteLista[] {
  const hoje = hojeLocalIso();
  return base
    .filter((t) => ehSolucionadoHoje(t, hoje))
    .map((l) => ({
      id: l.id,
      titulo: String(l.name ?? '').trim(),
      solicitante: extrairSolicitante(l.content),
      localizacao: resumirLocalizacao(l.locations_id),
      nao_vistos: 0,
      departamentos: departamentosDoChamado(l),
      status: l.status, // T90: barrinha de cor do status na lateral do item
    }))
    .sort(ordenarPorLocalizacao);
}

/** Dados do dashboard retornados por `GET /api/glpi/dashboard`. */
type DadosDashboard = {
  abertos: number;
  abertos_por_departamento: Array<{ departamento: string; total: number }>;
  solucionados_hoje: number;
  aguardando_retirada: number;
  aguardando_equipamento: number;
  aguardando_resposta: number;
  aguardando_resposta_ipm: number;
  garantia: number;
  servico_terceiros: number;
  lista_retirada: ChamadoPendenteLista[];
  lista_equipamento: ChamadoPendenteLista[];
  lista_solucionados_hoje: ChamadoPendenteLista[];
  fila_manutencao: number;
  lista_fila_manutencao: ChamadoPendenteLista[];
  lista_abertos: ChamadoPendenteLista[];
  listas_abertos_por_departamento: Record<string, ChamadoPendenteLista[]>;
  /**
   * Fila por departamento (T101): abertos **menos** os pendentes (status 4) —
   * é a "fila de chamados" que o perfil do departamento mostra.
   */
  fila_por_departamento: Record<string, ChamadoPendenteLista[]>;
  /** Pendentes por departamento (T101): status 4, o outro card do perfil. */
  pendentes_por_departamento: Record<string, ChamadoPendenteLista[]>;
  /**
   * Só contagem por departamento, para os números pequenos ao lado do total
   * (Tarefa 103): abertos, pendentes, solucionados hoje e abertos hoje.
   */
  resumo_por_departamento: Record<string, ResumoDepartamento>;
};

/**
 * Chamado pendente do Dpto Suporte Técnico com motivo, para as listas do dashboard.
 * Tarefa 84: o formato virou o tipo compartilhado `ChamadoListaItem`
 * (`lib/glpiChamados.ts`), usado também pela busca geral. Mantido o nome local
 * para não reescrever todas as assinaturas do arquivo.
 */
type ChamadoPendenteLista = ChamadoListaItem;

/**
 * Ordena as listas dos cards: chamados com acompanhamento novo (`nao_vistos > 0`)
 * primeiro; o restante em ordem alfabética pela `localizacao` ("SIGLA - local").
 * Empates restantes caem no id (ordem estável); itens sem localização vão ao fim
 * do seu grupo. (Tarefa 36)
 */
function ordenarPorLocalizacao(a: ChamadoPendenteLista, b: ChamadoPendenteLista): number {
  const aNovo = a.nao_vistos > 0 ? 0 : 1;
  const bNovo = b.nao_vistos > 0 ? 0 : 1;
  if (aNovo !== bNovo) return aNovo - bNovo;
  if (!a.localizacao && !b.localizacao) return a.id - b.id;
  if (!a.localizacao) return 1;
  if (!b.localizacao) return -1;

  const porLocalizacao = a.localizacao.localeCompare(b.localizacao, 'pt-BR', {
    sensitivity: 'base',
  });
  return porLocalizacao !== 0 ? porLocalizacao : a.id - b.id;
}

/**
 * Mapa tickets_id → quantidade de acompanhamentos novos (`visto = 0`).
 * (Tarefa 36 — base local `Base_GLPI/glpi_local.db`, coluna criada na T35)
 *
 * Tarefa 81 — recebe os ids dos chamados que estão na tela e **restringe a busca a
 * eles**. Antes varreram-se as 183 mil linhas de `followups` (12,6 s na primeira
 * leitura, ~520 ms depois) só para descobrir quantos não vistos existem; como o mapa
 * só é consultado para os chamados exibidos, o resultado é idêntico — e agora a
 * consulta aproveita o índice `idx_followups_ticket` e resolve em poucos milissegundos.
 */
function carregarNaoVistos(db: Database.Database, idsDosChamados: number[]): Map<number, number> {
  const mapa = new Map<number, number>();
  if (idsDosChamados.length === 0) return mapa;

  try {
    const marcadores = idsDosChamados.map(() => '?').join(',');
    const linhas = db
      .prepare(
        `SELECT tickets_id AS tickets_id, COUNT(*) AS total
           FROM followups
          WHERE visto = 0 AND tickets_id IN (${marcadores})
          GROUP BY tickets_id`
      )
      .all(...idsDosChamados) as Array<{ tickets_id: number; total: number }>;
    for (const linha of linhas) {
      if (Number.isInteger(linha.tickets_id)) mapa.set(linha.tickets_id, Number(linha.total) || 0);
    }
  } catch {
    // Base antiga sem a coluna `visto` (anterior à T35): trata tudo como visto.
  }
  return mapa;
}

/** GET /api/glpi/dashboard → estatísticas do snapshot local do GLPI. */
export async function GET(request: Request) {
  // Tarefa 74: o painel inteiro do GLPI exige sessão — antes, qualquer pessoa na rede
  // recebia a lista de chamados com solicitante, localização e acompanhamento.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const caminhoDb = getCaminhoDb();

  try {
    const db = new Database(caminhoDb, { readonly: true, fileMustExist: true });

    try {
      const base = carregarBaseDepartamento(db);
      const naoVistos = carregarNaoVistos(
        db,
        base.map((t) => t.id)
      );
      const abertos = contarAbertos(base);
      const abertos_por_departamento = contarAbertosPorDepartamento(base);
      const solucionados_hoje = contarSolucionadosHoje(base);
      const aguardando_retirada = contarPorMotivo(base, 'Aguardando Retirada');
      const aguardando_equipamento = contarPorMotivo(base, 'Aguardando Equipamento');
      const aguardando_resposta = contarPorMotivo(base, 'Aguardando Resposta');
      const aguardando_resposta_ipm = contarPorMotivo(base, 'Aguardando Resposta da IPM');
      const garantia = contarPorMotivo(base, 'Garantia');
      const servico_terceiros = contarPorMotivo(base, 'Serviço de Terceiros');
      const lista_retirada = listarPorMotivo(base, 'Aguardando Retirada', naoVistos);
      const lista_equipamento = listarPorMotivo(base, 'Aguardando Equipamento', naoVistos);
      const lista_solucionados_hoje = listarSolucionadosHoje(base, naoVistos);
      const fila_manutencao = contarFilaManutencao(base);
      const lista_fila_manutencao = listarFilaManutencao(base, naoVistos);
      const lista_abertos = listarAbertos(base, naoVistos);
      const listas_abertos_por_departamento = listarAbertosPorDepartamento(base, naoVistos);
      // T101: cards dos perfis por departamento. A fila é o que está aberto e NÃO
      // pendente; os pendentes (status 4) são o outro card, então juntos dão todos
      // os abertos do departamento — nenhum chamado fica fora dos dois.
      const fila_por_departamento = listarPorDepartamento(
        base,
        naoVistos,
        (t) => t.status !== 5 && t.status !== 6 && t.status !== 4
      );
      const pendentes_por_departamento = listarPorDepartamento(
        base,
        naoVistos,
        (t) => t.status === 4
      );
      // T103: números pequenos ao lado do total. Só contagem, sem lista.
      const resumo_por_departamento = resumoPorDepartamento(base);

      return NextResponse.json({
        dashboard: {
          abertos,
          abertos_por_departamento,
          solucionados_hoje,
          aguardando_retirada,
          aguardando_equipamento,
          aguardando_resposta,
          aguardando_resposta_ipm,
          garantia,
          servico_terceiros,
          lista_retirada,
          lista_equipamento,
          lista_solucionados_hoje,
          fila_manutencao,
          lista_fila_manutencao,
          lista_abertos,
          listas_abertos_por_departamento,
          fila_por_departamento,
          pendentes_por_departamento,
          resumo_por_departamento,
        }
      });
    } finally {
      db.close();
    }
  } catch (erro) {
    const msg = erro instanceof Error ? erro.message : String(erro);
    return NextResponse.json(
      { erro: `Não foi possível ler o banco do GLPI: ${msg}` },
      { status: 500 }
    );
  }
}
