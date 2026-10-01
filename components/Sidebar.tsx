'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import PerfilTecnico from '@/components/PerfilTecnico';
import { iniciais } from '@/lib/formato';
import { obterUsuarioSessao, type UsuarioSessao } from '@/components/LoginModal';
import { ABAS, ABA_PADRAO, abaDaUrl, type Aba } from '@/lib/abasGlpi';

type ItemCategoria = {
  rotulo: string;
  caminho: string;
  /** Categoria reservada, ainda sem conteúdo próprio (exibe o selo "em breve"). */
  pendente?: boolean;
  /**
   * Submenu que aparece recuado logo abaixo da categoria (Tarefa 106). No GLPI
   * são as abas do painel; escolher uma grava `?aba=` na URL, que é de onde o
   * painel lê.
   */
  submenu?: Aba[];
};

/** Categorias do menu lateral, na ordem em que aparecem. */
const CATEGORIAS: ItemCategoria[] = [
  { rotulo: 'Agenda', caminho: '/agenda' },
  {
    rotulo: 'GLPI',
    caminho: '/glpi',
    submenu: ABAS.map((aba) => aba.id),
  },
  { rotulo: 'Técnicos', caminho: '/tecnicos' },
];

/** Dados exibidos no rodapé do menu; `id` é o do técnico logado (Tarefa 61). */
type UsuarioExibido = {
  id: number | null;
  nome: string;
  funcao: string;
};

/** Dados padrão exibidos quando nenhum técnico está autenticado. */
const TECNICO_PADRAO: UsuarioExibido = {
  id: null,
  nome: 'Técnico DINF',
  funcao: 'Suporte técnico',
};

/**
 * Menu lateral esquerdo de categorias.
 * Cada categoria é um único item de navegação: clicar abre a rota correspondente.
 * No rodapé há o bloco do técnico autenticado (nome + função) e os botões Perfil e Sair.
 */
export default function Sidebar() {
  const caminho = usePathname();
  const parametros = useSearchParams();
  /** Aba do GLPI aberta agora, lida da URL — o painel lê a mesma coisa (T106). */
  const abaAtiva: Aba = abaDaUrl(parametros.get('aba') ?? ABA_PADRAO);
  const [perfilAberto, setPerfilAberto] = useState(false);
  const [usuarioAtual, setUsuarioAtual] = useState<UsuarioExibido>(TECNICO_PADRAO);

  useEffect(() => {
    // Carrega usuário da sessão ao montar (se houver)
    const salvo = obterUsuarioSessao();
    if (salvo) {
      setUsuarioAtual({
        id: salvo.id,
        nome: salvo.nome,
        funcao: salvo.funcao,
      });
    }

    // Ouve evento disparado no login bem-sucedido
    function aoLogar(evento: Event) {
      const custom = evento as CustomEvent<UsuarioSessao>;
      if (custom.detail) {
        setUsuarioAtual({
          id: custom.detail.id,
          nome: custom.detail.nome,
          funcao: custom.detail.funcao,
        });
      }
    }

    // Tarefa 75: o `PortaoSessao` emite `dinf:sessao` quando o servidor devolve nome ou
    // função diferentes da cópia salva. Mesmo tratamento do `dinf:login`, porque é o mesmo
    // dado chegando por outro caminho.
    function aoMudarSessao(evento: Event) {
      aoLogar(evento);
    }

    // Ouve evento disparado no logout
    function aoDeslogar() {
      setUsuarioAtual(TECNICO_PADRAO);
    }

    window.addEventListener('dinf:login', aoLogar);
    window.addEventListener('dinf:sessao', aoMudarSessao);
    window.addEventListener('dinf:logout', aoDeslogar);

    return () => {
      window.removeEventListener('dinf:login', aoLogar);
      window.removeEventListener('dinf:sessao', aoMudarSessao);
      window.removeEventListener('dinf:logout', aoDeslogar);
    };
  }, []);

  return (
    <aside className="sidebar">
      <div className="marca">
        {/* Silhueta de ET no lugar do antigo quadradinho azul com a sigla DINF (Tarefa 53).
            Mesmo desenho do favicon (app/icon.svg), herdando a cor do menu. */}
        <svg
          className="marca__icone"
          viewBox="0 0 64 64"
          role="img"
          aria-label="DINF"
          focusable="false"
        >
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M32 4C17.6 4 8 13.4 8 26.6C8 40.2 17.4 51.6 32 60C46.6 51.6 56 40.2 56 26.6C56 13.4 46.4 4 32 4ZM16.5 27.5Q22 21 29 32.5Q22 36 16.5 27.5ZM47.5 27.5Q42 21 35 32.5Q42 36 47.5 27.5Z"
          />
        </svg>
        <span className="marca__nome">Suporte Subterrâneo</span>
      </div>

      <p className="menu__titulo">Categorias</p>

      {CATEGORIAS.map((categoria) => {
        const ativa = caminho.startsWith(categoria.caminho);

        return (
          <div className="categoria" key={categoria.caminho}>
            <Link
              href={categoria.caminho}
              className={`categoria__botao ${ativa ? 'categoria__botao--ativa' : ''}`}
            >
              <span className="categoria__nome">{categoria.rotulo}</span>
              {categoria.pendente && <span className="categoria__aviso">em breve</span>}
            </Link>
            {/* Submenu recuado, só da categoria aberta (Tarefa 106). */}
            {categoria.submenu && ativa && (
              <div className="categoria__submenu">
                {ABAS.filter((aba) => categoria.submenu?.includes(aba.id)).map((aba) => (
                  <Link
                    key={aba.id}
                    href={`${categoria.caminho}?aba=${aba.id}`}
                    className={`categoria__subitem${abaAtiva === aba.id ? ' categoria__subitem--ativo' : ''}`}
                    aria-current={abaAtiva === aba.id ? 'page' : undefined}
                  >
                    <span className="categoria__subitem-icone" aria-hidden="true">
                      {aba.icone}
                    </span>
                    <span>{aba.rotulo}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="menu__usuario">
        <div className="menu__usuario-topo">
          <span className="avatar">{iniciais(usuarioAtual.nome)}</span>
          <span className="menu__usuario-dados">
            <span className="menu__usuario-nome">{usuarioAtual.nome}</span>
            <span className="menu__usuario-funcao">{usuarioAtual.funcao}</span>
          </span>
        </div>
        <div className="menu__usuario-acoes">
          <button
            type="button"
            className="menu__usuario-botao"
            onClick={() => setPerfilAberto(true)}
            title="Abrir perfil do técnico"
          >
            Perfil
          </button>
          <button
            type="button"
            className="menu__usuario-botao menu__usuario-botao--sair"
            onClick={() => {
              if (window.confirm('deseja mesmo sair do sistema?')) {
                setPerfilAberto(false);
                window.dispatchEvent(new CustomEvent('dinf:logout'));
              }
            }}
            title="Sair do sistema (deslogar)"
          >
            Sair
          </button>
        </div>
      </div>

      {perfilAberto && usuarioAtual.id !== null && (
        <PerfilTecnico
          tecnicoId={usuarioAtual.id}
          nomeInicial={usuarioAtual.nome}
          funcaoInicial={usuarioAtual.funcao}
          onFechar={() => setPerfilAberto(false)}
        />
      )}
    </aside>
  );
}
