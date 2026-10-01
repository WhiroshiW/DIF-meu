'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import SeletorPerfil, {
  perfilInicialDaFuncao,
  ID_PERFIL_GERAL as ID_PERFIL_GERAL_PADRAO,
} from '@/components/SeletorPerfil';
import { ABAS, ABA_PADRAO, abaDaUrl, type Aba } from '@/lib/abasGlpi';
import { interpretarTermo } from '@/lib/secretarias';
import { obterUsuarioSessao, type UsuarioSessao } from '@/components/LoginModal';



/** Chamado pendente exibido nas listas dos cards do dashboard. */
type ChamadoLista = {
  id: number;
  titulo: string;
  solicitante: string;
  localizacao: string;
  nao_vistos?: number;
  /** Grupos do chamado (Tarefa 69); pode ter mais de um. */
  departamentos?: string[];
  /** Motivo da pendência (T101): separa o card "Pendente" sem motivo. */
  motivo_pendencia?: string | null;
  /**
   * Status do GLPI (Tarefa 90), para a barrinha colorida na lateral do item.
   * 1 Novo · 2/3 Em atendimento · 4 Pendente · 5 Solucionado · 6 Fechado.
   */
  status?: number;
};

/**
 * Status do GLPI que recebem a barrinha colorida (Tarefa 90), no padrão da
 * imagem de referência do usuário. Serve de lista branca: o JSX só aplica a
 * classe `dashboard__lista-item--status<n>` quando o status está aqui, então um
 * status novo no GLPI deixa o item sem barra em vez de quebrar a lista.
 */
const CORES_STATUS: Record<number, string> = {
  1: '#3fae3f', // Novo            — verde sólido
  2: '#3fae3f', // Em atendimento  — contorno verde, centro branco
  3: '#3fae3f', // Em atendimento (planejado) — igual ao 2
  4: '#f0a202', // Pendente        — laranja
  5: '#9ca3af', // Solucionado     — contorno cinza, centro branco
  6: '#111827', // Fechado         — preto
};

/**
 * Sigla e classe de cor de cada departamento (Tarefa 69).
 * As chaves são os rótulos que a API devolve: os 7 subdepartamentos do
 * Dpto Suporte Técnico (`ORDEM_DEPARTAMENTOS`, onde "Externo" é o grupo de
 * Suporte Externo) mais, desde a Tarefa 88, Infraestrutura, Sistemas e
 * Suporte SMED — que aparecem **só** como bolinha, sem quadrado na faixa.
 * A cor vive no CSS, em `.dashboard__grupo--<chave>`; aqui fica só o nome.
 */
const DEPARTAMENTOS: Record<string, { sigla: string; classe: string }> = {
  Triagem: { sigla: 'T', classe: 'dashboard__grupo--triagem' },
  N1: { sigla: 'N1', classe: 'dashboard__grupo--n1' },
  N2: { sigla: 'N2', classe: 'dashboard__grupo--n2' },
  N3: { sigla: 'N3', classe: 'dashboard__grupo--n3' },
  Manutenção: { sigla: 'M', classe: 'dashboard__grupo--manutencao' },
  Externo: { sigla: 'SE', classe: 'dashboard__grupo--externo' },
  Estoque: { sigla: 'E', classe: 'dashboard__grupo--estoque' },
  Infraestrutura: { sigla: 'I', classe: 'dashboard__grupo--infraestrutura' },
  Sistemas: { sigla: 'S', classe: 'dashboard__grupo--sistemas' },
  'Suporte SMED': { sigla: 'SMED', classe: 'dashboard__grupo--smed' },
};

type DadosDashboard = {
  abertos: number;
  abertos_por_departamento: Array<{ departamento: string; total: number }>;
  solucionados_hoje: number;
  aguardando_retirada: number;
  aguardando_equipamento: number;
  aguardando_resposta: number;
  aguardando_resposta_ipm: number;
  garantia: number;
  servico_terceiros: number;
  lista_retirada: ChamadoLista[];
  lista_equipamento: ChamadoLista[];
  lista_solucionados_hoje: ChamadoLista[];
  fila_manutencao: number;
  lista_fila_manutencao: ChamadoLista[];
  lista_abertos: ChamadoLista[];
  listas_abertos_por_departamento: Record<string, ChamadoLista[]>;
  /** Fila por departamento (T101): abertos menos os pendentes. */
  fila_por_departamento: Record<string, ChamadoLista[]>;
  /** Pendentes por departamento (T101): status 4. */
  pendentes_por_departamento: Record<string, ChamadoLista[]>;
  /** Contagens por departamento dos números pequenos ao lado do total (T103). */
  resumo_por_departamento: Record<string, ResumoDepartamento>;
};

/** Mesma forma do resumo que a rota devolve (Tarefa 103). */
type ResumoDepartamento = {
  abertos: number;
  pendentes: number;
  solucionados_hoje: number;
  abertos_hoje: number;
};

/**
 * Números pequenos ao lado do total do card (Tarefa 104). Viram etiquetas em vez
 * de frase corrida, para não competirem com o número grande e para o olho separar
 * cada um. As cores seguem as que o sistema já usa: pendente em âmbar (o status 4
 * da barrinha, T90) e **aberto em verde**.
 *
 * Tarefa 111: verde e cinza foram **invertidos** em relação à versão anterior —
 * `solucionados hoje` é o cinza padrão e `abertos hoje` é que ganha o verde.
 */
function resumoDoCard(resumo: ResumoDepartamento | undefined) {
  if (!resumo) return null;
  return (
    <p className="dashboard__card-mini">
      <span className="dashboard__mini dashboard__mini--pendente">
        {resumo.pendentes} {resumo.pendentes === 1 ? 'pendente' : 'pendentes'}
      </span>
      <span className="dashboard__mini">
        {resumo.solucionados_hoje}{' '}
        {resumo.solucionados_hoje === 1 ? 'solucionado' : 'solucionados'} hoje
      </span>
      <span className="dashboard__mini dashboard__mini--aberto">
        {resumo.abertos_hoje} {resumo.abertos_hoje === 1 ? 'aberto' : 'abertos'} hoje
      </span>
    </p>
  );
}

/** Estado devolvido por `GET /api/glpi/sync` (execucao do script em processo filho). */
type ResultadoSincronizacao = {
  executando: boolean;
  /** Parada pedida: o script esta encerrando o chamado atual e salvando o progresso. */
  parando: boolean;
  iniciadoEm: string | null;
  finalizadoEm: string | null;
  sucesso: boolean | null;
  codigoSaida: number | null;
  ultimaLinha: string;
  linhas: string[];
  erro: string | null;
};

/** Intervalo entre as consultas de status enquanto o script esta rodando. */
const INTERVALO_STATUS_MS = 1000;

/** Intervalo das consultas em repouso: percebe uma sync iniciada pelo agendador. */
const INTERVALO_STATUS_OCIOSO_MS = 15000;

/** Tempo que a mensagem "Sincronizacao concluida" fica visivel apos o termino. */
const DURACAO_CONCLUSAO_MS = 5000;

/**
 * De quanto em quanto o painel e recarregado ENQUANTO a sincronizacao roda
 * (Tarefa 99). O aviso do servidor so chega no fim do processo; sem este
 * intervalo, uma sincronizacao que leva horas deixaria o painel congelado o
 * tempo todo, sem o usuario ver que os chamados estao sendo atualizados.
 *
 * Tarefa 110: 20 s → **1 s**, a pedido do usuario — ele quer ver o chamado
 * aparecer nos cards conforme vai sendo gravado.
 */
const INTERVALO_PAINEL_DURANTE_SYNC_MS = 1000;

/**
 * Busca geral (Tarefa 84): a partir de quantos caracteres a consulta sai.
 * Mesmo mínimo usado pela rota `GET /api/glpi/busca`.
 *
 * Tarefa 89: um termo **só de números** é o número de um chamado e sai com 1
 * dígito. É uma consulta pela chave primária, a mais barata que existe, e sem
 * isso o chamado 7 ou o 42 nunca apareceriam na tela. Precisa bater com a rota,
 * senão o navegador nem pede a consulta.
 */
const MINIMO_BUSCA_GERAL = 4;

/** O termo é só dígitos? Então é o número de um chamado (Tarefa 89). */
function termoEhNumero(termo: string): boolean {
  return /^\d+$/.test(termo);
}

