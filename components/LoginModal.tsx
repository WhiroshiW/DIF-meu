'use client';

import { useEffect, useState } from 'react';

export type UsuarioSessao = {
  id: number;
  nome: string;
  funcao: string;
  usuario: string | null;
};

const CHAVE_SESSAO = 'dinf:sessao_usuario';

/** Nome da chave, exportado para o `PortaoSessao` reconhecer o evento `storage` (T73). */
export const CHAVE_SESSAO_LOCAL = CHAVE_SESSAO;

/**
 * Lê a sessão salva em localStorage (se houver).
 *
 * Tarefa 73: a sessão migrou de `sessionStorage` para `localStorage`. O `sessionStorage`
 * é por aba e morre ao fechar o navegador, mas o cookie `dinf_sessao` tem `Max-Age` de
 * 8 h e sobrevivia — a sessão do servidor continuava válida e a tela, não. No
 * `localStorage` as duas camadas vivem juntas e o sistema volta logado ao reabrir.
 */
export function obterUsuarioSessao(): UsuarioSessao | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const bruto = window.localStorage.getItem(CHAVE_SESSAO);
    return bruto ? (JSON.parse(bruto) as UsuarioSessao) : null;
  } catch {
    return null;
  }
}

/** Salva a sessão em localStorage. */
export function salvarUsuarioSessao(usuario: UsuarioSessao) {
  try {
    window.localStorage.setItem(CHAVE_SESSAO, JSON.stringify(usuario));
  } catch {
    // localStorage indisponível (modo privado cheio, política do navegador)
  }
}

/** Limpa a sessão de localStorage. */
export function limparUsuarioSessao() {
  try {
    window.localStorage.removeItem(CHAVE_SESSAO);
  } catch {
    // localStorage indisponível
  }
}

/**
 * Modal de login que bloqueia o sistema (Tarefas 54, 56 e 60).
 *
 * É montado no `app/layout.tsx` como irmão de `.app` e NÃO por portal: sendo filho
 * direto do `<body>`, o `position: fixed` não fica preso a nenhum contexto de
 * empilhamento (a sidebar é `sticky`) e o `z-index` fica acima dos demais modais.
 *
 * Autentica técnicos (por CPF numérico ou formatado) e o admin.
 * Com a credencial aceita, armazena os dados em localStorage, despacha
 * o evento customizado `dinf:login` para a Sidebar e fecha o modal.
 */
