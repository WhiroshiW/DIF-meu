import { NextResponse } from 'next/server';
import { buscarEvento, excluirEvento } from '@/lib/eventos';
import { bloquearSemSessao } from '@/lib/sessao';

export const dynamic = 'force-dynamic';

type ContextoRota = { params: Promise<{ id: string }> };

/** DELETE /api/eventos/:id -> remove o evento da agenda. */
export async function DELETE(request: Request, { params }: ContextoRota) {
  // Tarefa 74: exigir sessão antes de olhar o id, para não vazar nem a existência do registro.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const { id } = await params;
  const eventoId = Number(id);

  if (!Number.isInteger(eventoId) || eventoId <= 0) {
    return NextResponse.json({ erro: 'Identificador de evento inválido.' }, { status: 400 });
  }

  if (!buscarEvento(eventoId)) {
    return NextResponse.json({ erro: 'Evento não encontrado.' }, { status: 404 });
  }

  excluirEvento(eventoId);

  return NextResponse.json({ removido: true });
}
