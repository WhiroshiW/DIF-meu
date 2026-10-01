/** Tipos de `lib/indiceGlpi.js` (o arquivo é CommonJS para o script de sync poder usar). */

export type EstadoIndice = {
  existe: boolean;
  pronto: boolean;
  caminho: string;
  versao?: string | null;
  chamados?: number;
  reconstruidoEm?: string | null;
};

export type ResultadoIndice = {
  caminho?: string;
  chamados?: number;
  acompanhamentos?: number;
  segundos?: number;
  incremental?: boolean;
};

export type ChamadoEncontrado = {
  id: number;
  score: number;
  onde: 'chamado' | 'acompanhamento';
};

export declare const VERSAO_INDICE: string;
export declare function caminhoBase(): string;
export declare function caminhoIndice(): string;
export declare function estadoIndice(): EstadoIndice;
export declare function reconstruir(opcoes?: {
  aoProgredir?: (mensagem: string) => void;
  caminhoBase?: string;
  caminhoIndice?: string;
}): ResultadoIndice;
export declare function atualizarIncremental(opcoes?: {
  aoProgredir?: (mensagem: string) => void;
  caminhoBase?: string;
  caminhoIndice?: string;
}): ResultadoIndice;
export declare function garantirIndice(opcoes?: {
  aoProgredir?: (mensagem: string) => void;
  caminhoBase?: string;
  caminhoIndice?: string;
}): { acao: 'reconstruido' | 'atualizado' | 'falhou'; detalhe?: ResultadoIndice; erro?: string };
export declare function montarConsulta(termo: string): string | null;
export declare function buscar(termo: string, limite?: number): ChamadoEncontrado[] | null;
/**
 * Ids dos chamados cuja localização contiene a sigla (Tarefa 112).
 *
 * Com `comLocal`, cada linha vem com a coluna `local` (a localização crua, com a
 * hierarquia inteira) — é o que permite decidir "sigla sozinha" sem reabrir a base.
 * Sem `comLocal`, devolve só `{ id }`. Sem índice pronto, `null`.
 */
export declare function buscarPorLocal(
  sigla: string,
  limite?: number,
  comLocal?: boolean
): Array<{ id: number; local?: string }> | null;
