import { NextResponse } from 'next/server';
import { criarSugestao, listarSugestoes } from '@/lib/sugestoes';
import { bloquearSemSessao } from '@/lib/sessao';
import { validarSugestao } from '@/lib/validacao';

export const dynamic = 'force-dynamic';

/** GET /api/sugestoes -> lista completa (mais novas primeiro). */
export async function GET(request: Request) {
  // Tarefa 74: sugestões exige sessão.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  return NextResponse.json({ sugestoes: listarSugestoes() });
}

/** POST /api/sugestoes -> cadastra uma sugestão. */
export async function POST(request: Request) {
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const corpo = await request.json().catch(() => null);
  const validacao = validarSugestao(corpo);

  if (!validacao.valido) {
    return NextResponse.json({ erros: validacao.erros }, { status: 400 });
  }

  return NextResponse.json({ sugestao: criarSugestao(validacao.dados.texto) }, { status: 201 });
}