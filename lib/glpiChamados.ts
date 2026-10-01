import path from 'node:path';

/**
 * Leitura de chamados do GLPI compartilhada entre as rotas do painel
 * (`/api/glpi/dashboard` e `/api/glpi/busca`).
 *
 * Estas funções eram do dashboard e foram trazidas para cá na Tarefa 84, quando a
 * busca geral passou a precisar exatamente das mesmas extrações (solicitante,
 * localização e departamentos). Ficando em um só lugar, as duas rotas não podem
 * divergir: uma lista mostraria o solicitante e a outra não.
 */

/**
 * Caminho do banco local do GLPI (snapshot).
 * Segue o mesmo padrão de `scripts/sincronizar-glpi.js`: resolução relativa à raiz do projeto.
 */
export function getCaminhoDbGlpi(): string {
  const dbPathEnv = process.env.GLPI_DB_PATH;
  if (dbPathEnv) {
    return path.resolve(process.cwd(), dbPathEnv);
  }
  // Padrão: ../Base_GLPI/glpi_local.db relativo à raiz do projeto
  return path.resolve(process.cwd(), '..', 'Base_GLPI', 'glpi_local.db');
}

/**
 * Decodifica as entidades HTML que a API do GLPI devolve
 * (&#62; = >, &#60; = <, &amp; = &, &nbsp; = espaço, aspas).
 */
