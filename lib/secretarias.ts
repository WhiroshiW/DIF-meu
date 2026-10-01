/**
 * Nomes das secretarias e a sigla de cada uma (Tarefa 112).
 *
 * A localização do chamado no GLPI é uma hierarquia: "Secretaria Municipal de
 * Cultura e Turismo - SMCT > Biblioteca Municipal Emiliano Perneta - BIPA".
 * O painel mostra só o resumo ("SMCT - Biblioteca…" ou, quando não há segundo
 * nível, "SMCT" sozinho).
 *
 * Com isso, quem pesquisa "cultura" não acha nada: a sigla não tem o nome da
 * secretaria ao lado. Aqui o nome vira a sigla — e a comparação é feita pelo
 * **resumo da localização** (a mesma regra de `resumirLocalizacao`), de modo que
 * "SMCT" sozinho entra e "SMCT - Biblioteca…" **não**.
 *
 * Fica em arquivo próprio (e não em `glpiChamados.ts`) porque o painel é Client
 * Component e `glpiChamados.ts` importa `node:path`, que não existe no navegador.
 */

export type Secretaria = {
  sigla: string;
  /** Nome por extenso, como o usuário escreveu (com acento; a comparação normaliza). */
  nome: string;
};

/** As 23 secretarias. Fonte única: nomes conferidos com o usuário. */
export const SECRETARIAS: Secretaria[] = [
  { sigla: 'SMAD', nome: 'Administração' },
  { sigla: 'SMAG', nome: 'Agricultura' },
  { sigla: 'SMAS', nome: 'Assistência Social' },
  { sigla: 'SMEAL', nome: 'Assuntos Legislativos' },
  { sigla: 'SMCIT', nome: 'Ciência, Inovação, Tecnologia e Desenvolvimento' },
  { sigla: 'SMCS', nome: 'Comunicação Social' },
  { sigla: 'CGM', nome: 'Controladoria Geral do Município' },
  { sigla: 'SMCT', nome: 'Cultura e Turismo' },
  { sigla: 'SMED', nome: 'Educação' },
  { sigla: 'SMEL', nome: 'Esporte e Lazer' },
  { sigla: 'SMEES', nome: 'Expansão Econômica' },
  { sigla: 'SMFI', nome: 'Finanças' },
  { sigla: 'SMGP', nome: 'Gestão de Pessoas' },
  { sigla: 'SMGO', nome: 'Governo' },
  { sigla: 'SMMA', nome: 'Meio Ambiente' },
  { sigla: 'SMOP', nome: 'Obras e Transportes' },
  { sigla: 'SMPL', nome: 'Planejamento' },
  { sigla: 'PGM', nome: 'Procuradoria Geral do Município' },
  { sigla: 'SMPP', nome: 'Políticas Públicas' },
  { sigla: 'SMSA', nome: 'Saúde' },
  { sigla: 'SMSP', nome: 'Segurança Pública' },
  { sigla: 'SMTE', nome: 'Trabalho e Emprego' },
  { sigla: 'SMUR', nome: 'Urbanismo' },
  { sigla: 'SMH', nome: 'Habitação' },
];

/**
 * Palavras que **não** identificam secretaria sozinhas.
 *
 * "social" está em Assistência Social e em Comunicação Social; "geral" em
 * Controladoria e Procuradoria; "pública" em Segurança Pública e Políticas
 * Públicas. Sem esta lista, "social" viraria filtro das duas — e a busca
 * passaria a esconder chamado de uma delas.
 */
const PALAVRAS_GENERICAS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'a', 'o',
  'municipal', 'municipio', 'secretaria', 'geral',
]);

/** Minúsculas e sem acento — o mesmo padrão de `normalizarBusca` no painel. */
export function normalizarPalavra(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Mapa `palavra -> sigla`, montado uma vez no carregamento do módulo.
 *
 * Só entram as palavras que pertencem a **uma** secretaria: as ambiguas ficam
 * de fora (ver `PALAVRAS_GENERICAS` e o teste de ambiguidade abaixo).
 */
const PALAVRA_PARA_SIGLA: Map<string, string> = (() => {
  const candidatos = new Map<string, Set<string>>();
  for (const secretaria of SECRETARIAS) {
    for (const palavra of normalizarPalavra(secretaria.nome).split(/[\s,]+/)) {
      if (!palavra || PALAVRAS_GENERICAS.has(palavra)) continue;
      const conjunto = candidatos.get(palavra) ?? new Set<string>();
      conjunto.add(secretaria.sigla);
      candidatos.set(palavra, conjunto);
    }
  }
  const mapa = new Map<string, string>();
  for (const [palavra, siglas] of candidatos) {
    // Ambígua (ex.: "social"): não entra, para não esconder chamado de uma secretaria.
    if (siglas.size === 1) mapa.set(palavra, [...siglas][0]);
  }
  // A sigla digitada direto ("SMCT", "pgm") também vale como filtro.
  for (const secretaria of SECRETARIAS) {
    mapa.set(secretaria.sigla.toLowerCase(), secretaria.sigla);
  }
  return mapa;
})();

export type LeituraTermo = {
  /** Sigla a filtrar, ou `null` quando o termo não nomeia secretaria. */
  sigla: string | null;
  /** Palavras do termo que sobraram para a busca por texto. */
  palavras: string[];
};

/**
 * Lê o termo digitado e diz se ele nomeia uma secretaria (Tarefa 112).
 *
 * - `"cultura"` → `{ sigla: 'SMCT', palavras: [] }`
 * - `"SMCT"` → `{ sigla: 'SMCT', palavras: [] }`
 * - `"cultura biblioteca"` → `{ sigla: 'SMCT', palavras: ['biblioteca'] }`
 * - `"social"` (ambígua) → `{ sigla: null, palavras: ['social'] }`
 * - `"cultura saude"` (duas siglas) → `{ sigla: null, palavras: ['cultura','saude'] }`
 *
 * Palavras da secretaria são **tiradas** da busca por texto: sem isso, "cultura"
 * ainda procuraria a palavra no título/descrição e traria chamado de outro
 * lugar que tenha "cultura" no texto.
 */
export function interpretarTermo(termo: string): LeituraTermo {
  const palavras = String(termo ?? '')
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (palavras.length === 0) return { sigla: null, palavras: [] };

  const siglas = new Set<string>();
  const restantes: string[] = [];
  for (const palavra of palavras) {
    const sigla = PALAVRA_PARA_SIGLA.get(normalizarPalavra(palavra));
    if (sigla) siglas.add(sigla);
    else restantes.push(palavra);
  }
  // Duas siglas diferentes no mesmo termo: não dá para escolher uma, então a
  // localização não filtra e o termo continua sendo busca por texto.
  if (siglas.size !== 1) return { sigla: null, palavras };
  return { sigla: [...siglas][0], palavras: restantes };
}