import { NextResponse } from 'next/server';
import {
  atualizarPerfilTecnico,
  buscarPerfilTecnico,
  buscarTecnico,
  definirAtivoTecnico,
} from '@/lib/tecnicos';
import { ehAdministrador } from '@/lib/permissoes';
import { lerSessao, type SessaoUsuario } from '@/lib/sessao';
import { validarTecnico } from '@/lib/validacao';

export const dynamic = 'force-dynamic';

type ContextoRota = { params: Promise<{ id: string }> };

const CAMPOS_CADASTRAIS = ['nomeCompleto', 'funcao', 'dataNascimento'];

/** Campos do perfil editáveis pelo próprio técnico (Tarefa 61). */
const CAMPOS_PERFIL = [...CAMPOS_CADASTRAIS, 'telefone', 'email', 'senha'];

/** Menor senha aceita na redefinição (Tarefa 61). */
const TAMANHO_MINIMO_SENHA = 4;

/** Lê e valida o id da rota. */
function lerIdDaRota(id: string): number | null {
  const tecnicoId = Number(id);
  return Number.isInteger(tecnicoId) && tecnicoId > 0 ? tecnicoId : null;
}

/**
 * Confere a sessão (Tarefa 63).
 * Devolve o corpo da resposta de erro, ou `null` quando o acesso pode seguir.
 */
function exigirSessao(sessao: SessaoUsuario | null): { erro: string; status: number } | null {
  if (!sessao) {
    return { erro: 'Sessão não reconhecida. Entre novamente.', status: 401 };
  }
  return null;
}

/**
 * Confere se a sessão pode **alterar** o registro informado (Tarefa 63).
 * O admin altera qualquer cadastro; o técnico apenas o próprio.
 */
function bloquearEscrita(
  tecnicoId: number,
  sessao: SessaoUsuario | null
): { erro: string; status: number } | null {
  const semSessao = exigirSessao(sessao);
  if (semSessao) {
    return semSessao;
  }

  if (ehAdministrador(sessao!.usuario)) {
    return null;
  }

  if (sessao!.id !== tecnicoId) {
    return { erro: 'Você só pode alterar o seu próprio perfil.', status: 403 };
  }

  return null;
}

/**
 * GET /api/tecnicos/:id
 * Devolve o perfil do técnico (nome, função, nascimento, telefone, e-mail e
 * usuário/CPF) para alimentar o modal "Perfil do técnico".
 * A coluna `senha` não é lida — o hash nunca sai do servidor (Tarefa 61).
 * Leitura: liberada a qualquer usuário com sessão (o botão "Perfil" aparece para
 * todos na tela de Técnicos); escrita: só o próprio perfil ou o admin (Tarefa 63).
 */
export async function GET(request: Request, { params }: ContextoRota) {
  const { id } = await params;
  const tecnicoId = lerIdDaRota(id);

  if (tecnicoId === null) {
    return NextResponse.json({ erro: 'Identificador de técnico inválido.' }, { status: 400 });
  }

  const bloqueio = exigirSessao(lerSessao(request));

  if (bloqueio) {
    return NextResponse.json({ erro: bloqueio.erro }, { status: bloqueio.status });
  }

  const perfil = buscarPerfilTecnico(tecnicoId);
  if (!perfil) {
    return NextResponse.json({ erro: 'Técnico não encontrado.' }, { status: 404 });
  }

  return NextResponse.json({ perfil });
}

/**
 * PATCH /api/tecnicos/:id
 * - `{ nomeCompleto, funcao, dataNascimento, telefone, email, senha? }` ->
 *   salva o perfil; `senha` só é gravada quando preenchida e nunca é devolvida.
 * - `{ ativo: boolean }` -> desativa/reativa — **somente admin** (Tarefa 63).
 *
 * Autorização (Tarefa 63): o admin altera qualquer cadastro; o técnico apenas o
 * próprio perfil e nunca mexe em `ativo` nem em outro registro.
 */