export function decodificarHtml(texto: string | null): string {
  return String(texto ?? '')
    .replace(/&#62;/g, '>')
    .replace(/&#60;/g, '<')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Deixa cada palavra do nome no padrão "Primeira maiúscula, resto minúscula"
 * (nome e sobrenome). Também trata partes ligadas por hífen/apóstrofo.
 * Ex.: "DIOGO FELIPE RAMIRO FERNANDES" → "Diogo Felipe Ramiro Fernandes".
 */
function capitalizarPalavra(palavra: string): string {
  return palavra
    .split(/([-'\u2019])/)
    .map((parte) =>
      /^[-'\u2019]$/.test(parte)
        ? parte
        : parte.charAt(0).toLocaleUpperCase('pt-BR') +
          parte.slice(1).toLocaleLowerCase('pt-BR')
    )
    .join('');
}

/** Aplica o padrão de capitalização em todas as palavras do nome. */
function formatarNomePessoa(nome: string): string {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .map(capitalizarPalavra)
    .join(' ');
}

/**
 * Nome do solicitante extraído da descrição do chamado.
 * Dois formatos de rótulo aparecem na base:
 * 1) "<strong>Nome :</strong> FULANO</p>" — rótulo no strong, valor fora;
 * 2) "<strong>Nome Completo: FULANO</strong>" — rótulo e valor no mesmo strong.
 * A regex aceita os dois ("Nome" + opcional "Completo" + ":") e captura até a
 * próxima tag (Ramal/CPF seguintes são ignorados); normaliza o case
 * (primeira letra maiúscula de cada palavra).
 * Retorna '' quando o chamado não segue nenhum dos formatos.
 */
export function extrairSolicitante(content: string | null): string {
  const texto = decodificarHtml(content);
  const correspondencia = /Nome(?:\s+Completo)?\s*:\s*(?:<\/strong>\s*)?([^<]{0,200})/i.exec(texto);
  if (!correspondencia) return '';
  const nome = correspondencia[1].replace(/\s+/g, ' ').trim();
  return formatarNomePessoa(nome);
}

/**
 * Resumo curto de localização para exibição no dashboard.
 * Regra: sigla da secretaria (sufixo após "-" no 1º nível, ex.: SMSA, SMPL)
 * + último nível da hierarquia (o que está após o último ">").
 * Ex.: "Secretaria Municipal de Saúde - SMSA > ... > UBS X" → "SMSA - UBS X";
 * "Secretaria Municipal de Planejamento - SMPL" → "SMPL".
 */
export function resumirLocalizacao(locationsId: string | null): string {
  const texto = decodificarHtml(locationsId).trim();
  if (!texto) return '';
  const partes = texto.split('>').map((p) => p.trim()).filter(Boolean);
  if (partes.length === 0) return '';
  const primeira = partes[0];
  const correspondencia = primeira.match(/-\s*([A-Za-z]{2,}\d*)$/);
  const sigla = correspondencia ? correspondencia[1] : '';
  const ultima = partes.length > 1 ? partes[partes.length - 1] : '';
  if (sigla && ultima && ultima !== primeira) return `${sigla} - ${ultima}`;
  if (sigla) return sigla;
  return primeira;
}

/** Normaliza o nome cru do grupo para um dos 7 rótulos fixos (ou null se for outro). */
export function normalizarDepartamento(nomeCurto: string): string | null {
  const n = nomeCurto.toLowerCase();
  if (n.includes('triagem')) return 'Triagem';
  if (/\bn1\b/.test(n)) return 'N1';
  if (/\bn2\b/.test(n)) return 'N2';
  if (/\bn3\b/.test(n)) return 'N3';
  if (n.includes('manuten')) return 'Manutenção';
  if (n.includes('externo')) return 'Externo';
  if (n.includes('estoque')) return 'Estoque';
  return null;
}

/**
 * Departamentos de fora do Dpto Suporte Técnico que também ganham bolinha
 * colorida (Tarefa 88). No GLPI o grupo é uma árvore de nomes, e o primeiro
 * nível já é o departamento: "Superintendência de TI > Dpto InfraEstrutura >
 * Telefonia" e "… > Dpto Gestão de Sistemas > Triagem Sistemas > Nível 1 -
 * Sistemas". O SMED é o único de outra secretaria: "Secretaria de Educação >
 * Suporte Técnico SMED". As sub-áreas (Telefonia, Segurança/Rede, IPM
 * Sistemas…) ficam todas sob o mesmo departamento.
 */
const GRUPOS_EXTERNOS: Array<{ marca: string; rotulo: string }> = [
  { marca: 'dpto infraestrutura', rotulo: 'Infraestrutura' },
  { marca: 'dpto gestão de sistemas', rotulo: 'Sistemas' },
  { marca: 'suporte técnico smed', rotulo: 'Suporte SMED' },
];

/**
 * Rótulo de um grupo que **não** é do Dpto Suporte Técnico (Tarefa 88).
 * Devolve `null` quando o grupo não é de nenhum desses três departamentos —
 * nesse caso o chamado continua sem bolinha, como antes.
 */
export function normalizarGrupoExterno(nomeGrupo: string): string | null {
  const n = nomeGrupo.toLowerCase();
  for (const grupo of GRUPOS_EXTERNOS) {
    if (n.includes(grupo.marca)) return grupo.rotulo;
  }
  return null;
}

/** Extrai o nome curto do departamento (último segmento após o último "> "). */
export function extrairDepartamento(nomeGrupo: string): string {
  const ultimaOcorrencia = Math.max(nomeGrupo.lastIndexOf(' > '), nomeGrupo.lastIndexOf('> '));
  return ultimaOcorrencia > 0 ? nomeGrupo.substring(ultimaOcorrencia + 2).trim() : nomeGrupo.trim();
}

/**
 * Departamentos a que um chamado pertence, lidos do JSON de `tickets.groups`.
 * Um chamado pode estar em mais de um grupo, daí a lista — ela alimenta a bolinha
 * colorida com a sigla no canto do item (Tarefa 69).
 *
 * Tarefa 88: além dos subdepartamentos do Dpto Suporte Técnico, entram também
 * **Infraestrutura**, **Sistemas** e **Suporte SMED**. Um chamado do Suporte
 * Técnico pode estar simultaneamente nesses outros grupos, e aí aparece com
 * duas bolinhas.
 */
export function departamentosDaBase(groups: string | null): string[] {
  if (!groups) return [];
  try {
    const grupos = JSON.parse(groups) as Array<{ name?: unknown }>;
    if (!Array.isArray(grupos)) return [];
    const nomes = new Set<string>();
    for (const g of grupos) {
      const nome = String(g && g.name ? g.name : '');
      if (!nome) continue;
      if (nome.toLowerCase().includes('dpto suporte técnico')) {
        const rotulo = normalizarDepartamento(extrairDepartamento(nome));
        if (rotulo) nomes.add(rotulo);
        continue;
      }
      // Fora do Dpto Suporte Técnico: Infraestrutura, Sistemas e Suporte SMED (T88).
      const externo = normalizarGrupoExterno(nome);
      if (externo) nomes.add(externo);
    }
    return [...nomes];
  } catch {
    return [];
  }
}

/** Chamado como aparece nas listas do painel (mesmo formato do dashboard). */
export type ChamadoListaItem = {
  id: number;
  titulo: string;
  solicitante: string;
  localizacao: string;
  nao_vistos: number;
  departamentos: string[];
  /**
   * Status do GLPI (Tarefa 90): 1 Novo, 2 Em atendimento, 3 Em atendimento
   * (planejado), 4 Pendente, 5 Solucionado, 6 Fechado. Vem para a barrinha de
   * cor na lateral do item da lista.
   */
  status: number;
  /**
   * Motivo da pendência (Tarefa 101). Vem preenchido só nos cards que precisam
   * dele — o card "Pendente" da Manutenção é o que separa "pendente sem motivo"
   * dos que já aparecem em Retirada/Equipamento. Ausente nas demais listas.
   */
  motivo_pendencia?: string | null;
};
