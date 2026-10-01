import { assinar } from '@/lib/eventosGlpi';
import { lerSessao } from '@/lib/sessao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * intervalo do "ping" que mantem a conexao viva (Tarefa 67).
 * Proxies e balanceadores derrubam conexoes ociosas; 25 s e seguro e barato.
 */
const INTERVALO_PING_MS = 25_000;

/** Monta o bloco de um evento SSE (linhas `field: valor` + linha em branco). */
function formatarEvento(dados: string): string {
  return `data: ${dados}\n\n`;
}

/**
 * GET /api/glpi/eventos — stream de avisos (Server-Sent Events).
 *
 * A tela do GLPI abre este canal e, ao receber um aviso, recarrega o dashboard e o
 * rotulo de "ultima sincronizacao". Assim, quando qualquer usuario (ou o agendador)
 * sincroniza, **todos** os clientes conectados veem o resultado na hora, em vez de
 * esperar o proximo tique do polling de 15 s.
 *
 * O canal fica aberto; quando a aba fecha, o navegador cancela a requisicao e o
 * `cancel` remove o assinante.
 */
export async function GET(request: Request) {
  // `EventSource` envia os cookies na mesma origem, entao a sessao pode ser conferida.
  if (!lerSessao(request)) {
    return new Response('Sessão não reconhecida.', { status: 401 });
  }

  const codificador = new TextEncoder();
  let cancelar: () => void = () => undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controlador) {
      // Comentario inicial: confirma a conexao e ja abre a porta para o EventSource.
      controlador.enqueue(codificador.encode(': conectado\n\n'));

      const escrever = (mensagem: string) => {
        controlador.enqueue(codificador.encode(formatarEvento(mensagem)));
      };

      cancelar = assinar(escrever);

      ping = setInterval(() => {
        controlador.enqueue(codificador.encode(': ping\n\n'));
      }, INTERVALO_PING_MS);
    },
    cancel() {
      cancelar();
      if (ping) clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Desliga o buffer de proxies ngx, que seguraria os eventos.
      'X-Accel-Buffering': 'no',
    },
  });
}
