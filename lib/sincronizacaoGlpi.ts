import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { publicarAtualizacao } from './eventosGlpi';

/** Sincronizador GLPI -> SQLite, executado como processo filho (nao bloqueia o servidor). */
const CAMINHO_SCRIPT = path.join(process.cwd(), 'scripts', 'sincronizar-glpi.js');

/** Quantidade de linhas de log mantidas em memoria para exibir na tela. */
const LIMITE_LINHAS = 80;

/**
 * Codigo de saida do script quando a parada foi pedida pela tela
 * (128 + SIGTERM). O `scripts/sincronizar-glpi.js` devolve esse valor depois de
 * salvar o progresso, e ele e o que distingue "o usuario parou" de "deu erro".
 */
const CODIGO_PARADA = 143;

export type EstadoSincronizacao = {
  executando: boolean;
  /** A parada foi pedida e o script ainda esta encerrando (Tarefa 99). */
  parando: boolean;
  iniciadoEm: string | null;
  finalizadoEm: string | null;
  sucesso: boolean | null;
  codigoSaida: number | null;
  ultimaLinha: string;
  linhas: string[];
  erro: string | null;
};

type MemoriaSincronizacao = {
  estado: EstadoSincronizacao;
  processo: ChildProcess | null;
  resto: string;
};

/** Cache global no mesmo padrao de `lib/db.ts`: sobrevive ao hot reload do modo dev. */
const memoria = globalThis as typeof globalThis & {
  __dinfSincronizacaoGlpi?: MemoriaSincronizacao;
};

function obterMemoria(): MemoriaSincronizacao {
  if (!memoria.__dinfSincronizacaoGlpi) {
    memoria.__dinfSincronizacaoGlpi = {
      estado: {
        executando: false,
        parando: false,
        iniciadoEm: null,
        finalizadoEm: null,
        sucesso: null,
        codigoSaida: null,
        ultimaLinha: '',
        linhas: [],
        erro: null,
      },
      processo: null,
      resto: '',
    };
  }

  return memoria.__dinfSincronizacaoGlpi;
}

/** Acumula a saida do script linha a linha, mantendo apenas as ultimas linhas. */
function acumularSaida(memoriaSync: MemoriaSincronizacao, texto: string) {
  const pedacos = (memoriaSync.resto + texto).split(/\r?\n/);
  memoriaSync.resto = pedacos.pop() ?? '';

  for (const pedaco of pedacos) {
    const linha = pedaco.trim();
    if (!linha) continue;

    memoriaSync.estado.linhas.push(linha);
    memoriaSync.estado.ultimaLinha = linha;
  }

  const excedente = memoriaSync.estado.linhas.length - LIMITE_LINHAS;
  if (excedente > 0) memoriaSync.estado.linhas.splice(0, excedente);
}

function finalizar(memoriaSync: MemoriaSincronizacao, codigo: number | null, falha?: string) {
  const estado = memoriaSync.estado;

  if (falha) {
    estado.erro = falha;
  } else if (codigo === CODIGO_PARADA) {
    // 143 = 128 + SIGTERM: o usuario pediu para parar. NAO e falha, e sim a
    // parada que ele pediu — mostrar "O script terminou com o codigo 143" como
    // erro assustava quem tinha feito a parada de proposito.
    estado.erro = null;
  } else if (codigo !== 0 && !estado.erro) {
    estado.erro = `O script terminou com o código ${codigo}. Veja o log.`;
  }

  estado.executando = false;
  estado.parando = false;
  estado.codigoSaida = codigo;
  estado.sucesso = codigo === 0 && !estado.erro;
  estado.finalizadoEm = new Date().toISOString();
  memoriaSync.processo = null;

  // Avisa todos os clientes conectados (Tarefa 67). Este e o unico ponto em que uma
  // sincronizacao termina — tanto pelo botao quanto pelo agendador —, entao o aviso
  // sai uma unica vez, sem depender de quem disparou.
  publicarAtualizacao('sincronizacao-concluida');
}

/** Estado atual da ultima sincronizacao (usado pelo GET da rota e pela tela). */
export function lerEstadoSincronizacao(): EstadoSincronizacao {
  return obterMemoria().estado;
}

