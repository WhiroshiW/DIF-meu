import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * Sessão assinada no servidor (Tarefa 63).
 *
 * Até a Tarefa 62 o sistema guardava o usuário logado apenas no armazenamento do
 * navegador (`sessionStorage` até a Tarefa 72, `localStorage` desde a Tarefa 73), que
 * é do cliente: qualquer pessoa poderia forjar `usuario: "admin"`. Aqui a
 * sessão vira um cookie **HttpOnly** assinado com HMAC-SHA256 — o JavaScript da
 * página não tem acesso a ele e o servidor confere a assinatura a cada rota.
 *
 * Formato do token: `base64url(payload).base64url(HMAC-SHA256(payload))`.
 * Sem dependência nova: só `node:crypto` e `node:fs`.
 */

/** Nome do cookie lido pelo servidor. */
export const COOKIE_SESSAO = 'dinf_sessao';

/**
 * Validade da sessão (4 horas) — Tarefa 78.
 *
 * É um prazo de **inatividade**, não um prazo de login: a cada uso o `GET /api/login`
 * reemite o cookie com um token novo, e o contador recomeça. Quem ficar 4 h sem
 * clicar, digitar ou rolar perde a sessão; quem está trabalhando renova sozinho.
 *
 * O mesmo valor alimenta o `exp` do token e o `Max-Age` do cookie: se divergissem, um
 * dos dois sobreviveria ao outro sem nenhum ganho.
 */
const VALIDADE_MS = 4 * 60 * 60 * 1000;

/** Caminho do arquivo com o segredo, usado quando não há `DINF_SECRET`. */
const CAMINHO_DO_SEGREDO = path.join(process.cwd(), 'data', '.segredo_sessao');

/** Identidade do usuário autenticado, como vai dentro do token. */
export type SessaoUsuario = {
  id: number;
  usuario: string;
  /** Data de expiração em milissegundos (epoch). */
  exp: number;
};

let segredoEmCache: string | null = null;

/**
 * Segredo usado para assinar a sessão.
 * Ordem: variável de ambiente `DINF_SECRET` → arquivo `data/.segredo_sessao`
 * (gerado uma única vez, para que a sessão sobreviva a reinícios do servidor).
 */
function segredo(): string {
  if (segredoEmCache) {
    return segredoEmCache;
  }

  const doAmbiente = process.env.DINF_SECRET?.trim();
  if (doAmbiente) {
    segredoEmCache = doAmbiente;
    return segredoEmCache;
  }

  try {
    if (fs.existsSync(CAMINHO_DO_SEGREDO)) {
      const conteudo = fs.readFileSync(CAMINHO_DO_SEGREDO, 'utf8').trim();
      if (conteudo) {
        segredoEmCache = conteudo;
        return segredoEmCache;
      }
    }
  } catch {
    // Segue para a geração abaixo.
  }

  const novo = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(CAMINHO_DO_SEGREDO), { recursive: true });
    fs.writeFileSync(CAMINHO_DO_SEGREDO, novo, { encoding: 'utf8', flag: 'wx' });
  } catch {
    // Se não deu para gravar (outro processo ganhou a corrida, pasta sem permissão,
    // modo somente-leitura), a sessão vale apenas enquanto o processo estiver vivo.
  }

  segredoEmCache = novo;
  return segredoEmCache;
}

function assinar(conteudo: string): string {
  return createHmac('sha256', segredo()).update(conteudo).digest('base64url');
}

