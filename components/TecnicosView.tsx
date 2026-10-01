'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import PerfilTecnico from '@/components/PerfilTecnico';
import TabelaTecnicos from '@/components/TabelaTecnicos';
import { obterUsuarioSessao, type UsuarioSessao } from '@/components/LoginModal';
import { formatarDataBr } from '@/lib/formato';
import { pode } from '@/lib/permissoes';
import type { Tecnico } from '@/lib/types';
import type { ErrosValidacao } from '@/lib/validacao';

type Props = {
  /** Técnicos carregados no servidor (SSR) e revalidados via router.refresh(). */
  tecnicosIniciais: Tecnico[];
};

/**
 * Tela da categoria "Técnicos": busca, botão de adicionar e duas listas separadas
 * na mesma tela (ativos e desativados).
 */
export default function TecnicosView({ tecnicosIniciais }: Props) {
  const router = useRouter();

  const [tecnicos, setTecnicos] = useState<Tecnico[]>(tecnicosIniciais);
  const [busca, setBusca] = useState('');
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [aniversariosAberto, setAniversariosAberto] = useState(false);

  /**
   * Modal único de técnico (Tarefa 64): `null` = fechado, `{ id: null }` = cadastro
   * novo, `{ id: 3 }` = edição do técnico 3.
   */
  const [tecnicoNoModal, setTecnicoNoModal] = useState<{ id: number | null } | null>(null);

  // Sessão do usuário logado: define o que ele pode ver/administrar (Tarefa 62).
  const [usuario, setUsuario] = useState<UsuarioSessao | null>(null);

  // Mantém a lista sincronizada após router.refresh() (o menu lateral também é atualizado).
  useEffect(() => {
    setTecnicos(tecnicosIniciais);
  }, [tecnicosIniciais]);

  // Recupera o usuário da sessão e reage a login/logout sem recarregar a página.
  useEffect(() => {
    setUsuario(obterUsuarioSessao());

    function aoMudarSessao(evento: Event) {
      const detalhe = (evento as CustomEvent<UsuarioSessao>).detail;
      setUsuario(detalhe ?? null);
    }

    window.addEventListener('dinf:login', aoMudarSessao);
    window.addEventListener('dinf:logout', aoMudarSessao);
    return () => {
      window.removeEventListener('dinf:login', aoMudarSessao);
      window.removeEventListener('dinf:logout', aoMudarSessao);
    };
  }, []);

  // Editar e desativar/reativar são exclusivos do admin (Tarefa 62).
  const ehAdmin = pode(usuario?.usuario, 'tecnicos:editar');
  const podeAdicionar = pode(usuario?.usuario, 'tecnicos:adicionar');

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return tecnicos;

    return tecnicos.filter(
      (tecnico) =>
        tecnico.nomeCompleto.toLowerCase().includes(termo) ||
        tecnico.funcao.toLowerCase().includes(termo)
    );
  }, [busca, tecnicos]);

  const ativos = useMemo(() => filtrados.filter((tecnico) => tecnico.ativo), [filtrados]);
  const desativados = useMemo(() => filtrados.filter((tecnico) => !tecnico.ativo), [filtrados]);

  /** Todos os técnicos (ativos + desativados) ordenados por mês/dia do aniversário. */
  const aniversarios = useMemo(
    () =>
      [...tecnicos].sort((a, b) => {
        const [, mesA, diaA] = a.dataNascimento.split('-');
        const [, mesB, diaB] = b.dataNascimento.split('-');
        return (
          `${mesA}${diaA}`.localeCompare(`${mesB}${diaB}`) ||
          a.nomeCompleto.localeCompare(b.nomeCompleto, 'pt-BR')
        );
      }),
    [tecnicos]
  );

  /** Substitui um técnico já existente no estado local. */
  function substituirTecnico(atualizado: Tecnico) {
    setTecnicos((atual) =>
      atual.map((tecnico) => (tecnico.id === atualizado.id ? atualizado : tecnico))
    );
  }

  /** Abre o modal único no modo cadastro (botão "+ Adicionar técnico"). */
  function abrirCadastro() {
    setErroGeral(null);
    setMensagem(null);
    setTecnicoNoModal({ id: null });
  }

  /** Abre o modal único preenchido, a partir do botão "Editar" da linha. */
  function abrirEdicao(tecnico: Tecnico) {
    setErroGeral(null);
    setMensagem(null);
    setTecnicoNoModal({ id: tecnico.id });
  }

  function fecharModal() {
    setTecnicoNoModal(null);
  }

  /** O modal gravou algo: revalida a lista vinda do servidor. */
  function aoSalvarNoModal() {
    router.refresh();
  }

  /** PATCH /api/tecnicos/:id alternando o campo `ativo`. */
  async function alternarAtivo(tecnico: Tecnico) {
    setErroGeral(null);

    try {
      const resposta = await requisitarFormulario(`/api/tecnicos/${tecnico.id}`, 'PATCH', {
        ativo: !tecnico.ativo,
      });

      substituirTecnico(resposta.tecnico as Tecnico);
      router.refresh();
    } catch (erro) {
      setErroGeral(mensagemDoErro(erro, 'Não foi possível atualizar o técnico.'));
    }
  }

  return (
    <>
      <header className="cabecalho">
        <div>
          <h1 className="cabecalho__titulo">Técnicos</h1>
          <p className="cabecalho__descricao">
            Cadastro da equipe técnica.
          </p>
        </div>
        {podeAdicionar && (
          <button type="button" className="botao" onClick={abrirCadastro}>
            + Adicionar técnico
          </button>
        )}
      </header>

      <div className="barra-ferramentas">
        <label className="campo campo-busca">
          <span className="campo__rotulo">Buscar</span>
          <input
            className="entrada"
            type="search"
            value={busca}
            placeholder="Nome ou função"
            onChange={(evento) => setBusca(evento.target.value)}
          />
        </label>
        <button type="button" className="botao botao--neutro" onClick={() => setAniversariosAberto(true)}>
          🎂 Aniversários
        </button>
      </div>

      {erroGeral && (
        <p className="alerta" role="alert">
          {erroGeral}
        </p>
      )}

      {mensagem && (
        <p className="alerta" role="status">
          {mensagem}
        </p>
      )}

      <TabelaTecnicos
        titulo="Técnicos ativos"
        descricao="Equipe disponível. Use o botão Desativar para mover o técnico para a lista de desativados."
        tecnicos={ativos}
        mensagemVazio={
          busca ? 'Nenhum técnico ativo encontrado para a busca.' : 'Nenhum técnico ativo cadastrado ainda.'
        }
        onAlternarAtivo={alternarAtivo}
        onEditar={abrirEdicao}
        mostrarAcoes={ehAdmin}
      />

      <TabelaTecnicos
        titulo="Técnicos desativados"
        descricao="Técnicos inativos, mantidos no histórico e fora da equipe ativa."
        tecnicos={desativados}
        mensagemVazio={
          busca ? 'Nenhum técnico desativado encontrado para a busca.' : 'Nenhum técnico desativado.'
        }
        onAlternarAtivo={alternarAtivo}
        onEditar={abrirEdicao}
        mostrarAcoes={ehAdmin}
        variacao="inativos"
      />

      {tecnicoNoModal && (
        <PerfilTecnico
          key={tecnicoNoModal.id ?? 'novo'}
          tecnicoId={tecnicoNoModal.id}
          nomeInicial={
            tecnicoNoModal.id === usuario?.id
              ? usuario.nome
              : (tecnicos.find((t) => t.id === tecnicoNoModal.id)?.nomeCompleto ?? '')
          }
          funcaoInicial={
            tecnicoNoModal.id === usuario?.id
              ? usuario.funcao
              : (tecnicos.find((t) => t.id === tecnicoNoModal.id)?.funcao ?? '')
          }
          onSalvo={aoSalvarNoModal}
          onFechar={fecharModal}
        />
      )}

      {aniversariosAberto && (
        <div
          className="sobreposicao"
          role="presentation"
          onMouseDown={(evento) => evento.target === evento.currentTarget && setAniversariosAberto(false)}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="titulo-modal-aniversarios">
            <header className="modal__cabecalho">
              <h2 className="modal__titulo" id="titulo-modal-aniversarios">
                🎂 Aniversários
              </h2>
              <button
                type="button"
                className="modal__fechar"
                onClick={() => setAniversariosAberto(false)}
                aria-label="Fechar"
              >
                ×
              </button>
            </header>

            <ul className="lista">
              {aniversarios.map((tecnico) => (
                <li className="item" key={tecnico.id}>
                  <span className="item__nome">{tecnico.nomeCompleto}</span>
                  <span className="etiqueta">{formatarDataBr(tecnico.dataNascimento)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

/** Erro de negócio; carrega os erros de validação por campo quando a API responde 400. */
class ErroAplicacao extends Error {
  errosValidacao?: ErrosValidacao;
}

/** Resposta das rotas de técnico consumidas por `requisitarFormulario`. */
type RespostaApi = {
  tecnico?: Tecnico;
  erros?: ErrosValidacao;
  erro?: string;
};

/**
 * fetch JSON com tratamento de erro padronizado.
 * HTTP 400 com `{ erros }` vira `ErroAplicacao.errosValidacao`.
 */
async function requisitarFormulario(
  url: string,
  metodo: 'POST' | 'PATCH',
  corpo: unknown
): Promise<RespostaApi> {
  const resposta = await fetch(url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });

  const dados = (await resposta.json().catch(() => ({}))) as RespostaApi;

  if (!resposta.ok) {
    const erro = new ErroAplicacao(dados.erro ?? 'Falha na requisição.');

    if (resposta.status === 400 && dados.erros) {
      erro.errosValidacao = dados.erros;
    }

    throw erro;
  }

  return dados;
}

/** Normaliza a mensagem exibida no alerta de erro. */
function mensagemDoErro(erro: unknown, padrao: string): string {
  return erro instanceof Error && erro.message ? erro.message : padrao;
}