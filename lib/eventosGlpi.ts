/**
 * Central de avisos do GLPI (Tarefa 67).
 *
 * O polling de 15 s já fazia a tela se atualizar sozinha, mas só "por sorte": o
 * cliente precisava perguntar. Aqui o servidor **empurra** o aviso — quando uma
 * sincronização termina, todos os clientes conectados recebem na hora, sem esperar
 * o próximo tique. É a base do stream SSE de `app/api/glpi/eventos/route.ts`.
 *
 * Os assinantes ficam em `globalThis`, no mesmo padrão de `lib/sincronizacaoGlpi.ts`,
 * para que o hot reload do modo dev não perca a lista de quem está conectado.
 */

/** Recebe o aviso publicado e escreve no stream do cliente. */
export type AssinanteGlpi = (mensagem: string) => void;

const memoria = globalThis as typeof globalThis & {
  __dinfEventosGlpi?: Set<AssinanteGlpi>;
};

function obterAssinantes(): Set<AssinanteGlpi> {
  if (!memoria.__dinfEventosGlpi) {
    memoria.__dinfEventosGlpi = new Set<AssinanteGlpi>();
  }

  return memoria.__dinfEventosGlpi;
}

/**
 * Registra um cliente conectado e devolve a função para cancelá-lo.
 * Guardar o cancelamento no `cleanup` do `useEffect` evita acumular streams mortos
 * (cada requisição SSE fica aberta até a aba fechar).
 */
export function assinar(ouvinte: AssinanteGlpi): () => void {
  const assinantes = obterAssinantes();
  assinantes.add(ouvinte);

  return () => {
    assinantes.delete(ouvinte);
  };
}

/** Quantidade de clientes atualmente conectados (usado no diagnóstico). */
export function totalDeAssinantes(): number {
  return obterAssinantes().size;
}

/**
 * Publica um aviso para todos os clientes conectados.
 * O aviso é um texto simples (`timestamp|motivo`) — quem recebe é que decide o que
 * recarregar. Assinante que lançar exceção é removido em vez de derrubar os outros.
 */
export function publicarAtualizacao(motivo: string): void {
  const assinantes = obterAssinantes();
  const mensagem = `${new Date().toISOString()}|${motivo}`;

  for (const ouvinte of [...assinantes]) {
    try {
      ouvinte(mensagem);
    } catch {
      assinantes.delete(ouvinte);
    }
  }
}