/**
 * Espera antes de sair a consulta da busca geral. A busca varre a base inteira do
 * GLPI (1,4 GB), então sair a cada tecla transformaria a digitação em quatro ou
 * cinco varreduras seguidas; aqui sai **uma**, quando a pessoa para de digitar.
 */
const ESPERA_BUSCA_GERAL_MS = 700;

/**
 * Espera antes de consultar a localização do chamado cujo id foi digitado em
 * "Buscar chamados" (Tarefa 95). É uma ida ao servidor (o chamado pode nem
 * estar nas listas da tela), então sai só quando a pessoa para de digitar.
 */
const ESPERA_BUSCA_LOCALIZACAO_MS = 350;

function horaCurta(iso: string | null): string {
  if (!iso) return '';

  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';

  return ` às ${data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

/** "23/09/2026 às 15:30" a partir de um ISO; null quando ausente ou invalido. */
function dataHoraCurta(iso: string | null): string | null {
  if (!iso) return null;

  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;

  return `${data.toLocaleDateString('pt-BR')} às ${data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Compara o que a UI usa do status para o polling em repouso nao re-renderizar
 * (nem recriar o timer de auto-hide) quando nada mudou.
 */
function mesmoResultado(atual: ResultadoSincronizacao | null, novo: ResultadoSincronizacao): boolean {
  if (!atual) return false;

  return (
    atual.executando === novo.executando &&
    // `parando` entra na comparacao (Tarefa 99): sem isso o `setResultado`
    // devolveria o objeto antigo e o botao ficaria preso em "Parar
    // sincronizacao" em vez de virar "Parando...".
    atual.parando === novo.parando &&
    atual.iniciadoEm === novo.iniciadoEm &&
    atual.finalizadoEm === novo.finalizadoEm &&
    atual.sucesso === novo.sucesso &&
    atual.codigoSaida === novo.codigoSaida &&
    atual.ultimaLinha === novo.ultimaLinha &&
    atual.erro === novo.erro
  );
}

/** Normaliza texto para busca: minúsculas, sem acentos e sem espaço nas pontas. */
function normalizarBusca(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Filtra a lista de um card pelo termo digitado na busca, em qualquer campo
 * disponível (id, título, solicitante, localização). Sem termo, devolve a
 * lista original.
 *
 * Tarefa 95: quando o termo é o **id** de um chamado, o filtro deixa de ser pelo
 * texto e passa a ser pela **localização** desse chamado — é o que o usuário
 * pediu: digitar o id de um chamado mostra nos cards todos os chamados da
 * mesma localização. `localizacaoAlvo` chega preenchido pelo `GlpiTabs`; vazio
 * (termo não é id, ou o id não existe) mantém a filtragem normal por texto.
 */
function filtrarChamados(
  chamados: ChamadoLista[],
  termo: string,
  localizacaoAlvo?: string | null
): ChamadoLista[] {
  const localAlvo = normalizarBusca(localizacaoAlvo ?? '');
  if (localAlvo) {
    return chamados.filter((chamado) => normalizarBusca(chamado.localizacao ?? '') === localAlvo);
  }

  const termoNormalizado = normalizarBusca(termo);
  if (!termoNormalizado) return chamados;

  // Tarefa 112: palavra que é o **nome de uma secretaria** ("cultura") filtra pela
  // localização — e só pela sigla **isolada**. `SMCT` entra; `SMCT - Museu` não.
  // O item já traz o resumo da localização em `localizacao`, então a comparação é
  // a mesma que a busca geral faz no servidor (`resumirLocalizacao`), e os dois
  // lados não podem divergir.
  const { sigla, palavras } = interpretarTermo(termo);
  if (sigla) {
    const alvo = normalizarBusca(sigla);
    return chamados.filter(
      (chamado) =>
        normalizarBusca(chamado.localizacao ?? '') === alvo &&
        // Palavras que ficaram junto da secretaria continuam filtrando o texto.
        palavras.every((palavra) => {
          const p = normalizarBusca(palavra);
          return [String(chamado.id), chamado.titulo, chamado.solicitante, chamado.localizacao].some((campo) =>
            normalizarBusca(campo ?? '').includes(p)
          );
        })
    );
  }

  return chamados.filter((chamado) =>
    [String(chamado.id), chamado.titulo, chamado.solicitante, chamado.localizacao].some((campo) =>
      normalizarBusca(campo ?? '').includes(termoNormalizado)
    )
  );
}

/**
 * Diz se o quadradinho de "devolver para não visto" (Tarefa 93) deve aparecer
 * no item. Só em chamado que continua aberto (status diferente de 5 Solucionado
 * e 6 Fechado) e que **ainda não** está amarelo (`nao_vistos === 0`) — chamado
 * amarelinho já está pedindo atenção, então o quadrado some.
 */
function podeDesmarcar(chamado: ChamadoLista): boolean {
  if (chamado.status === 5 || chamado.status === 6) return false;
  return (chamado.nao_vistos ?? 0) === 0;
}

/**
 * Lista compacta de chamados usada nos cards do dashboard.
 * Cada item é inteiramente clicável (abre o chamado no GLPI) e usa 3 linhas
 * para leitura rápida: id + título; solicitante; localização.
 * Itens com acompanhamento novo (`nao_vistos > 0`, Tarefa 36) nascem com fundo
 * amarelo claro e no topo da lista (ordenação vinda da API); qualquer clique
 * (esquerdo ou botão do meio/scroll) marca os acompanhamentos como vistos via
 * `POST /api/glpi/chamados/[id]/visto` e avisa o pai para reordenar.
 */
function ListaChamados({
  chamados,
  buscando = false,
  aoMarcarVisto,
  aoDesmarcar,
}: {
  chamados: ChamadoLista[];
  buscando?: boolean;
  aoMarcarVisto: (id: number) => void;
  /** Tarefa 93: devolve o chamado ao amarelo; opcional para não quebrar quem usa só a marcação de visto. */
  aoDesmarcar?: (id: number) => void;
}) {
  if (chamados.length === 0) {
    // Durante a busca, avisa que nada correspondeu ao termo.
    if (buscando) {
      return <p className="dashboard__lista-vazio">Nenhum chamado encontrado.</p>;
    }
    return null;
  }

  return (
    <ul className="dashboard__lista">
      {chamados.map((chamado) => (
        <li
          key={chamado.id}
          className={`dashboard__lista-item${(chamado.nao_vistos ?? 0) > 0 ? ' dashboard__lista-item--novo' : ''}${
            // T90: barrinha colorida do status na lateral esquerda do item.
            // Classe por status, no mesmo padrão de `.dashboard__grupo--<chave>`.
            chamado.status !== undefined && CORES_STATUS[chamado.status]
              ? ` dashboard__lista-item--status${chamado.status}`
              : ''
          }${aoDesmarcar && podeDesmarcar(chamado) ? ' dashboard__lista-item--reaviso' : ''}`}
        >
          <a
            className="dashboard__lista-item-link"
            href={`https://sistemas.araucaria.pr.gov.br/front/ticket.form.php?id=${chamado.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Abrir o chamado ${chamado.id} no GLPI`}
            onClick={() => aoMarcarVisto(chamado.id)}
            onAuxClick={(evento) => {
              if (evento.button === 1) aoMarcarVisto(chamado.id);
            }}
          >
            <span className="dashboard__lista-topo">
              <span className="dashboard__lista-link">{chamado.id}</span>
              {chamado.titulo && (
                <span className="dashboard__lista-titulo">{chamado.titulo}</span>
              )}
              {/* Canto superior direito: bolinha colorida + sigla de cada grupo
                  do chamado (Tarefa 69). Sem grupo atribuído, nada aparece. */}
              {chamado.departamentos && chamado.departamentos.length > 0 && (
                <span className="dashboard__lista-grupos">
                  {chamado.departamentos.map((departamento) => {
                    const info = DEPARTAMENTOS[departamento];
                    if (!info) return null;

                    return (
                      <span
                        key={departamento}
                        className={`dashboard__grupo ${info.classe}`}
                        title={departamento}
                      >
                        <span className="dashboard__grupo-bola" aria-hidden="true" />
                        {info.sigla}
                      </span>
                    );
                  })}
                </span>
              )}
            </span>
            <span className="dashboard__lista-detalhe">
              {chamado.solicitante && (
                <span className="dashboard__lista-solicitante">{chamado.solicitante}</span>
              )}
              {chamado.localizacao && (
                <span className="dashboard__lista-local">{chamado.localizacao}</span>
              )}
            </span>
          </a>
          {/* Tarefa 93: quadradinho discreto no canto inferior direito. Só
              aparece em chamado aberto e que ainda não está amarelo; ao clicar,
              o último acompanhamento volta para `visto = 0` e o item fica
              amarelo de novo — para o caso de o clique no item ter sido sem
              querer e a pessoa que deveria ver o aviso passar batido.
              Fica FORA do `<a>` de propósito: clicar nele não abre o GLPI. */}
          {aoDesmarcar && podeDesmarcar(chamado) && (
            <button
              type="button"
              className="dashboard__lista-aviso"
              title="Avisar novamente este chamado"
              aria-label={`Avisar novamente o chamado ${chamado.id}`}
              onClick={() => aoDesmarcar(chamado.id)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Departamento que cada perfil do seletor representa, com o rótulo **exato** que a
 * API devolve em `departamentos`. O perfil "geral" não tem departamento: é a visão
 * sem recorte. (Tarefa 101)
 */
const DEPARTAMENTO_DO_PERFIL: Record<string, string> = {
  triagem: 'Triagem',
  manutencao: 'Manutenção',
  n1: 'N1',
  n2: 'N2',
  n3: 'N3',
  'suporte-externo': 'Externo',
  estoque: 'Estoque',
};

/** Perfil sem recorte — a tela como era antes do seletor existir. */
const ID_PERFIL_GERAL = ID_PERFIL_GERAL_PADRAO;

/** Perfil "Manutenção": único com cards próprios (fila, retirada e equipamento). */
const ID_PERFIL_MANUTENCAO = 'manutencao';

/** Perfil "Triagem": mostra a fila de todos os departamentos (Tarefa 101). */
const ID_PERFIL_TRIAGEM = 'triagem';

/**
 * Ordem e rótulo dos 7 cards do perfil Triagem (Tarefa 101). `chave` é o rótulo
 * exato que a API usa em `fila_por_departamento`.
 */
const FILAS_DO_TRIAGEM: { chave: string; titulo: string }[] = [
  { chave: 'Triagem', titulo: 'Fila da Triagem' },
  { chave: 'N1', titulo: 'Fila do N1' },
  { chave: 'N2', titulo: 'Fila do N2' },
  { chave: 'N3', titulo: 'Fila do N3' },
  { chave: 'Manutenção', titulo: 'Fila da Manutenção' },
  { chave: 'Externo', titulo: 'Fila do Suporte Externo' },
  { chave: 'Estoque', titulo: 'Fila do Estoque' },
];

/**
 * Perfil Geral: os **abertos** de cada departamento, e no fim os solucionados hoje
 * (Tarefa 102). Mesmo conjunto do modal "Chamados abertos", mas no painel.
 *
 * O rótulo é "Abertos de…" e não "Fila de…" de propósito: aqui o pendente (status 4)
 * ENTRA, enquanto na fila do perfil Triagem ele fica fora. São coisas diferentes.
 */
const ABERTOS_DO_GERAL: { chave: string; titulo: string }[] = [
  { chave: 'Triagem', titulo: 'Abertos da Triagem' },
  { chave: 'N1', titulo: 'Abertos do N1' },
  { chave: 'N2', titulo: 'Abertos do N2' },
  { chave: 'N3', titulo: 'Abertos do N3' },
  { chave: 'Manutenção', titulo: 'Abertos da Manutenção' },
  { chave: 'Externo', titulo: 'Abertos do Suporte Externo' },
  { chave: 'Estoque', titulo: 'Abertos do Estoque' },
];

/**
 * Diz se o chamado pertence ao departamento do perfil, pelo rótulo que a API já
 * calculou. Para a Manutenção isso equivale ao `pertenceManutencao` do servidor:
 * os dois exigem grupo com "dpto suporte técnico" + departamento normalizado.
 */
function pertenceAoDepartamento(chamado: ChamadoLista, departamento: string): boolean {
  return chamado.departamentos?.includes(departamento) ?? false;
}

export default function GlpiTabs() {
  /**
   * Aba ativa vem da URL (Tarefa 106) — é o submenu do menu lateral que escolhe,
   * então não dá para ficar em estado local aqui.
   */
  const parametros = useSearchParams();
  const abaAtiva: Aba = abaDaUrl(parametros.get('aba') ?? ABA_PADRAO);
  /** Rótulo da aba aberta, para o título mostrar "GLPI - (Dashboard)" (Tarefa 107). */
  const rotuloDaAba = ABAS.find((aba) => aba.id === abaAtiva)?.rotulo ?? '';
  /**
   * Perfil de exibição escolhido no dashboard. Recorta os cards conforme o
   * departamento do perfil (Tarefa 101).
   *
   * Tarefa 113: já **começa** no departamento do técnico logado, em vez de
   * sempre "Geral". A função vem do `localStorage` da sessão; como o
   * `GlpiTabs` só é montado depois que o `PortaoSessao` libera a tela, ler no
   * primeiro render é suficiente. O `useEffect` abaixo cobre o caso de quem
   * entra/troca de conta sem recarregar a página (evento `dinf:sessao`).
   */
  const [perfil, setPerfil] = useState<string>(() =>
    perfilInicialDaFuncao(obterUsuarioSessao()?.funcao)
  );

  // T113: quando a sessão muda (login, troca de conta, ou o admin renomeia/
  // promove a pessoa), o perfil volta ao departamento da função **atual**. Não
  // existe "perfil escolhido" salvo: a escolha do seletor vale enquanto a sessão
  // não muda, que é o que o usuário pediu ("ao logar, já vem no meu
  // departamento").
  useEffect(() => {
    const aoMudarSessao = (evento: Event) => {
      const usuario = (evento as CustomEvent<UsuarioSessao>).detail ?? null;
      setPerfil(perfilInicialDaFuncao(usuario?.funcao));
    };
    window.addEventListener('dinf:sessao', aoMudarSessao);
    window.addEventListener('dinf:login', aoMudarSessao);
    return () => {
      window.removeEventListener('dinf:sessao', aoMudarSessao);
      window.removeEventListener('dinf:login', aoMudarSessao);
    };
  }, []);
  const [sincronizando, setSincronizando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoSincronizacao | null>(null);
  const [erroSincronizacao, setErroSincronizacao] = useState<string | null>(null);
  /** Mostra a faixa de status. Fica falso ao abrir a pagina: o estado anterior NAO e exibido. */
  const [mostrarResultado, setMostrarResultado] = useState(false);

  const [buscaChamados, setBuscaChamados] = useState('');
  /**
   * Localização do chamado cujo **id** foi digitado em "Buscar chamados"
   * (Tarefa 95). Fica `null` quando o termo não é um número, ou quando esse
   * número não é id de nenhum chamado — nesses casos a filtragem por texto
   * continua valendo como antes.
   */
  const [localizacaoDoTermo, setLocalizacaoDoTermo] = useState<string | null>(null);
  const [dadosDashboard, setDadosDashboard] = useState<DadosDashboard | null>(null);
  const [erroDashboard, setErroDashboard] = useState<string | null>(null);
  /** Modal do total de abertos (Tarefa 40): aberto pelo número do primeiro card. */
  const [modalAbertos, setModalAbertos] = useState(false);
  /**
   * Departamento cujo modal está aberto (Tarefa 41): `null` = total geral (T40),
   * string = modal daquele quadrado da faixa. `null` aqui fora significa fechado.
   */
  const [modalDepartamento, setModalDepartamento] = useState<string | null>(null);
  /** Busca interna do modal: filtra a cada letra, independente da busca dos cards. */
  const [buscaModal, setBuscaModal] = useState('');
  /** Modal da busca geral (Tarefa 83): por enquanto abre vazio, sem conteúdo. */
  const [modalBuscaGeral, setModalBuscaGeral] = useState(false);
  /** Busca geral (Tarefa 84): termo digitado, resultados e estado da consulta. */
  const [termoBuscaGeral, setTermoBuscaGeral] = useState('');
  const [resultadosBuscaGeral, setResultadosBuscaGeral] = useState<ChamadoLista[]>([]);
  const [buscandoGeral, setBuscandoGeral] = useState(false);
  const [erroBuscaGeral, setErroBuscaGeral] = useState<string | null>(null);

  /** Ultimo status observado no polling: base para detectar inicio/fim de qualquer sync. */
  const executandoVisto = useRef<boolean | undefined>(undefined);
  const finalizadoEmVisto = useRef<string | null | undefined>(undefined);
  /** Evita empilhar recargas do dashboard enquanto uma delas ainda esta em voo (T110). */
  const painelEmCarga = useRef(false);

  const buscandoAtivo = buscaChamados.trim() !== '';

  // Perfil de exibição (Tarefa 101). `departamentoDoPerfil` é null no perfil Geral.
  // Cada perfil tem seu conjunto de cards: Triagem vê a fila dos 7 departamentos,
  // a Manutenção vê os cards dela, o Geral mantém a tela antiga e os outros
  // departamentos veem solucionados + fila + pendentes.
  const departamentoDoPerfil = DEPARTAMENTO_DO_PERFIL[perfil] ?? null;
  const ehPerfilManutencao = perfil === ID_PERFIL_MANUTENCAO;
  const ehPerfilGeral = perfil === ID_PERFIL_GERAL;
  const ehPerfilTriagem = perfil === ID_PERFIL_TRIAGEM;

  // Listas dos cards já filtradas pelo termo de busca (uma única filtragem,
  // reutilizada pelo número do card e pela lista exibida).
  //
  // Tarefa 95: quando o termo é o id de um chamado, o filtro é pela localização
  // desse chamado (`localizacaoDoTermo`), então as listas mostram todos os
  // chamados do mesmo lugar.
  const solucionadosFiltrados = useMemo(
    () => filtrarChamados(dadosDashboard?.lista_solucionados_hoje ?? [], buscaChamados, localizacaoDoTermo),
    [dadosDashboard, buscaChamados, localizacaoDoTermo]
  );
  // T102: as listas de fila/retirada/equipamento do painel antigo saíram de uso —
  // cada perfil agora monta as suas a partir das listas por departamento.

  /**
   * Solucionados do recorte do perfil. Num perfil de departamento o card mostra
   * só os chamados daquele departamento — e o número do card tem de vir daqui
   * também, senão ele continuaria mostrando o total geral da tela.
   * Os cards de fila, retirada e equipamento já são específicos e não filtram.
   */
  const solucionadosDoPerfil = useMemo(
    () =>
      departamentoDoPerfil
        ? solucionadosFiltrados.filter((c) => pertenceAoDepartamento(c, departamentoDoPerfil))
        : solucionadosFiltrados,
    [solucionadosFiltrados, departamentoDoPerfil]
  );

  /**
   * Fila e pendentes do departamento do perfil (Tarefa 101). A fila é o que está
   * aberto e **não** pendente; os pendentes (status 4) são o outro card. Juntos
   * dão todos os abertos do departamento, então nenhum chamado some dos dois.
   */
  const filaDoPerfil = useMemo(() => {
    if (!departamentoDoPerfil) return [];
    return filtrarChamados(
      dadosDashboard?.fila_por_departamento?.[departamentoDoPerfil] ?? [],
      buscaChamados,
      localizacaoDoTermo
    );
  }, [dadosDashboard, buscaChamados, localizacaoDoTermo, departamentoDoPerfil]);

  const pendentesDoPerfil = useMemo(() => {
    if (!departamentoDoPerfil) return [];
    return filtrarChamados(
      dadosDashboard?.pendentes_por_departamento?.[departamentoDoPerfil] ?? [],
      buscaChamados,
      localizacaoDoTermo
    );
  }, [dadosDashboard, buscaChamados, localizacaoDoTermo, departamentoDoPerfil]);

  /**
   * Retirada e Equipamento recortados pelo departamento do perfil (Tarefa 101).
   * As listas da API são de todo o Dpto Suporte Técnico; sem este recorte o card
   * da Manutenção mostrava chamado de outros departamentos — foi de onde veio o
   * pedido para tirar o que fosse do Estoque.
   */
  const retiradaDoPerfil = useMemo(() => {
    if (!departamentoDoPerfil) return [];
    return filtrarChamados(dadosDashboard?.lista_retirada ?? [], buscaChamados, localizacaoDoTermo).filter((c) =>
      pertenceAoDepartamento(c, departamentoDoPerfil)
    );
  }, [dadosDashboard, buscaChamados, localizacaoDoTermo, departamentoDoPerfil]);

  const equipamentoDoPerfil = useMemo(() => {
    if (!departamentoDoPerfil) return [];
    return filtrarChamados(dadosDashboard?.lista_equipamento ?? [], buscaChamados, localizacaoDoTermo).filter((c) =>
      pertenceAoDepartamento(c, departamentoDoPerfil)
    );
  }, [dadosDashboard, buscaChamados, localizacaoDoTermo, departamentoDoPerfil]);

  /**
   * Pendentes do departamento **sem motivo de pendência** (Tarefa 101). Os que têm
   * motivo já aparecem no card correspondente (Retirada, Equipamento), então este
   * card é só o que sobraria sem nenhum card.
   */
  const pendentesSemMotivoDoPerfil = useMemo(() => {
    if (!departamentoDoPerfil) return [];
    return pendentesDoPerfil.filter((c) => !c.motivo_pendencia);
  }, [pendentesDoPerfil, departamentoDoPerfil]);

  /**
   * Fila dos 7 departamentos já filtrada pela busca — alimenta os cards do perfil
   * Triagem (Tarefa 101).
   */
  const filasPorDepartamento = useMemo(() => {
    const todas = dadosDashboard?.fila_por_departamento ?? {};
    const mapa: Record<string, ChamadoLista[]> = {};
    for (const [departamento, lista] of Object.entries(todas)) {
      mapa[departamento] = filtrarChamados(lista, buscaChamados, localizacaoDoTermo);
    }
    return mapa;
  }, [dadosDashboard, buscaChamados, localizacaoDoTermo]);

  /**
   * Abertos dos 7 departamentos, já filtrados pela busca — alimenta os cards do
   * perfil Geral (Tarefa 102). É o mesmo conjunto do modal "Chamados abertos", e
   * inclui o pendente (status 4), ao contrário da fila do perfil Triagem.
   */
  const abertosPorDepartamento = useMemo(() => {
    const todas = dadosDashboard?.listas_abertos_por_departamento ?? {};
    const mapa: Record<string, ChamadoLista[]> = {};
    for (const [departamento, lista] of Object.entries(todas)) {
      mapa[departamento] = filtrarChamados(lista, buscaChamados, localizacaoDoTermo);
    }
    return mapa;
  }, [dadosDashboard, buscaChamados, localizacaoDoTermo]);
  /**
   * Busca a localização do chamado cujo **id** foi digitado em "Buscar chamados"
   * (Tarefa 95). Reaproveita `GET /api/glpi/busca`, que desde a T89 resolve o
   * número do chamado pela chave primária e devolve a localização.
   *
   * Não é resolvido no navegador porque o chamado digitado pode nem estar nas
   * listas da tela: é o caso comum de um chamado já solucionado e antigo, que é
   * justamente o que se procura para descobrir o local.
   */
  useEffect(() => {
    const termo = buscaChamados.trim();

    // Termo não é número: nada a descobrir, a filtragem por texto vale.
    if (!termoEhNumero(termo)) {
      setLocalizacaoDoTermo(null);
      return;
    }

    let cancelado = false;
    const temporizador = setTimeout(async () => {
      try {
        const resposta = await fetch(`/api/glpi/busca?termo=${encodeURIComponent(termo)}`, {
          cache: 'no-store',
        });
        const dados = resposta.ok
          ? ((await resposta.json()) as { resultados?: ChamadoLista[] })
          : null;
        if (cancelado) return;
        // A busca por id devolve o próprio chamado; id inexistente vem vazio e
        // a filtragem por texto normal continua valendo.
        setLocalizacaoDoTermo(dados?.resultados?.[0]?.localizacao || null);
      } catch {
        if (!cancelado) setLocalizacaoDoTermo(null);
      }
    }, ESPERA_BUSCA_LOCALIZACAO_MS);

    // Digitar de novo antes da hora descarta a consulta que estava na fila.
    return () => {
      cancelado = true;
      clearTimeout(temporizador);
    };
  }, [buscaChamados]);

  /** Lista do modal filtrada a cada letra pelo termo interno (id/título/solicitante/local). */
  const abertosModalFiltrados = useMemo(() => {
    const base =
      modalDepartamento === null
        ? (dadosDashboard?.lista_abertos ?? [])
        : (dadosDashboard?.listas_abertos_por_departamento?.[modalDepartamento] ?? []);
    return filtrarChamados(base, buscaModal);
  }, [dadosDashboard, buscaModal, modalDepartamento]);
  /** Termo digitado no campo de busca dos cards (filtra as listas ao digitar). */

  /** Abre o modal zerando a busca interna; fecha e limpa ao sair. */
  function abrirModalAbertos(departamento: string | null = null) {
    setBuscaModal('');
    setModalDepartamento(departamento);
    setModalAbertos(true);
  }

  function fecharModalAbertos() {
    setModalAbertos(false);
    setModalDepartamento(null);
    setBuscaModal('');
  }

  /** Título do modal: total geral ou o quadrado clicado. */
  const tituloModalAbertos = modalDepartamento ?? 'Chamados abertos';

  // Esc fecha o modal de abertos (ouvinte ativo só enquanto ele está aberto).
  useEffect(() => {
    if (!modalAbertos) return;
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === 'Escape') fecharModalAbertos();
    }
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [modalAbertos]);

  // Busca geral (Tarefa 84): consulta a base inteira do GLPI, mas só uma vez —
  // depois de `ESPERA_BUSCA_GERAL_MS` sem digitar nada, e nunca com termo curto.
  useEffect(() => {
    const termo = termoBuscaGeral.trim();
    // T89: número de chamado sai com 1 dígito (é consulta por chave primária);
    // os demais termos continuam exigindo MINIMO_BUSCA_GERAL.
    // T112: a sigla de secretaria também sai sem o mínimo — `SMH` tem 3 letras
    // e o servidor já a trata como filtro de localização (barato, pelo índice).
    if (
      termo.length < MINIMO_BUSCA_GERAL &&
      !termoEhNumero(termo) &&
      !interpretarTermo(termo).sigla
    ) {
      setResultadosBuscaGeral([]);
      setBuscandoGeral(false);
      setErroBuscaGeral(null);
      return;
    }

    let cancelado = false;
    setBuscandoGeral(true);
    setErroBuscaGeral(null);

    const temporizador = setTimeout(async () => {
      try {
        const resposta = await fetch(`/api/glpi/busca?termo=${encodeURIComponent(termo)}`, {
          cache: 'no-store',
        });
        const dados = (await resposta.json()) as { resultados?: ChamadoLista[]; erro?: string };
        if (cancelado) return;
        setResultadosBuscaGeral(dados.resultados ?? []);
        setErroBuscaGeral(resposta.ok ? null : (dados.erro ?? 'Não foi possível buscar agora.'));
      } catch {
        if (!cancelado) {
          setResultadosBuscaGeral([]);
          setErroBuscaGeral('Não foi possível buscar agora.');
        }
      } finally {
        if (!cancelado) setBuscandoGeral(false);
      }
    }, ESPERA_BUSCA_GERAL_MS);

    // Digitar de novo antes da hora descarta a consulta que estava na fila.
    return () => {
      cancelado = true;
      clearTimeout(temporizador);
    };
  }, [termoBuscaGeral]);

  // T112: o termo está pronto para consultar quando tem o mínimo de caracteres,
  // ou quando é um número de chamado (T89), ou quando é a sigla de uma
  // secretaria (`SMH` tem 3 letras). Sem isso, a sigla buscaria mas a tela
  // continuaria mostrando "nenhum chamado encontrado" mesmo tendo o que exibir.
  const termoBuscaGeralPronto =
    termoBuscaGeral.trim().length >= MINIMO_BUSCA_GERAL ||
    termoEhNumero(termoBuscaGeral.trim()) ||
    Boolean(interpretarTermo(termoBuscaGeral.trim()).sigla);

  /** A busca geral já rodou para o termo atual e não achou nada. */
  const buscaGeralSemResultado = termoBuscaGeralPronto && !buscandoGeral && !erroBuscaGeral;

  const consultarStatus = useCallback(async (): Promise<ResultadoSincronizacao | null> => {
    const resposta = await fetch('/api/glpi/sync', { cache: 'no-store' });
    if (!resposta.ok) throw new Error('Não foi possível consultar o status da sincronização.');

    const dados = await resposta.json();
    return (dados?.sincronizacao ?? null) as ResultadoSincronizacao | null;
  }, []);

  async function iniciarSincronizacao() {
    setErroSincronizacao(null);
    setMostrarResultado(true);

    try {
      const resposta = await fetch('/api/glpi/sync', { method: 'POST' });
      const dados = await resposta.json().catch(() => null);

      // 409 = já havia uma execução em andamento: segue acompanhando o status dela.
      if (resposta.ok || resposta.status === 409) {
        setResultado((dados?.sincronizacao ?? null) as ResultadoSincronizacao | null);
        setSincronizando(true);
        return;
      }

      setErroSincronizacao(dados?.erro ?? 'Não foi possível iniciar a sincronização.');
    } catch {
      setErroSincronizacao('Não foi possível iniciar a sincronização. Verifique se o servidor está no ar.');
    }
  }

  async function pararSincronizacao() {
    setErroSincronizacao(null);

    try {
      const resposta = await fetch('/api/glpi/sync', { method: 'DELETE' });
      const dados = await resposta.json().catch(() => null);

      // 409 = ja tinha terminado entre o clique e a requisicao: segue acompanhando.
      if (resposta.ok || resposta.status === 409) {
        setResultado((dados?.sincronizacao ?? null) as ResultadoSincronizacao | null);
        return;
      }

      setErroSincronizacao(dados?.erro ?? 'Não foi possível parar a sincronização.');
    } catch {
      setErroSincronizacao('Não foi possível parar a sincronização. Verifique se o servidor está no ar.');
    }
  }

  async function carregarDashboard() {
    try {
      const resposta = await fetch('/api/glpi/dashboard', { cache: 'no-store' });
      if (!resposta.ok) throw new Error('Não foi possível carregar o dashboard.');
      const dados = await resposta.json();
      setDadosDashboard(dados?.dashboard ?? null);
      setErroDashboard(null);
    } catch (erro) {
      setErroDashboard(
        erro instanceof Error ? erro.message : 'Erro ao carregar o dashboard.'
      );
      setDadosDashboard(null);
    }
  }

  /**
   * Marca os acompanhamentos do chamado como vistos (Tarefa 36): zera o
   * `nao_vistos` local na hora (volta ao amarelo normal e reordena para a
   * posição alfabética) e confirma no servidor; depois recarrega o dashboard
   * para consolidar a ordem vinda da API.
   */
  async function marcarComoVisto(id: number) {
    setDadosDashboard((anterior) => {
      if (!anterior) return anterior;
      const zerar = (lista: ChamadoLista[] | undefined) =>
        (lista ?? []).map((c) => (c.id === id ? { ...c, nao_vistos: 0 } : c));
      return {
        ...anterior,
        lista_retirada: zerar(anterior.lista_retirada),
        lista_equipamento: zerar(anterior.lista_equipamento),
        lista_solucionados_hoje: zerar(anterior.lista_solucionados_hoje),
        lista_fila_manutencao: zerar(anterior.lista_fila_manutencao),
        lista_abertos: zerar(anterior.lista_abertos),
        listas_abertos_por_departamento: Object.fromEntries(
          Object.entries(anterior.listas_abertos_por_departamento ?? {}).map(([dep, lista]) => [dep, zerar(lista)])
        ),
        fila_por_departamento: Object.fromEntries(
          Object.entries(anterior.fila_por_departamento ?? {}).map(([dep, lista]) => [dep, zerar(lista)])
        ),
        pendentes_por_departamento: Object.fromEntries(
          Object.entries(anterior.pendentes_por_departamento ?? {}).map(([dep, lista]) => [dep, zerar(lista)])
        ),
      };
    });
    try {
      await fetch(`/api/glpi/chamados/${id}/visto`, { method: 'POST' });
    } catch {
      // Falha de rede: o estado local já saiu do amarelo; o próximo
      // carregarDashboard reconcilia com o servidor.
    }
    carregarDashboard();
  }

  /**
   * Devolve o chamado ao estado "com acompanhamento novo" (Tarefa 93): o
   * `visto` do último acompanhamento volta a 0 e o item fica amarelo outra vez.
   * Serve para o caso de o técnico ter clicado no item sem querer e a pessoa
   * que deveria ver o aviso passar batido.
   *
   * O estado local é atualizado na hora (o item já nasce amarelo e vai para o
   * topo da lista) e o servidor é confirmado em seguida; se o chamado não
   * tiver acompanhamento nenhum, o `carregarDashboard` final desfaz o amarelo.
   */
  async function marcarComoNaoVisto(id: number) {
    setDadosDashboard((anterior) => {
      if (!anterior) return anterior;
      const avisar = (lista: ChamadoLista[] | undefined) =>
        (lista ?? []).map((c) => (c.id === id && c.status !== 5 && c.status !== 6 ? { ...c, nao_vistos: 1 } : c));
      return {
        ...anterior,
        lista_retirada: avisar(anterior.lista_retirada),
        lista_equipamento: avisar(anterior.lista_equipamento),
        lista_solucionados_hoje: avisar(anterior.lista_solucionados_hoje),
        lista_fila_manutencao: avisar(anterior.lista_fila_manutencao),
        lista_abertos: avisar(anterior.lista_abertos),
        listas_abertos_por_departamento: Object.fromEntries(
          Object.entries(anterior.listas_abertos_por_departamento ?? {}).map(([dep, lista]) => [dep, avisar(lista)])
        ),
        fila_por_departamento: Object.fromEntries(
          Object.entries(anterior.fila_por_departamento ?? {}).map(([dep, lista]) => [dep, avisar(lista)])
        ),
        pendentes_por_departamento: Object.fromEntries(
          Object.entries(anterior.pendentes_por_departamento ?? {}).map(([dep, lista]) => [dep, avisar(lista)])
        ),
      };
    });
    try {
      await fetch(`/api/glpi/chamados/${id}/visto`, { method: 'DELETE' });
    } catch {
      // Falha de rede: o proximo carregarDashboard reconcilia com o servidor.
    }
    carregarDashboard();
  }

  // Ao montar, carrega os dados do dashboard, guarda o status (alimenta o rotulo
  // "Ultima sincronizacao") e verifica se ha execucao em andamento.
  // O resultado da execucao ANTERIOR nao exibe a faixa (ela nasce escondida).
  useEffect(() => {
    carregarDashboard();

    let ativo = true;

    consultarStatus()
      .then((estado) => {
        if (!ativo || !estado) return;

        setResultado(estado);
        executandoVisto.current = estado.executando;
        finalizadoEmVisto.current = estado.finalizadoEm ?? null;
        if (!estado.executando) return;

        setSincronizando(true);
        setMostrarResultado(true);
      })
      .catch(() => undefined);

    return () => {
      ativo = false;
    };
  }, [consultarStatus]);

  // Consulta o status ENQUANTO A PAGINA ESTA ABERTA: rapido (2s) durante a
  // execucao e mais lento (15s) em repouso, para perceber uma sincronizacao
  // disparada pelo agendador automatico e atualizar dashboard + rotulo sozinhos.
  useEffect(() => {
    const intervalo = sincronizando ? INTERVALO_STATUS_MS : INTERVALO_STATUS_OCIOSO_MS;

    const identificador = window.setInterval(async () => {
      try {
        const estado = await consultarStatus();
        if (!estado) return;

        const antesExecutando = executandoVisto.current;
        const antesFinalizado = finalizadoEmVisto.current;
        executandoVisto.current = estado.executando;
        finalizadoEmVisto.current = estado.finalizadoEm ?? null;

        // Nova conclusao observada (a primeira leitura da pagina nao conta).
        const completou =
          !estado.executando &&
          antesFinalizado !== undefined &&
          (estado.finalizadoEm ?? null) !== antesFinalizado;

        if (estado.executando && antesExecutando !== true) {
          // Comecou agora (agendador): entra em modo de acompanhamento.
          setSincronizando(true);
          setMostrarResultado(true);
          setErroSincronizacao(null);
        } else if (!estado.executando && antesExecutando === true) {
          setSincronizando(false);
        }

        setResultado((atual) => (mesmoResultado(atual, estado) ? atual : estado));

        if (completou) {
          setMostrarResultado(true);
          carregarDashboard();
        }
      } catch (erro) {
        // Em repouso, falha pontual de rede e ignorada (tenta no proximo tick).
        if (!sincronizando) return;

        setErroSincronizacao(
          erro instanceof Error ? erro.message : 'Não foi possível consultar o status da sincronização.'
        );
        setSincronizando(false);
      }
    }, intervalo);

    return () => window.clearInterval(identificador);
  }, [sincronizando, consultarStatus]);

  // Canal de avisos do servidor (Tarefa 67): quando a sincronizacao termina — pelo
  // botao de qualquer usuario ou pelo agendador — o servidor empurra o aviso e esta
  // tela recarrega o dashboard e o rotulo de "ultima sincronizacao" na hora, sem
  // esperar o proximo tique do polling. O polling de 15 s continua valendo como rede
  // de seguranca caso o canal caia.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    const canal = new EventSource('/api/glpi/eventos');

    function aoReceberAviso() {
      // O aviso chega tanto do botao quanto do AGENDADOR do servidor. Nos dois
      // casos o que interessa aqui e o estado da sincronizacao — reconsultar e o
      // que faz o botao virar "Parar sincronizacao" em todas as abas abertas,
      // na hora, sem recarregar a pagina (Tarefa 99). O dashboard so e
      // recarregado mesmo quando a sincronizacao TERMINOU, que e quando ha dado
      // novo para exibir; recarrega-lo a cada aviso seria consulta inutil.
      const soConsultar = () => {
        consultarStatus()
          .then((estado) => {
            if (!estado) return;
            setSincronizando(estado.executando);
            setResultado((atual) => (mesmoResultado(atual, estado) ? atual : estado));
          })
          .catch(() => undefined);
      };

      consultarStatus()
        .then((estado) => {
          const terminou = estado && !estado.executando;
          if (terminou) carregarDashboard();
        })
        .catch(() => undefined)
        .finally(soConsultar);
    }

    canal.addEventListener('message', aoReceberAviso);
    canal.onerror = () => {
      // O proprio EventSource tenta reconectar; nao ha nada a fazer aqui.
    };

    return () => {
      canal.removeEventListener('message', aoReceberAviso);
      canal.close();
    };
  }, [consultarStatus]);

  // Painel acompanhando a sincronizacao: enquanto o script roda, recarrega o
  // dashboard a cada 1 s (Tarefa 110). Assim o chamado aparece no card
  // "Chamados abertos" (e nos demais cards) conforme vai sendo gravado, em vez
  // de so no fim. A trava `painelEmCarga` evita empilhar requisicoes quando o
  // dashboard demora mais que o intervalo. Fora da sincronizacao o efeito nao
  // existe: o SSE e o polling de status ja dao conta do recarregamento.
  useEffect(() => {
    if (!sincronizando) return;

    const temporizador = window.setInterval(async () => {
      if (painelEmCarga.current) return;
      painelEmCarga.current = true;
      try {
        await carregarDashboard();
      } finally {
        painelEmCarga.current = false;
      }
    }, INTERVALO_PAINEL_DURANTE_SYNC_MS);

    return () => window.clearInterval(temporizador);
    // `carregarDashboard` e recriado a cada render de proposito: depender dele
    // aqui reescreveria o intervalo o tempo todo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sincronizando]);

  // A faixa some sozinha depois de terminada — tanto numa sincronizacao
  // CONCLUIDA quanto numa INTERROMPIDA de proposito. Antes so sumia no sucesso,
  // e a parada deixava "Sincronizacao interrompida" congelada na tela para
  // sempre, parecendo que a tela travara. Um erro de verdade (com `erro` no
  // estado) continua na tela, que e o que se quer ver.
  useEffect(() => {
    if (sincronizando || !mostrarResultado || !resultado?.finalizadoEm || resultado?.erro) {
      return;
    }

    const identificador = window.setTimeout(() => setMostrarResultado(false), DURACAO_CONCLUSAO_MS);
    return () => window.clearTimeout(identificador);
  }, [sincronizando, mostrarResultado, resultado]);

  // Tarefa 110: enquanto roda, a linha de progresso (`Atualizando ... x de y`)
  // aparece ONDE antes ficava "Última sincronização: em andamento".
  const progressoSincronizacao = resultado?.parando
    ? 'Parando…'
    : (resultado?.ultimaLinha || 'Sincronizando…');

  // Texto de conclusão/interrupção (Tarefa 111: aparece SÓ junto ao botão).
  const tituloSincronizacao = resultado
    ? resultado.sucesso
      ? 'Concluído.'
      : `Sincronização interrompida${horaCurta(resultado.finalizadoEm)}`
    : '';

  const houveFalha = Boolean(erroSincronizacao) || resultado?.sucesso === false;

  /** Rotulo ao lado do botao: data da ultima sincronizacao concluida. */
  const ultimaSincronizacao = dataHoraCurta(resultado?.finalizadoEm ?? null) ?? '—';

  // Tarefa 111: o rótulo à esquerda do botão "Sincronizar" é o ÚNICO lugar onde
  // o resultado aparece (antes também saía junto do título, e ficava duplicado).
  // Ele tem 3 estados: progresso (em execução) → conclusão/erro (5 s) → data.
  const mostrarConclusaoNoBotao = !sincronizando && Boolean(
    erroSincronizacao || (mostrarResultado && resultado)
  );
  const textoRotuloBotao = sincronizando
    ? progressoSincronizacao
    : mostrarConclusaoNoBotao
      ? (erroSincronizacao ?? tituloSincronizacao)
      : `Última sincronização: ${ultimaSincronizacao}`;

  return (
    <div className="glpi">
      {/* Cabeçalho do painel (Tarefa 106/107). O título é o mesmo `<h1
          className="cabecalho__titulo">` das outras telas — antes usava
          `dashboard__titulo` (1.05rem), bem menor que o padrão (1.6rem). Mostra
          também a aba escolhida no submenu. A ação de sincronização fica na mesma
          linha; as abas saíram daqui para o submenu do GLPI no menu lateral. */}
      <div className="glpi__topo">
        <h1 className="cabecalho__titulo">
          GLPI - {rotuloDaAba}
        </h1>
        <div className="glpi__acao">
          <span
            className={`glpi__acao-ultima${houveFalha && !sincronizando ? ' glpi__acao-ultima--erro' : ''}`}
            role="status"
            aria-live="polite"
            title={
              sincronizando
                ? 'Progresso da sincronização'
                : mostrarConclusaoNoBotao
                  ? 'Resultado da última sincronização'
                  : 'Data e hora da última sincronização concluída'
            }
          >
            {textoRotuloBotao}
          </span>
          <button
            type="button"
            className="glpi__acao-botao"
            onClick={sincronizando ? pararSincronizacao : iniciarSincronizacao}
            disabled={Boolean(resultado?.parando)}
            title={
              sincronizando
                ? 'Interrompe a sincronização. O progresso fica salvo e a próxima execução continua de onde parou.'
                : 'Busca no GLPI os chamados novos e os que tiveram alteração'
            }
          >
            <svg
              className="glpi__acao-botao__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {sincronizando ? (
                // Quadrado cheio: o icone de "parar" enquanto a sincronizacao roda.
                <rect x="6" y="6" width="12" height="12" rx="1" />
              ) : (
                <>
                  <path d="M21 12a9 9 0 1 1-9-9" />
                  <path d="M21 3v6h-6" />
                </>
              )}
            </svg>
            <span className="glpi__acao-botao__texto">
              {sincronizando
                ? resultado?.parando
                  ? 'Parando…'
                  : 'Parar sincronização'
                : 'Sincronizar'}
            </span>
          </button>
        </div>
      </div>

      <div className="glpi__painel">
        {abaAtiva === 'dashboard' && (
          <section className="glpi__aba-conteudo" id="painel-dashboard" role="tabpanel">
            {/* Sem título aqui: o "Suporte" do topo do painel já nomeia a aba
                (Tarefa 106). */}
            <div className="dashboard__faixa" role="list">
              <article className="dashboard__card dashboard__card--faixa" role="listitem">
                <p className="dashboard__card-titulo">Chamados abertos</p>
                {dadosDashboard && (
                  <ul className="dashboard__abertos-lista dashboard__abertos-lista--linha">
                    <li key="__total" className="dashboard__abertos-item dashboard__abertos-item--total">
                      <button
                        type="button"
                        className="dashboard__abertos-botao dashboard__abertos-botao--total"
                        onClick={() => abrirModalAbertos(null)}
                        title="Ver todos os chamados abertos"
                        aria-label={`Ver todos os chamados abertos: ${dadosDashboard.abertos}`}
                      >
                        <span className="dashboard__abertos-departamento">Total</span>
                        <span className="dashboard__abertos-total">{dadosDashboard.abertos}</span>
                      </button>
                    </li>
                    {dadosDashboard.abertos_por_departamento.map((dep) => (
                      <li key={dep.departamento} className="dashboard__abertos-item">
                        <button
                          type="button"
                          className="dashboard__abertos-botao"
                          onClick={() => abrirModalAbertos(dep.departamento)}
                          title={`Ver chamados abertos de ${dep.departamento}`}
                          aria-label={`Ver chamados abertos de ${dep.departamento}: ${dep.total}`}
                        >
                          <span className="dashboard__abertos-departamento">{dep.departamento}</span>
                          <span className="dashboard__abertos-total">{dep.total}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            </div>
            {/* Perfil de exibição: fica entre o card "Visão geral" e a barra de
                busca para não se misturar com as funções que já existem aqui. */}
            <SeletorPerfil valor={perfil} onChange={setPerfil} />
            <div className="barra-ferramentas">
              <label className="campo campo-busca campo-busca--dashboard">
                <span className="campo__rotulo">Buscar chamados</span>
                <input
                  className="entrada"
                  type="search"
                  placeholder="Digite qualquer informação…"
                  value={buscaChamados}
                  onChange={(evento) => setBuscaChamados(evento.target.value)}
                />
              </label>
              {/* Canto direito da linha da busca: abre a busca geral (Tarefa 83). */}
              <button type="button" className="botao" onClick={() => setModalBuscaGeral(true)}>
                Busca geral
              </button>
            </div>
            {ehPerfilTriagem ? (
              /* Perfil Triagem: a fila de cada um dos 7 departamentos (Tarefa 101). */
              <div className="dashboard__cards" role="list">
                {FILAS_DO_TRIAGEM.map((departamento) => (
                  <article className="dashboard__card" role="listitem" key={departamento.chave}>
                    <p className="dashboard__card-titulo">{departamento.titulo}</p>
                    <p className="dashboard__card-numero">
                      {!dadosDashboard ? '—' : (filasPorDepartamento[departamento.chave]?.length ?? 0)}
                    </p>
                    <ListaChamados
                      chamados={filasPorDepartamento[departamento.chave] ?? []}
                      buscando={buscandoAtivo}
                      aoMarcarVisto={marcarComoVisto}
                      aoDesmarcar={marcarComoNaoVisto}
                    />
                  </article>
                ))}
              </div>
            ) : ehPerfilManutencao ? (
              /* Perfil Manutenção (Tarefa 101): 5 cards, todos recortados pela
                 Manutenção. "Pendente" traz só os que estão pendentes SEM motivo —
                 os que têm motivo já aparecem em Retirada ou Equipamento. */
              <div className="dashboard__cards" role="list">
                <article className="dashboard__card" role="listitem">
                  <p className="dashboard__card-titulo">Chamados solucionados hoje</p>
                  <p className="dashboard__card-numero">{!dadosDashboard ? '—' : solucionadosDoPerfil.length}</p>
                  <ListaChamados chamados={solucionadosDoPerfil} buscando={buscandoAtivo} aoMarcarVisto={marcarComoVisto} />
                </article>
                <article className="dashboard__card" role="listitem">
                  <p className="dashboard__card-titulo">Na fila de manutenção</p>
                  <p className="dashboard__card-numero">{!dadosDashboard ? '—' : filaDoPerfil.length}</p>
                  <ListaChamados chamados={filaDoPerfil} buscando={buscandoAtivo} aoMarcarVisto={marcarComoVisto} aoDesmarcar={marcarComoNaoVisto} />
                </article>
                <article className="dashboard__card" role="listitem">
                  <p className="dashboard__card-titulo">Aguardando retirada</p>
                  <p className="dashboard__card-numero">{!dadosDashboard ? '—' : retiradaDoPerfil.length}</p>
                  <ListaChamados chamados={retiradaDoPerfil} buscando={buscandoAtivo} aoMarcarVisto={marcarComoVisto} aoDesmarcar={marcarComoNaoVisto} />
                </article>
                <article className="dashboard__card" role="listitem">
                  <p className="dashboard__card-titulo">Aguardando equipamento</p>
                  <p className="dashboard__card-numero">{!dadosDashboard ? '—' : equipamentoDoPerfil.length}</p>
                  <ListaChamados chamados={equipamentoDoPerfil} buscando={buscandoAtivo} aoMarcarVisto={marcarComoVisto} aoDesmarcar={marcarComoNaoVisto} />
                </article>
                <article className="dashboard__card" role="listitem">
                  <p className="dashboard__card-titulo">Pendente</p>
                  <p className="dashboard__card-numero">{!dadosDashboard ? '—' : pendentesSemMotivoDoPerfil.length}</p>
                  <ListaChamados chamados={pendentesSemMotivoDoPerfil} buscando={buscandoAtivo} aoMarcarVisto={marcarComoVisto} aoDesmarcar={marcarComoNaoVisto} />
                </article>
              </div>
            ) : ehPerfilGeral ? (
              /* Perfil Geral (Tarefa 102): os abertos de cada departamento e, no
                 fim, os solucionados hoje de todo o Suporte Técnico. */
              <div className="dashboard__cards" role="list">
                {ABERTOS_DO_GERAL.map((departamento) => (
                  <article className="dashboard__card" role="listitem" key={departamento.chave}>
                    <p className="dashboard__card-titulo">{departamento.titulo}</p>
                    <div className="dashboard__card-cabecalho">
                      <p className="dashboard__card-numero">
                        {!dadosDashboard ? '—' : (abertosPorDepartamento[departamento.chave]?.length ?? 0)}
                      </p>
                      {/* Números pequenos ao lado do total (Tarefa 103). Vem do resumo
                          por departamento da API, que é só contagem. */}
                      {dadosDashboard && resumoDoCard(dadosDashboard.resumo_por_departamento?.[departamento.chave])}
                    </div>
                    <ListaChamados
                      chamados={abertosPorDepartamento[departamento.chave] ?? []}
                      buscando={buscandoAtivo}
                      aoMarcarVisto={marcarComoVisto}
                      aoDesmarcar={marcarComoNaoVisto}
                    />
                  </article>
                ))}
                <article className="dashboard__card" role="listitem">
                  <p className="dashboard__card-titulo">Chamados solucionados hoje</p>
                  <p className="dashboard__card-numero">
                    {!dadosDashboard
                      ? '—'
                      : buscandoAtivo
                        ? solucionadosDoPerfil.length
                        : dadosDashboard.solucionados_hoje}
                  </p>
                  <ListaChamados chamados={solucionadosDoPerfil} buscando={buscandoAtivo} aoMarcarVisto={marcarComoVisto} />
                </article>
              </div>
            ) : (
              departamentoDoPerfil && (
                /* Perfil de departamento: só os 3 cards do próprio departamento
                   (Tarefa 101). Solucionados + fila (abertos sem os pendentes) +
                   os pendentes — os dois últimos juntos dão todos os abertos. */
                <div className="dashboard__cards dashboard__cards--tres" role="list">
                  <article className="dashboard__card" role="listitem">
                    <p className="dashboard__card-titulo">Chamados solucionados hoje</p>
                    <p className="dashboard__card-numero">
                      {!dadosDashboard ? '—' : solucionadosDoPerfil.length}
                    </p>
                    <ListaChamados chamados={solucionadosDoPerfil} buscando={buscandoAtivo} aoMarcarVisto={marcarComoVisto} />
                  </article>
                  <article className="dashboard__card" role="listitem">
                    <p className="dashboard__card-titulo">Na fila de chamados</p>
                    <p className="dashboard__card-numero">
                      {!dadosDashboard ? '—' : filaDoPerfil.length}
                    </p>
                    <ListaChamados chamados={filaDoPerfil} buscando={buscandoAtivo} aoMarcarVisto={marcarComoVisto} aoDesmarcar={marcarComoNaoVisto} />
                  </article>
                  <article className="dashboard__card" role="listitem">
                    <p className="dashboard__card-titulo">Pendentes</p>
                    <p className="dashboard__card-numero">
                      {!dadosDashboard ? '—' : pendentesDoPerfil.length}
                    </p>
                    <ListaChamados chamados={pendentesDoPerfil} buscando={buscandoAtivo} aoMarcarVisto={marcarComoVisto} aoDesmarcar={marcarComoNaoVisto} />
                  </article>
                </div>
              )
            )}
          </section>
        )}
        {abaAtiva === 'chamados' && (
          <section className="glpi__aba-conteudo" id="painel-chamados" role="tabpanel">
            <div className="glpi__vazio">
              <p>Chamados — em breve</p>
            </div>
          </section>
        )}
        {abaAtiva === 'faq' && (
          <section className="glpi__aba-conteudo" id="painel-faq" role="tabpanel">
            <div className="glpi__vazio">
              <p>FAQ — em breve</p>
            </div>
          </section>
        )}
      </div>

      {modalAbertos && (
        <div
          className="sobreposicao"
          role="presentation"
          onMouseDown={(evento) => evento.target === evento.currentTarget && fecharModalAbertos()}
        >
          <div className="modal modal--largo" role="dialog" aria-modal="true" aria-labelledby="titulo-modal-abertos">
            <header className="modal__cabecalho">
              <h2 className="modal__titulo" id="titulo-modal-abertos">
                {tituloModalAbertos} <span className="selo">{abertosModalFiltrados.length}</span>
              </h2>
              <button type="button" className="modal__fechar" onClick={fecharModalAbertos} aria-label="Fechar">
                ×
              </button>
            </header>
            <div className="modal__busca">
              <label className="campo campo-busca campo-busca--modal">
                <span className="campo__rotulo">Pesquisar neste modal</span>
                <input
                  className="entrada"
                  type="search"
                  autoFocus
                  placeholder="Digite qualquer informação…"
                  value={buscaModal}
                  onChange={(evento) => setBuscaModal(evento.target.value)}
                />
              </label>
            </div>
            <div className="modal__corpo">
              <ListaChamados
                chamados={abertosModalFiltrados}
                buscando={buscaModal.trim() !== ''}
                aoMarcarVisto={marcarComoVisto}
              />
            </div>
          </div>
        </div>
      )}
      {modalBuscaGeral && (
        <div
          className="sobreposicao"
          role="presentation"
          onMouseDown={(evento) => {
            if (evento.target !== evento.currentTarget) return;
            // Fechar por fora tambem limpa a pesquisa: o modal abre vazio na proxima vez.
            setModalBuscaGeral(false);
            setTermoBuscaGeral('');
          }}
        >
          <div className="modal modal--largo" role="dialog" aria-modal="true" aria-labelledby="titulo-modal-busca-geral">
            <header className="modal__cabecalho">
              <h2 className="modal__titulo" id="titulo-modal-busca-geral">
                Busca geral
              </h2>
              <button
                type="button"
                className="modal__fechar"
                onClick={() => {
                  setModalBuscaGeral(false);
                  setTermoBuscaGeral('');
                }}
                aria-label="Fechar"
              >
                ×
              </button>
            </header>
            <p className="modal__subtitulo">Busca em todos os chamados do GLPI</p>
            <div className="modal__busca">
              <label className="campo campo-busca campo-busca--modal">
                <input
                  className="entrada"
                  type="search"
                  autoFocus
                  placeholder="Digite qualquer informação…"
                  value={termoBuscaGeral}
                  onChange={(evento) => setTermoBuscaGeral(evento.target.value)}
                />
              </label>
            </div>
            <div className="modal__corpo">
              {buscandoGeral ? (
                <p className="dashboard__lista-vazio">Buscando…</p>
              ) : erroBuscaGeral ? (
                <p className="dashboard__lista-vazio">{erroBuscaGeral}</p>
              ) : (
                <ListaChamados
                  chamados={resultadosBuscaGeral}
                  buscando={buscaGeralSemResultado}
                  aoMarcarVisto={marcarComoVisto}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
