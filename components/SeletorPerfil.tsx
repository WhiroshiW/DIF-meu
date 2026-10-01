'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Perfil de exibição do dashboard. Cada perfil vai enxergar um recorte
 * diferente da tela. A lista é fixa e fica aqui no código; por enquanto o
 * seletor só guarda a escolha — a filtragem entra depois.
 */
export const PERFIS: { id: string; rotulo: string }[] = [
  { id: 'geral', rotulo: 'Geral' },
  { id: 'triagem', rotulo: 'Triagem' },
  { id: 'manutencao', rotulo: 'Manutenção' },
  { id: 'n1', rotulo: 'N1' },
  { id: 'n2', rotulo: 'N2' },
  { id: 'n3', rotulo: 'N3' },
  { id: 'suporte-externo', rotulo: 'Suporte Externo' },
  { id: 'estoque', rotulo: 'Estoque' },
];

/** Perfil sem recorte — a tela como era antes do seletor existir. */
export const ID_PERFIL_GERAL = 'geral';

/**
 * Função do técnico → perfil que já vem selecionado ao abrir o dashboard
 * (Tarefa 113).
 *
 * A função é a que o admin escolhe no cadastro (`FUNCOES_DISPONIVEIS` em
 * `PerfilTecnico.tsx`): Manutenção, N1, N2, N3, Suporte externo e Estagiário.
 * O técnico que administra é o `admin`, que não tem função — e o **Geral** é a
 * visão sem recorte, então é dele que faz sentido.
 *
 * `Estagiário` cai em **Triagem**: foi o pedido do usuário ("estagiário pode
 * abrir a triagem"). Ele continua podendo trocar para qualquer outro perfil
 * pelo seletor — aqui só se define o que já vem marcado.
 */
const PERFIL_DA_FUNCAO: Record<string, string> = {
  manutencao: 'manutencao',
  n1: 'n1',
  n2: 'n2',
  n3: 'n3',
  'suporte externo': 'suporte-externo',
  suporte: 'suporte-externo',
  estoque: 'estoque',
  triagem: 'triagem',
  estagiario: 'triagem',
};

/**
 * Perfil inicial do técnico a partir da função cadastrada (Tarefa 113).
 *
 * A comparação é sem acento e sem caixa, porque a função é texto livre
 * cadastrado pelo admin: "Suporte Externo", "suporte externo" e "SUPORTE EXTERNO"
 * têm de dar o mesmo perfil. Função vazia, desconhecida ou "admin" caem no
 * **Geral**, que é o comportamento de antes.
 */
export function perfilInicialDaFuncao(funcao: string | null | undefined): string {
  const normalizada = String(funcao ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!normalizada) return ID_PERFIL_GERAL;
  const perfil = PERFIL_DA_FUNCAO[normalizada];
  if (!perfil) return ID_PERFIL_GERAL;
  // Só aceita se o perfil existe de fato na lista: assim uma entrada errada no
  // mapa acima não quebra a tela.
  return PERFIS.some((p) => p.id === perfil) ? perfil : ID_PERFIL_GERAL;
}

/**
 * Combobox de perfil. Não é um `<select>` nativo: a seta do Windows destoa
 * do resto da tela, e aqui o controle precisa ter identidade própria para
 * não se confundir com as funções que já existem no dashboard.
 */
export default function SeletorPerfil({
  valor,
  onChange,
}: {
  valor: string;
  onChange: (id: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [destacado, setDestacado] = useState(0);
  const raiz = useRef<HTMLDivElement | null>(null);
  const botao = useRef<HTMLButtonElement | null>(null);
  const lista = useRef<HTMLUListElement | null>(null);

  const selecionado = PERFIS.find((p) => p.id === valor) ?? PERFIS[0];

  // Fecha ao clicar fora, sem esperar por um clique na lista.
  useEffect(() => {
    if (!aberto) return;
    const fora = (evento: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(evento.target as Node)) setAberto(false);
    };
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, [aberto]);

  // Mantém a opção em foco visível dentro da lista rolável.
  useEffect(() => {
    if (!aberto) return;
    const item = lista.current?.children[destacado];
    if (item) (item as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [aberto, destacado]);

  const abrir = () => {
    setDestacado(Math.max(0, PERFIS.findIndex((p) => p.id === valor)));
    setAberto(true);
  };

  const escolher = (id: string) => {
    onChange(id);
    setAberto(false);
    botao.current?.focus();
  };

  const teclado = (evento: KeyboardEvent<HTMLDivElement>) => {
    if (evento.key === 'Escape') {
      if (!aberto) return;
      evento.preventDefault();
      setAberto(false);
      botao.current?.focus();
      return;
    }
    if (evento.key === 'ArrowDown' || evento.key === 'ArrowUp') {
      evento.preventDefault();
      if (!aberto) {
        abrir();
        return;
      }
      const passo = evento.key === 'ArrowDown' ? 1 : -1;
      setDestacado((atual) => (atual + passo + PERFIS.length) % PERFIS.length);
      return;
    }
    if (evento.key === 'Enter' || evento.key === ' ') {
      evento.preventDefault();
      if (!aberto) {
        abrir();
        return;
      }
      escolher(PERFIS[destacado].id);
    }
  };

  return (
    <div className="perfil" ref={raiz} onKeyDown={teclado}>
      <div className="perfil__rotulo">
        <svg
          className="perfil__rotulo-icone"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        <span>Perfil de exibição</span>
      </div>

      <div className="perfil__campo">
        <button
          type="button"
          ref={botao}
          className="perfil__botao"
          aria-haspopup="listbox"
          aria-expanded={aberto}
          onClick={() => (aberto ? setAberto(false) : abrir())}
        >
          <span className="perfil__valor">{selecionado.rotulo}</span>
          <svg
            className={`perfil__seta${aberto ? ' perfil__seta--aberta' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9.5 12 15.5 18 9.5" />
          </svg>
        </button>

        {aberto && (
          <ul className="perfil__lista" role="listbox" ref={lista} aria-label="Perfil de exibição">
            {PERFIS.map((perfil, indice) => (
              <li
                key={perfil.id}
                role="option"
                aria-selected={perfil.id === valor}
                className={
                  'perfil__opcao' +
                  (indice === destacado ? ' perfil__opcao--foco' : '') +
                  (perfil.id === valor ? ' perfil__opcao--ativa' : '')
                }
                onMouseEnter={() => setDestacado(indice)}
                onClick={() => escolher(perfil.id)}
              >
                <span>{perfil.rotulo}</span>
                {perfil.id === valor && (
                  <svg
                    className="perfil__marca"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}