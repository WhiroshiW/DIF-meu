'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { obterUsuarioSessao, type UsuarioSessao } from '@/components/LoginModal';
import { pode } from '@/lib/permissoes';
import { validarTecnico, type ErrosValidacao } from '@/lib/validacao';
import type { PerfilTecnico } from '@/lib/types';

type Props = {
  /** Fecha o modal (botão "Fechar", "Cancelar", ×, Esc ou clique no fundo). */
  onFechar: () => void;
  /** Id do técnico aberto; `null` = novo cadastro (Tarefa 64). */
  tecnicoId: number | null;
  /** Nome e função da sessão, usados enquanto o perfil carrega. */
  nomeInicial?: string;
  funcaoInicial?: string;
  /** Chamado depois de gravar, para a tela recarregar a lista. */
  onSalvo?: () => void;
};

/**
 * Funções disponíveis para seleção no perfil do técnico (definidas no código).
 * A função já cadastrada no banco é aceita mesmo fora desta lista (option "extra").
 */
export const FUNCOES_DISPONIVEIS = [
  'Manutenção',
  'N1',
  'N2',
  'N3',
  'Suporte externo',
  'Estagiário',
] as const;

export type FuncaoTecnico = (typeof FUNCOES_DISPONIVEIS)[number];

/**
 * Modal único de técnico (Tarefas 45/47/48, 61, 63 e 64).
 *
 * Serve a três casos, com o mesmo formulário:
 * - `tecnicoId === null`: **novo cadastro** (botão "+ Adicionar técnico"), que salva
 *   com `POST /api/tecnicos` — rota já exclusiva do admin;
 * - `tecnicoId === meu id`: o técnico logado editando o próprio perfil;
 * - `tecnicoId` de outra pessoa: aberto pelo admin a partir da tela de Técnicos.
 *
 * Carrega os dados reais via `GET /api/tecnicos/:id` (nome, telefone, função, data de
 * nascimento, e-mail e usuário/CPF somente leitura). A senha vem OCULTADA: só aparece
 * ao clicar no link "Redefinir senha", e só é gravada (como hash `scrypt`) quando
 * preenchida no "Salvar". O admin, ao editar outra pessoa, ainda pode devolver a senha
 * dela para a senha padrão (Tarefa 63).
 *
 * Renderizado por PORTAL no `<body>` (Tarefa 47): a sidebar é `position: sticky`, o que
 * cria um contexto de empilhamento próprio. Sem o portal, o `z-index` do modal ficaria
 * preso a esse contexto e elementos posicionados do conteúdo (ex.: os dias do calendário
 * da Agenda) seriam pintados por cima dele.
 */
