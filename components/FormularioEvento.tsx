'use client';

import { useState } from 'react';
import type { NovoEvento } from '@/lib/types';
import { hojeIso, validarEvento, type ErrosValidacao } from '@/lib/validacao';

type Props = {
  /** Data já preenchida no formulário (dia selecionado no calendário). */
  dataInicial: string;
  salvando: boolean;
  onCancelar: () => void;
  /** Envia os dados para a API e devolve erros de validação do servidor, se houver. */
  onSalvar: (dados: NovoEvento) => Promise<ErrosValidacao | null>;
};

/** Formulário de cadastro de evento da agenda exibido em modal. */
export default function FormularioEvento({ dataInicial, salvando, onCancelar, onSalvar }: Props) {
  const [titulo, setTitulo] = useState('');
  const [descricao, setDescricao] = useState('');
  const [data, setData] = useState(dataInicial);
  const [hora, setHora] = useState('');
  const [erros, setErros] = useState<ErrosValidacao>({});

  const hoje = hojeIso();

  async function tratarEnvio(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();

    const validacao = validarEvento({ titulo, descricao, data, hora });

    if (!validacao.valido) {
      setErros(validacao.erros);
      return;
    }

    setErros({});
    const errosServidor = await onSalvar(validacao.dados);

    if (errosServidor) {
      setErros(errosServidor);
    }
  }

  return (
    <div
      className="sobreposicao"
      role="presentation"
      onMouseDown={(evento) => evento.target === evento.currentTarget && onCancelar()}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="titulo-modal-evento">
        <header className="modal__cabecalho">
          <h2 className="modal__titulo" id="titulo-modal-evento">
            Adicionar evento
          </h2>
          <button type="button" className="modal__fechar" onClick={onCancelar} aria-label="Fechar">
            ×
          </button>
        </header>

        <form className="formulario" onSubmit={tratarEnvio} noValidate>
          <label className="campo">
            <span className="campo__rotulo">Título</span>
            <input
              className={`entrada ${erros.titulo ? 'entrada--erro' : ''}`}
              type="text"
              value={titulo}
              autoFocus
              placeholder="Ex.: Manutenção preventiva"
              onChange={(evento) => setTitulo(evento.target.value)}
            />
            {erros.titulo && <span className="campo__erro">{erros.titulo}</span>}
          </label>

          <div className="campo__linha">
            <label className="campo">
              <span className="campo__rotulo">Data</span>
              <input
                className={`entrada ${erros.data ? 'entrada--erro' : ''}`}
                type="date"
                value={data}
                min={hoje}
                onChange={(evento) => setData(evento.target.value)}
              />
              {erros.data && <span className="campo__erro">{erros.data}</span>}
            </label>

            <label className="campo">
              <span className="campo__rotulo">Horário (opcional)</span>
              <input
                className={`entrada ${erros.hora ? 'entrada--erro' : ''}`}
                type="time"
                value={hora}
                onChange={(evento) => setHora(evento.target.value)}
              />
              {erros.hora && <span className="campo__erro">{erros.hora}</span>}
            </label>
          </div>

          <label className="campo">
            <span className="campo__rotulo">Descrição (opcional)</span>
            <textarea
              className={`entrada ${erros.descricao ? 'entrada--erro' : ''}`}
              value={descricao}
              rows={3}
              placeholder="Detalhes do evento, participantes, local..."
              onChange={(evento) => setDescricao(evento.target.value)}
            />
            {erros.descricao && <span className="campo__erro">{erros.descricao}</span>}
          </label>

          <div className="modal__acoes">
            <button type="button" className="botao botao--neutro" onClick={onCancelar} disabled={salvando}>
              Cancelar
            </button>
            <button type="submit" className="botao" disabled={salvando}>
              {salvando ? 'Salvando...' : 'Agendar evento'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}