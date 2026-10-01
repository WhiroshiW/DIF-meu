import { NextResponse } from 'next/server';
import { buscarSugestao, excluirSugestao } from '@/lib/sugestoes';
import { bloquearSemSessao } from '@/lib/sessao';

export const dynamic = 'force-dynamic';

type ContextoRota = { params: Promise<{ id: string }> };

/** DELETE /api/sugestoes/:id -> remove a sugestão (exclusão física, como na agenda). */
export async function DELETE(request: Request, { params }: ContextoRota) {
  // Tarefa 74: exigir sessão antes de olhar o id.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const { id } = await params;
  const sugestaoId = Number(id);

  if (!Number.isInteger(sugestaoId) || sugestaoId <= 0) {
    return NextResponse.json({ erro: 'Identificador de sugestão inválido.' }, { status: 400 });
  }

  if (!buscarSugestao(sugestaoId)) {
    return NextResponse.json({ erro: 'Sugestão não encontrada.' }, { status: 404 });
  }

  excluirSugestao(sugestaoId);

  return NextResponse.json({ removido: true });
}