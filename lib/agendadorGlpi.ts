// Agendador automatico de sincronizacao do GLPI, embutido no PROPRIO servidor
// Next.js (sem tarefa agendada do sistema operacional).
// Dispara o script a cada 5 minutos, somente de segunda a sexta,
// das 8:00 as 17:00 (horario local da maquina onde roda o servidor).
import { iniciarSincronizacao } from './sincronizacaoGlpi';

/** Intervalo entre checagens: 5 minutos. */
const INTERVALO_MS = 5 * 60 * 1000;

/** Janela de disparo: hora inicial inclusiva e hora final exclusiva (17h nao roda). */
const HORA_INICIAL = 8;
const HORA_FINAL = 17;

/**
 * Decide se a sincronizacao deve rodar agora:
 * - segunda a sexta (getDay() de 1 a 5);
 * - entre 08:00:00 e 16:59:59 no fuso horario local.
 */
export function dentroDoHorarioUtil(agora: Date = new Date()): boolean {
  const diaSemana = agora.getDay(); // 0 = domingo ... 6 = sabado
  if (diaSemana === 0 || diaSemana === 6) return false;

  const hora = agora.getHours();
  return hora >= HORA_INICIAL && hora < HORA_FINAL;
}

/**
 * Inicia o agendador UMA unica vez por processo do servidor.
 * A guarda em `globalThis` (mesmo padrao de `lib/db.ts` e da rota de sync)
 * impede timer duplicado no hot reload do modo dev.
 */
export function iniciarAgendadorGlpi(): void {
  const raiz = globalThis as typeof globalThis & { __dinfAgendadorGlpi?: boolean };
  if (raiz.__dinfAgendadorGlpi) return;
  raiz.__dinfAgendadorGlpi = true;

  console.log('[Agendador GLPI] ativo: a cada 5 min, seg-sex, 08:00-17:00 (fuso local).');

  setInterval(() => {
    if (!dentroDoHorarioUtil()) return;

    // Compartilha a mesma trava do botao "Sincronizar": se ja houver uma
    // execucao em andamento, `iniciarSincronizacao` devolve 'em-andamento'
    // e este tick e ignorado (proxima chance em 5 min).
    const resultado = iniciarSincronizacao();

    // Tarefa 96: o disparo automático NÃO é mais impresso no terminal. Ele
    // acontecia a cada 5 minutos e, na janela do servidor de produção, enchia a
    // tela de linhas repetidas. A falha continua aparecendo, porque é rara e
    // serve de aviso.
    if (resultado.codigo === 'script-ausente') {
      console.log(`[Agendador GLPI] falha ao disparar: ${resultado.erro}`);
    }
  }, INTERVALO_MS);
}
