import { NextResponse } from 'next/server';
import { criarEvento, listarEventos, listarEventosDoMes } from '@/lib/eventos';
import { bloquearSemSessao } from '@/lib/sessao';
import { validarEvento } from '@/lib/validacao';

export const dynamic = 'force-dynamic';

const FORMATO_PERIODO = /^(\d{4})-(\d{2})$/;

/**
 * GET /api/eventos -> lista completa.
 * GET /api/eventos?mes=AAAA-MM -> apenas os eventos do mês pedido.
 */
export async function GET(request: Request) {
  // Tarefa 74: agenda exige sessão.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const periodo = new URL(request.url).searchParams.get('mes');

  if (!periodo) {
    return NextResponse.json({ eventos: listarEventos() });
  }

  const partes = FORMATO_PERIODO.exec(periodo);
  const mes = partes ? Number(partes[2]) : 0;

  if (!partes || mes < 1 || mes > 12) {
    return NextResponse.json({ erro: 'Período inválido. Use o formato AAAA-MM.' }, { status: 400 });
  }

  return NextResponse.json({ eventos: listarEventosDoMes(Number(partes[1]), mes) });
}

/** POST /api/eventos -> agenda um evento (datas passadas são recusadas pela validação). */
export async function POST(request: Request) {
  // Tarefa 74: a guarda vem antes de ler o corpo, para nem validar o que já é barrado.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const corpo = await request.json().catch(() => null);
  const validacao = validarEvento(corpo);

  if (!validacao.valido) {
    return NextResponse.json({ erros: validacao.erros }, { status: 400 });
  }

  return NextResponse.json({ evento: criarEvento(validacao.dados) }, { status: 201 });
}
