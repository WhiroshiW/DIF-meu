import { NextResponse } from 'next/server';
import {
  iniciarSincronizacao,
  lerEstadoSincronizacao,
  pararSincronizacao,
} from '@/lib/sincronizacaoGlpi';
import { bloquearSemSessao } from '@/lib/sessao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/glpi/sync -> estado da ultima sincronizacao (e se ha uma em andamento). */
export async function GET(request: Request) {
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  return NextResponse.json({ sincronizacao: lerEstadoSincronizacao() });
}

/** POST /api/glpi/sync -> dispara o script do GLPI em segundo plano (botao da tela). */
export async function POST(request: Request) {
  // Tarefa 74: era a rota mais exposta do sistema — disparava a sincronização do GLPI
  // para qualquer um que soubesse o endereço. A sincronização automática do agendador
  // NÃO passa por aqui: `lib/agendadorGlpi.ts` chama `iniciarSincronizacao()` em processo.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const resultado = iniciarSincronizacao();

  if (resultado.codigo === 'em-andamento') {
    return NextResponse.json(
      { erro: 'Já existe uma sincronização em andamento.', sincronizacao: resultado.estado },
      { status: 409 }
    );
  }

  if (resultado.codigo === 'script-ausente') {
    return NextResponse.json({ erro: resultado.erro }, { status: 400 });
  }

  return NextResponse.json({ sincronizacao: resultado.estado }, { status: 202 });
}

/**
 * DELETE /api/glpi/sync -> pede a PARADA da sincronizacao em andamento
 * (botao "Parar sincronizacao", Tarefa 99).
 *
 * A parada e graciosa: o script termina o chamado atual, salva o marcador de
 * progresso e sai com codigo 143. Como a ETAPA 4 grava esse marcador a cada 500
 * chamados, parar no meio da varredura de 113 mil nao perde trabalho — a
 * proxima execucao continua de onde parou.
 */
export async function DELETE(request: Request) {
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const resultado = pararSincronizacao();

  if (resultado.codigo === 'nada-em-andamento') {
    return NextResponse.json(
      { erro: 'Não há sincronização em andamento.', sincronizacao: resultado.estado },
      { status: 409 }
    );
  }

  return NextResponse.json({ sincronizacao: resultado.estado }, { status: 202 });
}