export type ResultadoInicio =
  | { codigo: 'iniciado'; estado: EstadoSincronizacao }
  | { codigo: 'em-andamento'; estado: EstadoSincronizacao }
  | { codigo: 'script-ausente'; erro: string };

/**
 * Dispara o script do GLPI em segundo plano.
 * Usado pela rota POST /api/glpi/sync (botao "Sincronizar") e pelo agendador
 * automatico (`lib/agendadorGlpi.ts`) — ambos compartilham a MESMA trava
 * (`estado.executando`), entao nunca ha dois processos filhos em paralelo.
 */
export function iniciarSincronizacao(): ResultadoInicio {
  const memoriaSync = obterMemoria();

  if (memoriaSync.estado.executando) {
    return { codigo: 'em-andamento', estado: memoriaSync.estado };
  }

  if (!fs.existsSync(CAMINHO_SCRIPT)) {
    return { codigo: 'script-ausente', erro: `Script não encontrado em ${CAMINHO_SCRIPT}.` };
  }

  memoriaSync.estado = {
    executando: true,
    parando: false,
    iniciadoEm: new Date().toISOString(),
    finalizadoEm: null,
    sucesso: null,
    codigoSaida: null,
    ultimaLinha: '',
    linhas: [],
    erro: null,
  };
  memoriaSync.resto = '';

  const filho = spawn(process.execPath, [CAMINHO_SCRIPT], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
  });

  memoriaSync.processo = filho;

  filho.stdout?.on('data', (dados) => acumularSaida(memoriaSync, String(dados)));
  filho.stderr?.on('data', (dados) => acumularSaida(memoriaSync, String(dados)));
  filho.on('error', (falha) =>
    finalizar(memoriaSync, null, `Falha ao iniciar o script: ${falha.message}`)
  );
  filho.on('close', (codigo) => finalizar(memoriaSync, codigo));

  // Avisa todos os clientes conectados. Sem este aviso, so quem clicou no botao
  // veria "Sincronizando"; as outras abas continuariam mostrando "Sincronizar"
  // ate o proximo tique do polling (Tarefa 99).
  publicarAtualizacao('sincronizacao-iniciada');

  return { codigo: 'iniciado', estado: memoriaSync.estado };
}

export type ResultadoParada =
  | { codigo: 'parando'; estado: EstadoSincronizacao }
  | { codigo: 'nada-em-andamento'; estado: EstadoSincronizacao };

/**
 * Pede a PARADA da sincronizacao em andamento (botao "Parar sincronizacao").
 *
 * Manda SIGTERM no processo filho. O script (scripts/sincronizar-glpi.js) trata
 * esse sinal: encerra o chamado que estiver processando, grava o marcador de
 * progresso e sai com codigo 143. Nao e um `kill` cego — e por isso que parar
 * no meio da varredura de 113 mil chamados nao perde trabalho: a proxima
 * execucao continua de onde parou.
 *
 * Devolve 'parando' (o script ainda esta encerrando) ou 'nada-em-andamento'.
 */
export function pararSincronizacao(): ResultadoParada {
  const memoriaSync = obterMemoria();

  if (!memoriaSync.estado.executando || !memoriaSync.processo) {
    return { codigo: 'nada-em-andamento', estado: memoriaSync.estado };
  }

  memoriaSync.estado.parando = true;
  // NAO se mexe em `ultimaLinha` aqui. Fabricar uma linha de log fazia a frase
  // "Parada solicitada — encerrando o chamado atual..." ficar na tela para
  // sempre, mesmo depois de a sincronizacao terminar, porque nada a limpava.
  // A frase verdadeira vem do proprio script, poucos segundos depois, e fica
  // sozinha no lugar certo do log.

  try {
    memoriaSync.processo.kill('SIGTERM');
  } catch (erro) {
    memoriaSync.estado.parando = false;
    memoriaSync.estado.erro = `Não foi possível parar a sincronização: ${(erro as Error).message}`;
  }

  // As outras abas precisam mostrar "Parando..." na hora, e nao no proximo tique
  // do polling (que em repouso e de 15 s) — Tarefa 99.
  publicarAtualizacao('sincronizacao-parando');

  return { codigo: 'parando', estado: memoriaSync.estado };
}
