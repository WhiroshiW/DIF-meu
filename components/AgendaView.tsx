'use client';

import { useEffect, useMemo, useState } from 'react';
import FormularioEvento from '@/components/FormularioEvento';
import {
  aniversariantesPorDia,
  chaveMes,
  dataDeHoje,
  descreverMes,
  deslocarMes,
  diaDaDataIso,
  DIAS_SEMANA,
  mesCorrente,
  montarDataIso,
  montarGrade,
  type MesReferencia,
} from '@/lib/calendario';
import { formatarDataBr } from '@/lib/formato';
import type { Evento, NovoEvento, Tecnico } from '@/lib/types';
import type { ErrosValidacao } from '@/lib/validacao';

type Props = {
  /** Eventos do mês corrente carregados no servidor (SSR). */
  eventosIniciais: Evento[];
  /** Técnicos usados para marcar os dias de aniversário no calendário. */
  tecnicos: Tecnico[];
};

type RespostaApi = {
  evento?: Evento;
  eventos?: Evento[];
  erros?: ErrosValidacao;
  erro?: string;
};

/**
 * Tela da categoria "Agenda": calendário do mês com navegação, eventos detalhados
 * do dia selecionado (ao lado), eventos do mês (abaixo) e destaque dos dias com
 * aniversário de técnico.
 * Datas passadas nunca recebem eventos novos.
 */
