import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'node:path';
import { bloquearSemSessao } from '@/lib/sessao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Caminho do banco local do GLPI (snapshot) — mesma resolução de
 * `app/api/glpi/dashboard/route.ts` e de `scripts/sincronizar-glpi.js`.
 */
function getCaminhoDb(): string {
  const dbPathEnv = process.env.GLPI_DB_PATH;
  if (dbPathEnv) {
    return path.resolve(process.cwd(), dbPathEnv);
  }
  return path.resolve(process.cwd(), '..', 'Base_GLPI', 'glpi_local.db');
}

/**
 * POST /api/glpi/chamados/[id]/visto — marca TODOS os acompanhamentos não lidos
 * do chamado como vistos (visto = 1). Chamado pelo clique no item do dashboard
 * (Tarefa 36). O diff da sincronização nunca toca a coluna `visto` (Tarefa 35),
 * então a marcação sobrevive ao próximo re-sync.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Tarefa 74: marcar chamado como visto escreve no banco do snapshot do GLPI.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const { id: idTexto } = await params;
  const id = Number(idTexto);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ erro: 'Identificador de chamado inválido.' }, { status: 400 });
  }

  try {
    // Escrita pontual na base do snapshot (fora do processo de sincronização).
    const db = new Database(getCaminhoDb(), { fileMustExist: true });
    try {
      const resultado = db
        .prepare('UPDATE followups SET visto = 1 WHERE tickets_id = ? AND visto = 0')
        .run(id);
      return NextResponse.json({ chamado: id, marcados: resultado.changes });
    } finally {
      db.close();
    }
  } catch (erro) {
    const msg = erro instanceof Error ? erro.message : String(erro);
    return NextResponse.json(
      { erro: `Não foi possível marcar os acompanhamentos como vistos: ${msg}` },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/glpi/chamados/[id]/visto — devolve o chamado ao estado "com
 * acompanhamento novo": o `visto` do **último** acompanhamento volta a 0
 * (Tarefa 93). É o contrário do POST, para o caso de o técnico clicar no item
 * sem querer e a pessoa que deveria ver o aviso passar batido.
 *
 * Não mexe em nenhum outro acompanhamento: se o chamado já tiver outros
 * `visto = 0`, o `nao_vistos` continua > 0 e o item continua amarelo, como já
 * estava. O diff da sincronização só altera `visto` no INSERT do followup
 * (Tarefa 35), então a marcação volta a ser sobrescrita no próximo re-sync —
 * que é o comportamento esperado: o chamado novo de verdade sempre manda.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Mesma trava do POST (Tarefa 74): a rota escreve no banco do snapshot.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  const { id: idTexto } = await params;
  const id = Number(idTexto);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ erro: 'Identificador de chamado inválido.' }, { status: 400 });
  }

  try {
    const db = new Database(getCaminhoDb(), { fileMustExist: true });
    try {
      // `MAX(id)` é o acompanhamento mais recente do chamado (o `id` do GLPI é
      // autoincremental). Chamado sem acompanhamento não muda nada.
      const resultado = db
        .prepare(
          `UPDATE followups
              SET visto = 0
            WHERE id = (SELECT MAX(id) FROM followups WHERE tickets_id = ?)`
        )
        .run(id);
      return NextResponse.json({ chamado: id, desmarcados: resultado.changes });
    } finally {
      db.close();
    }
  } catch (erro) {
    const msg = erro instanceof Error ? erro.message : String(erro);
    return NextResponse.json(
      { erro: `Não foi possível devolver o chamado para não visto: ${msg}` },
      { status: 500 }
    );
  }
}