/** Gera o token assinado da sessão para um usuário. */
export function criarToken(dados: { id: number; usuario: string }): string {
  const payload: SessaoUsuario = {
    id: dados.id,
    usuario: dados.usuario,
    exp: Date.now() + VALIDADE_MS,
  };

  const conteudo = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${conteudo}.${assinar(conteudo)}`;
}

/**
 * Valida o token e devolve os dados da sessão, ou `null` quando o token é
 * inválido, adulterado ou expirado. A assinatura é comparada em tempo constante.
 */
export function verificarToken(token: string | undefined): SessaoUsuario | null {
  if (!token) {
    return null;
  }

  const partes = token.split('.');
  if (partes.length !== 2) {
    return null;
  }

  const [conteudo, assinatura] = partes;

  const esperada = Buffer.from(assinar(conteudo));
  const recebida = Buffer.from(assinatura);
  if (esperada.length !== recebida.length || !timingSafeEqual(esperada, recebida)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(conteudo, 'base64url').toString('utf8')
    ) as SessaoUsuario;

    if (typeof payload.id !== 'number' || typeof payload.usuario !== 'string') {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/** Lê um cookie específico do cabeçalho `Cookie` da requisição. */
function lerCookie(cabecalho: string | null, nome: string): string | undefined {
  if (!cabecalho) {
    return undefined;
  }

  for (const parte of cabecalho.split(';')) {
    const separador = parte.indexOf('=');
    if (separador === -1) continue;

    if (parte.slice(0, separador).trim() === nome) {
      return decodeURIComponent(parte.slice(separador + 1).trim());
    }
  }

  return undefined;
}

/** Sessão do usuário da requisição, ou `null` quando não há login válido. */
export function lerSessao(request: Request): SessaoUsuario | null {
  return verificarToken(lerCookie(request.headers.get('cookie'), COOKIE_SESSAO));
}

/** Cabeçalho `Set-Cookie` que grava a sessão. */
export function cookieDeSessao(token: string): string {
  const maxAge = Math.floor(VALIDADE_MS / 1000);
  return `${COOKIE_SESSAO}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

/** Cabeçalho `Set-Cookie` que encerra a sessão. */
export function cookieDeSessaoApagada(): string {
  return `${COOKIE_SESSAO}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/**
 * Guarda de sessão para Route Handlers (Tarefa 74).
 *
 * Devolve a resposta **401 pronta** quando a requisição não tem sessão válida, ou
 * `null` quando o acesso pode seguir. A mensagem fica em um lugar só de propósito:
 * antes desta tarefa ela aparecia repetida em cada rota, e foi justamente a repetição
 * que deixou `/api/eventos`, `/api/sugestoes` e as do GLPI sem trava nenhuma.
 *
 * Usar assim, no começo do handler e antes de ler corpo, parâmetros ou banco:
 *
 *   const semSessao = bloquearSemSessao(request);
 *   if (semSessao) return semSessao;
 */
export function bloquearSemSessao(request: Request): NextResponse | null {
  if (lerSessao(request)) {
    return null;
  }

  return NextResponse.json({ erro: 'Sessão não reconhecida. Entre novamente.' }, { status: 401 });
}

/**
 * Diz se a requisição que está sendo montada **no servidor** tem sessão válida
 * (Tarefa 77).
 *
 * É o parente do `bloquearSemSessao()` para **Server Components**. As páginas que
 * consultam o banco (`app/agenda/page.tsx`, `app/tecnicos/page.tsx`) montam o HTML
 * no servidor; se elas lessem os dados sem olhar a sessão, o banco inteiro viajaria
 * na resposta para quem não entrou — o bloqueio do `PortaoSessao` acontece depois,
 * no navegador, e não alcança isso.
 *
 * Uso obrigatório (o verificador `scripts/conferir-rotas-protegidas.js` reprova a
 * compilação de página que usa repositório de dados sem esta chamada):
 *
 *   export default async function MinhaPagina() {
 *     if (!(await temSessaoNoServidor())) {
 *       return null;
 *     }
 *     ...aqui le o banco...
 *   }
 *
 * Só funciona durante uma requisição (é para Server Components e Route Handlers).
 * `lib/sessao.ts` é importado apenas pelo servidor.
 */
export async function temSessaoNoServidor(): Promise<boolean> {
  const cookie = (await cookies()).get(COOKIE_SESSAO)?.value;
  return verificarToken(cookie) !== null;
}
