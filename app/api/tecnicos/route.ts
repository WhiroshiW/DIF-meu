import { NextResponse } from 'next/server';
import { criarTecnico, listarTecnicos } from '@/lib/tecnicos';
import { ehAdministrador } from '@/lib/permissoes';
import { bloquearSemSessao, lerSessao } from '@/lib/sessao';
import { validarTecnico } from '@/lib/validacao';

export const dynamic = 'force-dynamic';

/** GET /api/tecnicos -> lista completa (ativos e desativados), sem o admin. */
export async function GET(request: Request) {
  // Tarefa 74: a lista de técnicos exige sessão — antes qualquer pessoa na rede
  // que chegasse ao endereço do servidor recebia nome, função e contato da equipe.
  const semSessao = bloquearSemSessao(request);
  if (semSessao) return semSessao;

  return NextResponse.json({ tecnicos: listarTecnicos() });
}

/**
 * POST /api/tecnicos -> cadastra um técnico (entra sempre como ativo).
 * Exclusivo do admin: o botão some da tela, mas quem chamasse a rota direto
 * seria barrado aqui (Tarefa 63).
 */
export async function POST(request: Request) {
  const sessao = lerSessao(request);

  if (!sessao) {
    return NextResponse.json({ erro: 'Sessão não reconhecida. Entre novamente.' }, { status: 401 });
  }

  if (!ehAdministrador(sessao.usuario)) {
    return NextResponse.json({ erro: 'Apenas o administrador pode cadastrar técnicos.' }, { status: 403 });
  }

  const corpo = await request.json().catch(() => null);
  const validacao = validarTecnico(corpo);

  if (!validacao.valido) {
    return NextResponse.json({ erros: validacao.erros }, { status: 400 });
  }

  return NextResponse.json({ tecnico: criarTecnico(validacao.dados) }, { status: 201 });
}