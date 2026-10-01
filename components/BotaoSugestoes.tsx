'use client';

import { useState } from 'react';
import type { Sugestao } from '@/lib/types';
import { validarSugestao } from '@/lib/validacao';

/**
 * Balão "Sugestões" fixo no canto inferior direito (todas as telas).
 * O modal traz um textarea + "Salvar"; as sugestões ficam salvas em SQLite
 * (GET/POST /api/sugestoes, DELETE /api/sugestoes/:id) e a lista mostra as
 * mais novas primeiro, com botão de apagar ao lado de cada uma.
 */
export default function BotaoSugestoes() {
  const [modalAberto, setModalAberto] = useState(false);
  const [sugestoes, setSugestoes] = useState<Sugestao[]>([]);
  const [texto, setTexto] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function abrirModal() {
    setModalAberto(true);
    setErro(null);
    void carregarSugestoes();
  }

  function fecharModal() {
    setModalAberto(false);
    setTexto('');
    setErro(null);
  }

  async function carregarSugestoes() {
    try {
      const resposta = await fetch('/api/sugestoes', { cache: 'no-store' });
      const dados = await resposta.json();

      if (resposta.ok) {
        setSugestoes(dados.sugestoes as Sugestao[]);
      } else {
        setErro(dados.erro ?? 'Falha ao carregar as sugestões.');
      }
    } catch {
      setErro('Falha ao carregar as sugestões.');
    }
  }

  async function salvar() {
    const validacao = validarSugestao({ texto });

    if (!validacao.valido) {
      setErro(validacao.erros.texto);
      return;
    }

    setSalvando(true);
    setErro(null);

    try {
      const resposta = await fetch('/api/sugestoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validacao.dados),
      });
      const dados = await resposta.json();

      if (!resposta.ok) {
        setErro(dados.erros?.texto ?? dados.erro ?? 'Falha ao salvar a sugestão.');
        return;
      }

      // Mais nova por cima: prepend na lista já carregada.
      setSugestoes((atual) => [dados.sugestao as Sugestao, ...atual]);
      setTexto('');
    } catch {
      setErro('Falha ao salvar a sugestão.');
    } finally {
      setSalvando(false);
    }
  }

  async function apagar(id: number) {
    setErro(null);

    try {
      const resposta = await fetch(`/api/sugestoes/${id}`, { method: 'DELETE' });
      const dados = await resposta.json();

      if (!resposta.ok) {
        setErro(dados.erro ?? 'Falha ao apagar a sugestão.');
        return;
      }

      setSugestoes((atual) => atual.filter((sugestao) => sugestao.id !== id));
    } catch {
      setErro('Falha ao apagar a sugestão.');
    }
  }

  return (
    <>
      <button
        type="button"
        className="sugestoes__balao"
        onClick={abrirModal}
      >
        💬 Sugestões
      </button>

      {modalAberto && (
        <div
          className="sobreposicao"
          role="presentation"
          onMouseDown={(evento) => evento.target === evento.currentTarget && fecharModal()}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="titulo-modal-sugestoes">
            <header className="modal__cabecalho">
              <h2 className="modal__titulo" id="titulo-modal-sugestoes">
                Sugestões
              </h2>
              <button type="button" className="modal__fechar" onClick={fecharModal} aria-label="Fechar">
                ×
              </button>
            </header>

            <div className="formulario sugestoes__conteudo">
              <label className="campo">
                <span className="campo__rotulo">Nova sugestão</span>
                <textarea
                  className="entrada"
                  value={texto}
                  rows={4}
                  placeholder="Escreva sua sugestão aqui..."
                  onChange={(evento) => setTexto(evento.target.value)}
                />
              </label>

              {erro && <span className="campo__erro">{erro}</span>}

              <div className="modal__acoes">
                <button type="button" className="botao" onClick={salvar} disabled={salvando}>
                  {salvando ? 'Salvando...' : 'Salvar'}
                </button>
              </div>

              <div className="sugestoes__lista">
                {sugestoes.length === 0 && !erro && (
                  <p className="sugestoes__vazio">Nenhuma sugestão ainda.</p>
                )}
                {sugestoes.map((sugestao) => (
                  <div className="sugestoes__item" key={sugestao.id}>
                    <span className="sugestoes__texto">{sugestao.texto}</span>
                    <button
                      type="button"
                      className="sugestoes__apagar"
                      onClick={() => apagar(sugestao.id)}
                      aria-label="Apagar sugestão"
                      title="Apagar"
                    >
                      🗑️
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}