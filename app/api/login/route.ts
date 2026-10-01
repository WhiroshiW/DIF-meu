import { NextResponse } from 'next/server';
import { getBanco } from '@/lib/db';
import { buscarPerfilTecnico } from '@/lib/tecnicos';
import { conferirSenha } from '@/lib/senha';
import { cookieDeSessao, cookieDeSessaoApagada, criarToken, lerSessao } from '@/lib/sessao';

export const dynamic = 'force-dynamic';

type LinhaTecnicoLogin = {
  id: number;
  nome_completo: string;
  funcao: string;
  usuario: string | null;
  senha: string | null;
  ativo: number;
};

type CorpoLogin = {
  usuario?: unknown;
  senha?: unknown;
};

/**
 * Normaliza o identificador de login:
 * Se for o usuário admin, mantém 'admin' em minúsculas;
 * Se for um CPF (mesmo digitado com pontos/traço), extrai apenas os números.
 */
function normalizarUsuario(entrada: string): string {
  const limpo = entrada.trim();
  if (limpo.toLowerCase() === 'admin') {
    return 'admin';
  }
  const digitos = limpo.replace(/\D/g, '');
  return digitos.length > 0 ? digitos : limpo;
}

/**
 * POST /api/login — `{ usuario, senha }`.
 * - Aceita tanto `admin` quanto o CPF numérico dos técnicos.
 * - Valida a senha contra o hash criptográfico com `scrypt`.
 * - Técnico desativado (`ativo = 0`) não entra.
 * - Retorna os dados do usuário autenticado para exibição no rodapé da barra lateral
 *   e grava a sessão num cookie HttpOnly assinado (Tarefa 63) — é esse cookie que o
 *   servidor confere nas rotas protegidas, e não o `localStorage` do navegador.
 */
export async function POST(request: Request) {
  const corpo = (await request.json().catch(() => null)) as CorpoLogin | null;
  const usuarioDigitado = typeof corpo?.usuario === 'string' ? corpo.usuario : '';
  const senha = typeof corpo?.senha === 'string' ? corpo.senha : '';

  if (!usuarioDigitado.trim() || !senha) {
    return NextResponse.json({ erro: 'Informe usuário e senha.' }, { status: 400 });
  }

  const usuarioNormalizado = normalizarUsuario(usuarioDigitado);

  const linha = getBanco()
    .prepare<[string], LinhaTecnicoLogin>(
      `SELECT id, nome_completo, funcao, usuario, senha, ativo
       FROM tecnicos
       WHERE LOWER(usuario) = LOWER(?)
       LIMIT 1`
    )
    .get(usuarioNormalizado);

  if (!linha || !linha.senha || linha.ativo !== 1 || !conferirSenha(senha, linha.senha)) {
    return NextResponse.json({ erro: 'Usuário ou senha inválidos.' }, { status: 401 });
  }

  return NextResponse.json(
    {
      ok: true,
      usuario: {
        id: linha.id,
        nome: linha.nome_completo,
        funcao: linha.funcao,
        usuario: linha.usuario,
      },
    },
    { headers: { 'Set-Cookie': cookieDeSessao(criarToken({ id: linha.id, usuario: linha.usuario ?? '' })) } }
  );
}

/**
 * GET /api/login — informa se o cookie ainda representa uma sessão válida e devolve
 * o **cadastro atual** do usuário.
 *
 * Duas funções:
 *
 * 1. Existe por causa da Tarefa 73: os dados que a tela usa para se considerar logada
 *    passaram a ficar em `localStorage`, que **não expira**. O cookie sim (8 h). Sem esta
 *    rota, quem abrisse o sistema no dia seguinte veria a tela montada e receberia 401 em
 *    cada chamada protegida — o sistema pareceria quebrado em vez de pedir a senha de novo.
 *
 * 2. Tarefa 75: devolve `nome` e `funcao` **do banco**, não a cópia antiga que ficou
 *    gravada no navegador. Sem isso, quem o admin renomeasse ou promovesse continuava
 *    vendo o texto velho no menu até entrar de novo. O formato é o mesmo do `POST`.
 *
 * Não devolve nada sensível: a coluna `senha` não entra.
 */
export async function GET(request: Request) {
  const sessao = lerSessao(request);
  if (!sessao) {
    return NextResponse.json({ erro: 'Sessão inválida ou expirada.' }, { status: 401 });
  }

  const perfil = buscarPerfilTecnico(sessao.id);
  if (!perfil) {
    // Cookie assinado de alguém que não existe mais no banco: a sessão não
    // representa ninguém, então vale o mesmo 401 que devolve o usuário ao login.
    return NextResponse.json({ erro: 'Sessão inválida ou expirada.' }, { status: 401 });
  }

  return NextResponse.json(
    {
      ok: true,
      usuario: {
        id: perfil.id,
        nome: perfil.nomeCompleto,
        funcao: perfil.funcao,
        usuario: perfil.usuario,
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        // Tarefa 78 — sessão deslizante: responder 200 já **renova** a sessão, emitindo
        // um token novo com 4 h a partir de agora. É o que faz o prazo contar como
        // tempo de inatividade em vez de tempo desde o login. O cookie é reescrito com
        // o mesmo `Max-Age`, então o navegador também passa a contar 4 h.
        'Set-Cookie': cookieDeSessao(
          criarToken({ id: perfil.id, usuario: perfil.usuario ?? '' })
        ),
      },
    }
  );
}

/**
 * DELETE /api/login — encerra a sessão.
 * Apaga o cookie assinado no servidor. O `localStorage` é limpo pelo `PortaoSessao`.
 */
export async function DELETE() {
  return NextResponse.json(
    { ok: true },
    { headers: { 'Set-Cookie': cookieDeSessaoApagada() } }
  );
}