export default function LoginModal() {
  const [liberado, setLiberado] = useState(false);
  const [usuario, setUsuario] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    // Se já havia sessão salva neste navegador, recupera (T73: com `localStorage`,
    // isso agora vale também depois de fechar e reabrir o navegador).
    const sessaoExistente = obterUsuarioSessao();
    if (sessaoExistente) {
      setLiberado(true);
      window.dispatchEvent(
        new CustomEvent<UsuarioSessao>('dinf:login', { detail: sessaoExistente })
      );
    }

    // Limpa a sessão APENAS quando o logout chega com o modal já na tela — normalmente
    // quem apaga a sessão é o `PortaoSessao` (Tarefa 72), que é o componente que
    // permanece montado o tempo todo. Aqui o papel é só zerar os campos do formulário,
    // para o próximo login não vir preenchido.
    function aoDeslogar() {
      void fetch('/api/login', { method: 'DELETE' }).catch(() => undefined);
      limparUsuarioSessao();
      setLiberado(false);
      setUsuario('');
      setSenha('');
      setErro('');
    }

    window.addEventListener('dinf:logout', aoDeslogar);

    return () => {
      window.removeEventListener('dinf:logout', aoDeslogar);
    };
  }, []);

  /** Valida os campos na API e libera o sistema quando a credencial bate. */
  async function confirmar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();

    if (enviando) {
      return;
    }

    if (!usuario.trim() || !senha) {
      setErro('Informe usuário e senha.');
      return;
    }

    setEnviando(true);
    setErro('');

    try {
      const resposta = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: usuario.trim(), senha }),
      });

      if (!resposta.ok) {
        setErro('Usuário ou senha inválidos.');
        return;
      }

      const dados = (await resposta.json()) as { ok?: boolean; usuario?: UsuarioSessao };
      if (dados?.usuario) {
        salvarUsuarioSessao(dados.usuario);
        window.dispatchEvent(
          new CustomEvent<UsuarioSessao>('dinf:login', { detail: dados.usuario })
        );
      }

      setLiberado(true);
    } catch {
      setErro('Não foi possível entrar. Tente novamente.');
    } finally {
      setEnviando(false);
    }
  }

  if (liberado) {
    return null;
  }

  return (
    <div className="sobreposicao sobreposicao--login" role="presentation">
      {/* Selo do ET sobre a borda superior do cartão (Tarefa 55): mesmo desenho do
          favicon, herdando a cor do selo escuro. */}
      <div className="modal modal--login" role="dialog" aria-modal="true" aria-labelledby="titulo-modal-login">
        <span className="login__selo" aria-hidden="true">
          <svg viewBox="0 0 64 64" focusable="false">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M32 4C17.6 4 8 13.4 8 26.6C8 40.2 17.4 51.6 32 60C46.6 51.6 56 40.2 56 26.6C56 13.4 46.4 4 32 4ZM16.5 27.5Q22 21 29 32.5Q22 36 16.5 27.5ZM47.5 27.5Q42 21 35 32.5Q42 36 47.5 27.5Z"
            />
          </svg>
        </span>

        <header className="modal__cabecalho">
          <h2 className="modal__titulo modal__titulo--centro" id="titulo-modal-login">
            Suporte Subterrâneo
          </h2>
        </header>

        <form className="formulario" onSubmit={confirmar} noValidate>
          <label className={`login__campo ${erro ? 'login__campo--erro' : ''}`}>
            <span className="login__campo-icone" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path
                  fill="currentColor"
                  d="M12 11.1c1.7 0 3.1-1.4 3.1-3.1 0-1.7-1.4-3.1-3.1-3.1S8.9 6.3 8.9 8c0 1.7 1.4 3.1 3.1 3.1Zm0 1.4c-2.4 0-7.1 1.2-7.1 3.6v1.6c0 .5.4.8.8.8h12.6c.4 0 .8-.3.8-.8v-1.6c0-2.4-4.7-3.6-7.1-3.6Z"
                />
              </svg>
            </span>
            <span className="login__campo-texto">Usuário</span>
            <input
              className="login__campo-entrada"
              type="text"
              value={usuario}
              autoFocus
              autoComplete="username"
              placeholder="Usuário ou CPF"
              aria-label="Usuário ou CPF"
              onChange={(evento) => {
                setUsuario(evento.target.value);
                setErro('');
              }}
            />
          </label>

          <label className={`login__campo ${erro ? 'login__campo--erro' : ''}`}>
            <span className="login__campo-icone" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path
                  fill="currentColor"
                  d="M12 2.6a3.9 3.9 0 0 0-3.9 3.9v2.6H7.2c-.7 0-1.2.5-1.2 1.2v8.3c0 .7.5 1.2 1.2 1.2h9.6c.7 0 1.2-.5 1.2-1.2v-8.3c0-.7-.5-1.2-1.2-1.2h-.9V6.5A3.9 3.9 0 0 0 12 2.6Zm0 1.9a2 2 0 0 1 2 2v2.6h-4V6.5a2 2 0 0 1 2-2Zm0 7a1.7 1.7 0 0 1 .9 3.1v1.2a.9.9 0 0 1-1.8 0v-1.2a1.7 1.7 0 0 1 .9-3.1Z"
                />
              </svg>
            </span>
            <span className="login__campo-texto">Senha</span>
            <input
              className="login__campo-entrada"
              type="password"
              value={senha}
              autoComplete="current-password"
              placeholder="Senha"
              aria-label="Senha"
              onChange={(evento) => {
                setSenha(evento.target.value);
                setErro('');
              }}
            />
          </label>

          {erro && (
            <p className="login__aviso" role="alert">
              {erro}
            </p>
          )}

          <div className="modal__acoes">
            <button type="submit" className="botao" disabled={enviando}>
              {enviando ? 'Entrando…' : 'Entrar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
