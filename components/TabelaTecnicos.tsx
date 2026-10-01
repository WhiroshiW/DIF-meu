'use client';

import { calcularIdade, formatarDataBr, iniciais } from '@/lib/formato';
import type { Tecnico } from '@/lib/types';

type Props = {
  titulo: string;
  descricao: string;
  tecnicos: Tecnico[];
  mensagemVazio: string;
  /** Desativa (ou reativa) o técnico clicado. */
  onAlternarAtivo: (tecnico: Tecnico) => void;
  /** Abre o modal único de técnico preenchido (somente admin). */
  onEditar: (tecnico: Tecnico) => void;
  /** Exibe os botões "Editar" e "Desativar/Reativar" (somente admin — Tarefa 62). */
  mostrarAcoes?: boolean;
  variacao?: 'ativos' | 'inativos';
};

/**
 * Bloco de listagem reutilizado nas duas seções da tela:
 * "Técnicos ativos" e "Técnicos desativados".
 *
 * Ações (Tarefa 64): o admin vê "Editar" e "Desativar/Reativar"; o técnico não
 * recebe nenhum botão na linha. O detalhe do técnico fica no modal único, aberto
 * pelo menu lateral ("Perfil") ou pelo próprio admin aqui.
 */
export default function TabelaTecnicos({
  titulo,
  descricao,
  tecnicos,
  mensagemVazio,
  onAlternarAtivo,
  onEditar,
  mostrarAcoes = true,
  variacao = 'ativos',
}: Props) {
  return (
    <section className={`painel ${variacao === 'inativos' ? 'painel--inativos' : ''}`}>
      <header className="painel__cabecalho">
        <h2 className="painel__titulo">
          {titulo}
          <span className="selo">{tecnicos.length}</span>
        </h2>
        <p className="painel__descricao">{descricao}</p>
      </header>

      {tecnicos.length === 0 ? (
        <p className="vazio">{mensagemVazio}</p>
      ) : (
        <ul className="lista">
          {tecnicos.map((tecnico) => {
            const idade = calcularIdade(tecnico.dataNascimento);

            return (
              <li
                key={tecnico.id}
                id={`tecnico-${tecnico.id}`}
                className={`item ${tecnico.ativo ? '' : 'item--inativo'}`}
              >
                <div className="item__dados">
                  <span className="avatar">{iniciais(tecnico.nomeCompleto)}</span>
                  <span className="item__identidade">
                    <strong className="item__nome">{tecnico.nomeCompleto}</strong>
                    <span className="item__meta">
                      <span className={`etiqueta ${tecnico.ativo ? '' : 'etiqueta--inativo'}`}>
                        {tecnico.funcao}
                      </span>
                      <span>
                        {formatarDataBr(tecnico.dataNascimento)}
                        {idade !== null ? ` · ${idade} anos` : ''}
                      </span>
                    </span>
                  </span>
                </div>

                <div className="item__acoes">
                  {mostrarAcoes && (
                    <>
                      <button
                        type="button"
                        className="botao botao--neutro botao--pequeno"
                        onClick={() => onEditar(tecnico)}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className={`botao botao--pequeno ${tecnico.ativo ? 'botao--perigo' : 'botao--positivo'}`}
                        onClick={() => onAlternarAtivo(tecnico)}
                      >
                        {tecnico.ativo ? 'Desativar' : 'Reativar'}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}