export async function PATCH(request: Request, { params }: ContextoRota) {
  const { id } = await params;
  const tecnicoId = lerIdDaRota(id);

  if (tecnicoId === null) {
    return NextResponse.json({ erro: 'Identificador de técnico inválido.' }, { status: 400 });
  }

  const sessao = lerSessao(request);
  const bloqueio = bloquearEscrita(tecnicoId, sessao);

  if (bloqueio) {
    return NextResponse.json({ erro: bloqueio.erro }, { status: bloqueio.status });
  }

  const atual = buscarTecnico(tecnicoId);
  if (!atual) {
    return NextResponse.json({ erro: 'Técnico não encontrado.' }, { status: 404 });
  }

  const corpo = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!corpo) {
    return NextResponse.json({ erro: 'Corpo da requisição inválido.' }, { status: 400 });
  }

  const ehAdmin = ehAdministrador(sessao?.usuario);

  // Desativar/reativar é gestão de equipe: exclusivo do admin (Tarefa 63).
  if ('ativo' in corpo && !ehAdmin) {
    return NextResponse.json(
      { erro: 'Apenas o administrador pode desativar ou reativar técnicos.' },
      { status: 403 }
    );
  }

  // Tarefa 79 — a função também é gestão de equipe. O campo aparece desabilitado no
  // modal para o técnico, mas isso é só interface: sem esta checagem, quem chamasse a
  // rota na mão trocaria a própria função. Mesmo formato da regra de `ativo` acima.
  if ('funcao' in corpo && !ehAdmin) {
    return NextResponse.json(
      { erro: 'Apenas o administrador pode alterar a função dos técnicos.' },
      { status: 403 }
    );
  }

  if (CAMPOS_PERFIL.some((campo) => campo in corpo)) {
    const senha = typeof corpo.senha === 'string' ? corpo.senha.trim() : '';

    if (senha && senha.length < TAMANHO_MINIMO_SENHA) {
      return NextResponse.json(
        { erros: { senha: `A senha deve ter ao menos ${TAMANHO_MINIMO_SENHA} caracteres.` } },
        { status: 400 }
      );
    }

    const validacao = validarTecnico({
      nomeCompleto: corpo.nomeCompleto ?? atual.nomeCompleto,
      funcao: corpo.funcao ?? atual.funcao,
      dataNascimento: corpo.dataNascimento ?? atual.dataNascimento,
    });

    if (!validacao.valido) {
      return NextResponse.json({ erros: validacao.erros }, { status: 400 });
    }

    const perfilAtual = buscarPerfilTecnico(tecnicoId);

    const perfil = atualizarPerfilTecnico(tecnicoId, {
      ...validacao.dados,
      telefone: (corpo.telefone as string | null | undefined) ?? perfilAtual?.telefone ?? null,
      email: (corpo.email as string | null | undefined) ?? perfilAtual?.email ?? null,
      ...(senha ? { senha } : {}),
    });

    if (!perfil) {
      return NextResponse.json({ erro: 'Técnico não encontrado.' }, { status: 404 });
    }

    if (typeof corpo.ativo === 'boolean') {
      if (!definirAtivoTecnico(tecnicoId, corpo.ativo)) {
        return NextResponse.json({ erro: 'Técnico não encontrado.' }, { status: 404 });
      }
    }

    // `tecnico` continua na resposta para não quebrar a tela de Técnicos,
    // que consome esse contrato em `PATCH` (Tarefa 61).
    return NextResponse.json({ perfil, tecnico: buscarTecnico(tecnicoId) });
  }

  if (typeof corpo.ativo === 'boolean') {
    if (!definirAtivoTecnico(tecnicoId, corpo.ativo)) {
      return NextResponse.json({ erro: 'Técnico não encontrado.' }, { status: 404 });
    }
  }

  return NextResponse.json({ tecnico: buscarTecnico(tecnicoId) });
}