export default function AgendaView({ eventosIniciais, tecnicos }: Props) {
  const [referencia, setReferencia] = useState<MesReferencia>(() => mesCorrente());
  const [diaSelecionado, setDiaSelecionado] = useState(() => dataDeHoje());
  const [cache, setCache] = useState<Record<string, Evento[]>>(() => ({
    [chaveMes(mesCorrente())]: eventosIniciais,
  }));
  const [modalAberto, setModalAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erroGeral, setErroGeral] = useState<string | null>(null);

  const hoje = dataDeHoje();
  const periodo = chaveMes(referencia);
  const eventosDoMes = cache[periodo];
  const eventos = useMemo(() => eventosDoMes ?? [], [eventosDoMes]);

  // Meses ainda não visitados são buscados na API (o corrente já chega do servidor).
  useEffect(() => {
    if (eventosDoMes) {
      return;
    }

    let cancelado = false;

    fetch(`/api/eventos?mes=${periodo}`)
      .then((resposta) => (resposta.ok ? resposta.json() : Promise.reject(new Error('Falha ao carregar os eventos.'))))
      .then((dados: RespostaApi) => {
        if (!cancelado) {
          setCache((atual) => ({ ...atual, [periodo]: dados.eventos ?? [] }));
        }
      })
      .catch((erro: unknown) => {
        if (!cancelado) {
          setErroGeral(mensagemDoErro(erro, 'Não foi possível carregar os eventos deste mês.'));
        }
      });

    return () => {
      cancelado = true;
    };
  }, [eventosDoMes, periodo]);

  const grade = useMemo(() => montarGrade(referencia), [referencia]);

  /** Aniversariantes do mês exibido, agrupados pelo dia. */
  const aniversariantes = useMemo(
    () => aniversariantesPorDia(tecnicos, referencia.mes),
    [tecnicos, referencia.mes]
  );

  /** Eventos agrupados por data, para marcar os dias e detalhar o dia escolhido. */
  const eventosPorDia = useMemo(() => {
    const mapa = new Map<string, Evento[]>();

    eventos.forEach((evento) => {
      const doDia = mapa.get(evento.data) ?? [];
      doDia.push(evento);
      mapa.set(evento.data, doDia);
    });

    return mapa;
  }, [eventos]);

  const eventosDoDia = eventosPorDia.get(diaSelecionado) ?? [];
  const aniversariantesDoDia = aniversariantes.get(diaDaDataIso(diaSelecionado) ?? 0) ?? [];
  const podeAdicionar = diaSelecionado >= hoje;

  /** Guarda a lista de um mês já carregado (usado após criar/excluir um evento). */
  function atualizarPeriodo(chave: string, atualizar: (lista: Evento[]) => Evento[]) {
    setCache((atual) => ({ ...atual, [chave]: atualizar(atual[chave] ?? []) }));
  }

  /** Navega entre meses: o mês corrente abre no dia de hoje, os demais no dia 1. */
  function mudarMes(passo: number) {
    const novo = deslocarMes(referencia, passo);
    setReferencia(novo);
    setDiaSelecionado(chaveMes(novo) === chaveMes(mesCorrente()) ? dataDeHoje() : montarDataIso(novo.ano, novo.mes, 1));
  }

  function irParaHoje() {
    setReferencia(mesCorrente());
    setDiaSelecionado(dataDeHoje());
  }

  function abrirCadastro() {
    setErroGeral(null);
    setModalAberto(true);
  }

  function fecharModal() {
    setModalAberto(false);
  }

  /** POST /api/eventos e atualização do mês afetado. */
  async function salvar(dados: NovoEvento): Promise<ErrosValidacao | null> {
    setSalvando(true);
    setErroGeral(null);

    try {
      const resposta = await requisitar('/api/eventos', 'POST', dados);
      const criado = resposta.evento as Evento;
      const chaveDoEvento = criado.data.slice(0, 7);

      atualizarPeriodo(chaveDoEvento, (lista) => ordenarEventos([...lista, criado]));
      // O evento pode ter sido agendado para outro mês: o calendário acompanha a data.
      setReferencia({ ano: Number(criado.data.slice(0, 4)), mes: Number(criado.data.slice(5, 7)) - 1 });
      setDiaSelecionado(criado.data);
      setModalAberto(false);
      return null;
    } catch (erro) {
      if (erro instanceof ErroAplicacao && erro.errosValidacao) {
        return erro.errosValidacao;
      }

      setErroGeral(mensagemDoErro(erro, 'Não foi possível salvar o evento.'));
      return null;
    } finally {
      setSalvando(false);
    }
  }

  /** DELETE /api/eventos/:id. */
  async function excluir(evento: Evento) {
    setErroGeral(null);

    try {
      await requisitar(`/api/eventos/${evento.id}`, 'DELETE', null);
      atualizarPeriodo(evento.data.slice(0, 7), (lista) =>
        lista.filter((item) => item.id !== evento.id)
      );
    } catch (erro) {
      setErroGeral(mensagemDoErro(erro, 'Não foi possível excluir o evento.'));
    }
  }

  return (
    <>
      <header className="cabecalho">
        <div>
          <h1 className="cabecalho__titulo">Agenda</h1>
          <p className="cabecalho__descricao">
            Calendário de eventos da equipe, com os aniversários dos técnicos em destaque.
          </p>
        </div>
        <button type="button" className="botao" onClick={abrirCadastro}>
          + Adicionar evento
        </button>
      </header>

      {erroGeral && (
        <p className="alerta" role="alert">
          {erroGeral}
        </p>
      )}

      <div className="agenda">
        <section className="painel agenda__mes">
          <header className="painel__cabecalho agenda__navegacao">
            <div className="agenda__navegacao-titulo">
              <button
                type="button"
                className="botao botao--neutro botao--pequeno"
                onClick={() => mudarMes(-1)}
                aria-label="Mês anterior"
              >
                ‹
              </button>
              <h2 className="painel__titulo">{descreverMes(referencia)}</h2>
              <button
                type="button"
                className="botao botao--neutro botao--pequeno"
                onClick={() => mudarMes(1)}
                aria-label="Próximo mês"
              >
                ›
              </button>
            </div>
            <button type="button" className="botao botao--neutro botao--pequeno" onClick={irParaHoje}>
              Hoje
            </button>
          </header>

          <div className="calendario">
            <div className="calendario__semana">
              {DIAS_SEMANA.map((dia) => (
                <span className="calendario__rotulo" key={dia}>
                  {dia}
                </span>
              ))}
            </div>

            <div className="calendario__grade">
              {grade.map((dataIso, indice) => {
                if (!dataIso) {
                  return <span className="calendario__dia calendario__dia--vazio" key={`vazio-${indice}`} />;
                }

                const dia = diaDaDataIso(dataIso) ?? 0;
                const aniversariantesDoDia = aniversariantes.get(dia) ?? [];
                const marcados = eventosPorDia.get(dataIso) ?? [];
                const classes = ['calendario__dia'];

                if (dataIso < hoje) classes.push('calendario__dia--passado');
                if (dataIso === hoje) classes.push('calendario__dia--hoje');
                if (dataIso === diaSelecionado) classes.push('calendario__dia--selecionado');
                if (aniversariantesDoDia.length > 0) classes.push('calendario__dia--aniversario');

                return (
                  <button
                    type="button"
                    key={dataIso}
                    className={classes.join(' ')}
                    onClick={() => setDiaSelecionado(dataIso)}
                    title={
                      aniversariantesDoDia.length > 0
                        ? `Aniversário de ${aniversariantesDoDia
                            .map((tecnico) => tecnico.nomeCompleto)
                            .join(', ')}`
                        : `Ver eventos de ${formatarDataBr(dataIso)}`
                    }
                  >
                    <span className="calendario__numero">{dia}</span>

                    {aniversariantesDoDia.length > 0 && (
                      <>
                        <span className="calendario__bolo" aria-hidden="true">
                          🎂
                        </span>
                        <span className="calendario__aniversariante">
                          {primeiroNome(aniversariantesDoDia[0].nomeCompleto)}
                          {aniversariantesDoDia.length > 1 ? ` +${aniversariantesDoDia.length - 1}` : ''}
                        </span>
                      </>
                    )}

                    {marcados.length > 0 && <span className="calendario__marcador">{marcados.length}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="agenda__legenda">
            <span className="agenda__legenda-item">
              <span className="calendario__bolo" aria-hidden="true">
                🎂
              </span>
              Aniversário de técnico
            </span>
            <span className="agenda__legenda-item">
              <span className="calendario__marcador">1</span>
              Evento agendado
            </span>
            <span className="agenda__legenda-item">Datas passadas não recebem novos eventos</span>
          </p>
        </section>
        <section className="painel agenda__dia">
          <header className="painel__cabecalho">
            <h2 className="painel__titulo">
              {formatarDataBr(diaSelecionado)}
              <span className="selo">{eventosDoDia.length}</span>
            </h2>
            <p className="painel__descricao">
              {aniversariantesDoDia.length > 0
                ? `🎂 Aniversário de ${aniversariantesDoDia
                    .map((tecnico) => tecnico.nomeCompleto)
                    .join(', ')}`
                : descreverDia(diaSelecionado, hoje)}
            </p>
          </header>

          {eventosDoDia.length === 0 ? (
            <p className="vazio">Nenhum evento neste dia.</p>
          ) : (
            <ul className="lista">
              {eventosDoDia.map((evento) => (
                <li className="item item--evento" key={evento.id}>
                  <div className="item__identidade">
                    <strong className="item__nome">{evento.titulo}</strong>
                    <span className="item__meta">
                      <span className="etiqueta">{rotuloHora(evento.hora)}</span>
                    </span>
                    {evento.descricao && <p className="evento__descricao">{evento.descricao}</p>}
                  </div>
                  <div className="item__acoes">
                    <button
                      type="button"
                      className="botao botao--perigo botao--pequeno"
                      onClick={() => excluir(evento)}
                    >
                      Excluir
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {podeAdicionar === false && (
            <div className="agenda__rodape">
              <p className="agenda__aviso">Datas passadas não recebem eventos.</p>
            </div>
          )}
        </section>
      </div>

      <section className="painel">
        <header className="painel__cabecalho">
          <h2 className="painel__titulo">
            Eventos de {descreverMes(referencia)}
            <span className="selo">{eventos.length}</span>
          </h2>
          <p className="painel__descricao">Todos os eventos do mês exibido, em ordem cronológica.</p>
        </header>

        {!eventosDoMes ? (
          <p className="vazio">Carregando os eventos do mês...</p>
        ) : eventos.length === 0 ? (
          <p className="vazio">Nenhum evento agendado em {descreverMes(referencia)}.</p>
        ) : (
          <ul className="lista">
            {eventos.map((evento) => (
              <li className="item" key={evento.id}>
                <div className="item__dados">
                  <span className="etiqueta">{formatarDataBr(evento.data)}</span>
                  <span className="item__identidade">
                    <strong className="item__nome">{evento.titulo}</strong>
                    <span className="item__meta">
                      <span>{rotuloHora(evento.hora)}</span>
                      {evento.descricao && <span>{evento.descricao}</span>}
                    </span>
                  </span>
                </div>
                <div className="item__acoes">
                  <button
                    type="button"
                    className="botao botao--neutro botao--pequeno"
                    onClick={() => setDiaSelecionado(evento.data)}
                  >
                    Ver no dia
                  </button>
                  <button
                    type="button"
                    className="botao botao--perigo botao--pequeno"
                    onClick={() => excluir(evento)}
                  >
                    Excluir
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {modalAberto && (
        <FormularioEvento
          dataInicial={podeAdicionar ? diaSelecionado : hoje}
          salvando={salvando}
          onCancelar={fecharModal}
          onSalvar={salvar}
        />
      )}
    </>
  );
}

/** Erro de negócio; carrega os erros de validação por campo quando a API responde 400. */
class ErroAplicacao extends Error {
  errosValidacao?: ErrosValidacao;
}

/** fetch JSON com tratamento de erro padronizado (mesmo contrato usado em TecnicosView). */
async function requisitar(
  url: string,
  metodo: 'GET' | 'POST' | 'DELETE',
  corpo: unknown
): Promise<RespostaApi> {
  const resposta = await fetch(url, {
    method: metodo,
    headers: corpo === null ? undefined : { 'Content-Type': 'application/json' },
    body: corpo === null ? undefined : JSON.stringify(corpo),
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

/** Mantém a mesma ordem cronológica da API (hora vazia = dia inteiro, vem primeiro). */
function ordenarEventos(eventos: Evento[]): Evento[] {
  return [...eventos].sort((a, b) => {
    if (a.data !== b.data) return a.data < b.data ? -1 : 1;
    if (a.hora === b.hora) return a.titulo.localeCompare(b.titulo, 'pt-BR');
    if (a.hora === null) return -1;
    if (b.hora === null) return 1;
    return a.hora < b.hora ? -1 : 1;
  });
}

/** Rótulo da hora do evento: 'Às 09:30' ou 'Dia inteiro'. */
function rotuloHora(hora: string | null): string {
  return hora ? `Às ${hora}` : 'Dia inteiro';
}

/** Descrição do dia selecionado, usada no cabeçalho do painel lateral. */
function descreverDia(diaIso: string, referenciaHoje: string): string {
  if (diaIso === referenciaHoje) return 'Eventos de hoje.';
  if (diaIso > referenciaHoje) return 'Eventos agendados para este dia.';
  return 'Eventos deste dia (data passada: não recebe novos eventos).';
}

/** Primeiro nome do técnico, usado no destaque de aniversário dentro do dia. */
function primeiroNome(nomeCompleto: string): string {
  return nomeCompleto.trim().split(/\s+/)[0] ?? '';
}