export default function PerfilTecnico({
  onFechar,
  tecnicoId,
  nomeInicial = '',
  funcaoInicial = '',
  onSalvo,
}: Props) {
  const ehNovoCadastro = tecnicoId === null;

  const [nome, setNome] = useState(nomeInicial);
  const [telefone, setTelefone] = useState('');
  const [funcao, setFuncao] = useState<string>(funcaoInicial);
  const [dataNascimento, setDataNascimento] = useState('');
  const [email, setEmail] = useState('');
  const [usuario, setUsuario] = useState<string | null>(null);

  // Sessão do visitante: define se ele administra a equipe (Tarefa 63).
  const [sessao, setSessao] = useState<UsuarioSessao | null>(null);

  const [carregando, setCarregando] = useState(!ehNovoCadastro);
  const [erroCarregamento, setErroCarregamento] = useState<string | null>(null);

  // Senha oculta por padrão; o link "Redefinir senha" revela o campo (Tarefa 61).
  const [redefinindoSenha, setRedefinindoSenha] = useState(false);
  const [senha, setSenha] = useState('');

  const [erros, setErros] = useState<ErrosValidacao>({});
  const [salvando, setSalvando] = useState(false);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [erroSalvar, setErroSalvar] = useState<string | null>(null);

  /** Aplica ao formulário os dados de um perfil recém-lido do banco. */
  function aplicarPerfil(perfil: PerfilTecnico) {
    setNome(perfil.nomeCompleto);
    setTelefone(perfil.telefone ?? '');
    setFuncao(perfil.funcao);
    setDataNascimento(perfil.dataNascimento);
    setEmail(perfil.email ?? '');
    setUsuario(perfil.usuario);
  }

  // Sessão do visitante e papel do usuário (Tarefa 63).
  useEffect(() => {
    setSessao(obterUsuarioSessao());

    function aoMudarSessao(evento: Event) {
      setSessao((evento as CustomEvent<UsuarioSessao>).detail ?? null);
    }

    window.addEventListener('dinf:login', aoMudarSessao);
    window.addEventListener('dinf:logout', aoMudarSessao);
    return () => {
      window.removeEventListener('dinf:login', aoMudarSessao);
      window.removeEventListener('dinf:logout', aoMudarSessao);
    };
  }, []);

  // Carrega o perfil do técnico aberto; no cadastro novo não há o que carregar (T64).
  useEffect(() => {
    if (tecnicoId === null) {
      return;
    }

    let cancelado = false;

    async function carregar() {
      try {
        const resposta = await fetch(`/api/tecnicos/${tecnicoId}`, { cache: 'no-store' });
        const dados = (await resposta.json().catch(() => null)) as
          | { perfil?: PerfilTecnico; erro?: string }
          | null;

        if (cancelado) return;

        if (!resposta.ok || !dados?.perfil) {
          setErroCarregamento(dados?.erro ?? 'Não foi possível carregar o perfil.');
          return;
        }

        aplicarPerfil(dados.perfil);
      } catch {
        if (!cancelado) {
          setErroCarregamento('Não foi possível carregar o perfil.');
        }
      } finally {
        if (!cancelado) setCarregando(false);
      }
    }

    carregar();
    return () => {
      cancelado = true;
    };
  }, [tecnicoId]);

  // Esc fecha o modal (ouvinte ativo só enquanto ele está montado).
  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === 'Escape') onFechar();
    }

    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [onFechar]);

  /** Grava o técnico: `POST` no cadastro novo, `PATCH` na edição (Tarefa 64). */
  async function salvar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();

    setErroSalvar(null);
    setMensagem(null);

    if (redefinindoSenha && !senha.trim()) {
      setErros({ senha: 'Informe a nova senha ou cancele a redefinição.' });
      return;
    }

    const validacao = validarTecnico({ nomeCompleto: nome, funcao, dataNascimento });
    if (!validacao.valido) {
      setErros(validacao.erros);
      return;
    }
    setErros({});

    setSalvando(true);
    try {
      // No cadastro novo o servidor só aceita admin e grava os três campos
      // cadastrais; telefone/e-mail/senha ficam para a edição seguinte.
      const resposta = await fetch(
        ehNovoCadastro ? '/api/tecnicos' : `/api/tecnicos/${tecnicoId}`,
        {
          method: ehNovoCadastro ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            ehNovoCadastro
              ? { nomeCompleto: nome, funcao, dataNascimento }
              : {
                  nomeCompleto: nome,
                  // Tarefa 79: quem não é admin não altera função — e o campo do
                  // servidor rejeita o envio. Omitir o campo é o que permite ao
                  // técnico salvar o próprio perfil sem levar 403.
                  ...(ehAdmin ? { funcao } : {}),
                  dataNascimento,
                  telefone,
                  email,
                  ...(redefinindoSenha ? { senha } : {}),
                }
          ),
        }
      );

      const dados = (await resposta.json().catch(() => null)) as
        | { perfil?: PerfilTecnico; erros?: ErrosValidacao; erro?: string }
        | null;

      if (!resposta.ok) {
        if (dados?.erros) {
          setErros(dados.erros);
        } else {
          setErroSalvar(dados?.erro ?? 'Não foi possível salvar.');
        }
        return;
      }

      if (dados?.perfil) aplicarPerfil(dados.perfil);
      setSenha('');
      setRedefinindoSenha(false);
      setMensagem(ehNovoCadastro ? 'Técnico cadastrado com sucesso.' : 'Perfil salvo com sucesso.');
      onSalvo?.();
    } catch {
      setErroSalvar('Não foi possível salvar.');
    } finally {
      setSalvando(false);
    }
  }

  /**
   * Revela o campo de nova senha. Ao editar **outro** usuário (caso do admin na
   * tela de Técnicos), pede confirmação antes, nomeando quem será alterado
   * (Tarefa 65). No próprio perfil a pergunta seria redundante e é pulada.
   */
  function abrirRedefinicaoSenha() {
    const editandoOutro = !ehNovoCadastro && sessao?.id !== tecnicoId;

    if (editandoOutro) {
      const nomeUsuario = nome.trim() || 'este usuário';

      if (!window.confirm(`Deseja redefinir a senha do usuário ${nomeUsuario}?`)) {
        return;
      }
    }

    setErroSalvar(null);
    setRedefinindoSenha(true);
  }

  const funcaoForaDaLista = funcao !== '' && !FUNCOES_DISPONIVEIS.includes(funcao as FuncaoTecnico);

  // Campos travados durante o carregamento (fora isso, editáveis).
  const campoBloqueado = carregando;

  // Tarefa 79 — a função é gerência de equipe: só o administrador altera. O campo
  // continua visível (aparece preenchido), porém travado, com a dica abaixo
  // explicando o porquê. A mesma regra é cobrada no servidor, no `PATCH`
  // (`app/api/tecnicos/[id]/route.ts`) — campo desabilitado é interface, não trava.
  const ehAdmin = pode(sessao?.usuario, 'tecnicos:editar');
  const funcaoTravadaPorPermissao = !ehAdmin && !carregando;

  return createPortal(
    <div
      className="sobreposicao"
      role="presentation"
      onMouseDown={(evento) => evento.target === evento.currentTarget && onFechar()}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="titulo-modal-perfil">
        <header className="modal__cabecalho">
          <h2 className="modal__titulo" id="titulo-modal-perfil">
            {ehNovoCadastro ? 'Adicionar técnico' : 'Perfil do técnico'}
          </h2>
          <button type="button" className="modal__fechar" onClick={onFechar} aria-label="Fechar">
            ×
          </button>
        </header>

        <form className="formulario" onSubmit={salvar} noValidate>
          <label className="campo">
            <span className="campo__rotulo">Nome</span>
            <input
              className={`entrada ${erros.nomeCompleto ? 'entrada--erro' : ''}`}
              type="text"
              value={nome}
              autoFocus
              disabled={campoBloqueado}
              placeholder="Ex.: Maria Silva Souza"
              onChange={(evento) => setNome(evento.target.value)}
            />
            {erros.nomeCompleto && <span className="campo__erro">{erros.nomeCompleto}</span>}
          </label>

          <label className="campo">
            <span className="campo__rotulo">Telefone</span>
            <input
              className="entrada"
              type="tel"
              value={telefone}
              disabled={campoBloqueado}
              placeholder="Ex.: (00) 00000-0000"
              onChange={(evento) => setTelefone(evento.target.value)}
            />
          </label>

          <label className="campo">
            <span className="campo__rotulo">Função</span>
            <select
              className={`entrada ${erros.funcao ? 'entrada--erro' : ''}`}
              value={funcao}
              disabled={campoBloqueado || funcaoTravadaPorPermissao}
              onChange={(evento) => setFuncao(evento.target.value)}
            >
              <option value="">Selecione uma função...</option>
              {funcaoForaDaLista && <option value={funcao}>{funcao}</option>}
              {FUNCOES_DISPONIVEIS.map((opcao) => (
                <option key={opcao} value={opcao}>
                  {opcao}
                </option>
              ))}
            </select>
            {erros.funcao && <span className="campo__erro">{erros.funcao}</span>}
          </label>

          <label className="campo">
            <span className="campo__rotulo">Data de nascimento</span>
            <input
              className={`entrada ${erros.dataNascimento ? 'entrada--erro' : ''}`}
              type="date"
              value={dataNascimento}
              disabled={campoBloqueado}
              onChange={(evento) => setDataNascimento(evento.target.value)}
            />
            {erros.dataNascimento && <span className="campo__erro">{erros.dataNascimento}</span>}
          </label>

          <label className="campo">
            <span className="campo__rotulo">E-mail</span>
            <input
              className="entrada"
              type="email"
              value={email}
              disabled={campoBloqueado}
              placeholder="Ex.: tecnico@dinf.local"
              onChange={(evento) => setEmail(evento.target.value)}
            />
          </label>

          <label className="campo">
            <span className="campo__rotulo">Usuário/CPF</span>
            <input
              className="entrada"
              type="text"
              value={usuario ?? ''}
              readOnly
              disabled={campoBloqueado}
              title="Identificador de login — não pode ser alterado por aqui."
              placeholder="CPF"
              onChange={() => undefined}
            />
          </label>

          {redefinindoSenha ? (
            <label className="campo">
              <span className="campo__rotulo">Nova senha</span>
              <input
                className={`entrada ${erros.senha ? 'entrada--erro' : ''}`}
                type="password"
                value={senha}
                autoComplete="new-password"
                placeholder="Defina uma nova senha"
                onChange={(evento) => setSenha(evento.target.value)}
              />
              {erros.senha && <span className="campo__erro">{erros.senha}</span>}
            </label>
          ) : (
            <button
              type="button"
              className="perfil__link"
              onClick={abrirRedefinicaoSenha}
            >
              Redefinir senha
            </button>
          )}

          {erroCarregamento && <p className="perfil__nota">{erroCarregamento}</p>}
          {erroSalvar && <span className="campo__erro">{erroSalvar}</span>}
          {mensagem && !erroSalvar && <p className="perfil__nota">{mensagem}</p>}

          <div className="modal__acoes">
            <button type="button" className="botao botao--neutro" onClick={onFechar} disabled={salvando}>
              Fechar
            </button>
            <button type="submit" className="botao" disabled={salvando || carregando}>
              {salvando
                ? 'Salvando...'
                : ehNovoCadastro
                  ? 'Cadastrar técnico'
                  : 'Salvar'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
