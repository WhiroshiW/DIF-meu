import type { NovoEvento, NovaSugestao, NovoTecnico } from './types';

/** Mapa campo -> mensagem de erro. */
export type ErrosValidacao = Record<string, string>;

export type ResultadoValidacao =
  | { valido: true; dados: NovoTecnico }
  | { valido: false; erros: ErrosValidacao };

export type ResultadoValidacaoEvento =
  | { valido: true; dados: NovoEvento }
  | { valido: false; erros: ErrosValidacao };

export type ResultadoValidacaoSugestao =
  | { valido: true; dados: NovaSugestao }
  | { valido: false; erros: ErrosValidacao };

const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;
const FORMATO_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const TAMANHO_MAXIMO_NOME = 120;
const TAMANHO_MAXIMO_FUNCAO = 80;
const ANO_MINIMO_NASCIMENTO = 1900;
const TAMANHO_MAXIMO_TITULO_EVENTO = 120;
const TAMANHO_MAXIMO_DESCRICAO_EVENTO = 500;
const TAMANHO_MAXIMO_SUGESTAO = 2000;

/** Verifica se a string AAAA-MM-DD representa uma data real (ex.: rejeita 2024-02-31). */
export function dataIsoValida(valor: string): boolean {
  if (!FORMATO_DATA.test(valor)) return false;

  const [ano, mes, dia] = valor.split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia));

  return (
    data.getUTCFullYear() === ano &&
    data.getUTCMonth() === mes - 1 &&
    data.getUTCDate() === dia
  );
}

/**
 * Data de hoje em AAAA-MM-DD, no fuso local de quem executa.
 * O calendário da agenda e o bloqueio de datas passadas trabalham com a mesma
 * referência, então "hoje" precisa ser o dia do usuário (e não o dia em UTC).
 */
export function hojeIso(): string {
  const agora = new Date();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');

  return `${agora.getFullYear()}-${mes}-${dia}`;
}

/**
 * Valida os dados de cadastro/edição de técnico.
 * Usada tanto no formulário (cliente) quanto na API (servidor) para manter o mesmo contrato.
 */
export function validarTecnico(entrada: unknown): ResultadoValidacao {
  const erros: ErrosValidacao = {};
  const objeto = (typeof entrada === 'object' && entrada !== null ? entrada : {}) as Record<string, unknown>;

  const nomeCompleto = typeof objeto.nomeCompleto === 'string' ? objeto.nomeCompleto.trim().replace(/\s+/g, ' ') : '';
  const funcao = typeof objeto.funcao === 'string' ? objeto.funcao.trim().replace(/\s+/g, ' ') : '';
  const dataNascimento = typeof objeto.dataNascimento === 'string' ? objeto.dataNascimento.trim() : '';

  if (!nomeCompleto) {
    erros.nomeCompleto = 'Informe o nome completo.';
  } else if (nomeCompleto.split(' ').length < 2) {
    erros.nomeCompleto = 'Informe nome e sobrenome.';
  } else if (nomeCompleto.length > TAMANHO_MAXIMO_NOME) {
    erros.nomeCompleto = `Máximo de ${TAMANHO_MAXIMO_NOME} caracteres.`;
  }

  if (!funcao) {
    erros.funcao = 'Informe a função.';
  } else if (funcao.length > TAMANHO_MAXIMO_FUNCAO) {
    erros.funcao = `Máximo de ${TAMANHO_MAXIMO_FUNCAO} caracteres.`;
  }

  if (!dataNascimento) {
    erros.dataNascimento = 'Informe a data de nascimento.';
  } else if (!dataIsoValida(dataNascimento)) {
    erros.dataNascimento = 'Informe uma data válida (AAAA-MM-DD).';
  } else if (dataNascimento > hojeIso()) {
    erros.dataNascimento = 'A data de nascimento não pode ser futura.';
  } else if (Number(dataNascimento.slice(0, 4)) < ANO_MINIMO_NASCIMENTO) {
    erros.dataNascimento = `Ano de nascimento deve ser igual ou posterior a ${ANO_MINIMO_NASCIMENTO}.`;
  }

  if (Object.keys(erros).length > 0) {
    return { valido: false, erros };
  }

  return { valido: true, dados: { nomeCompleto, funcao, dataNascimento } };
}

/**
 * Valida os dados de um evento da agenda.
 * Usada pelo formulário (cliente) e pela API (servidor): eventos nunca são agendados em datas passadas.
 */
export function validarEvento(entrada: unknown): ResultadoValidacaoEvento {
  const erros: ErrosValidacao = {};
  const objeto = (typeof entrada === 'object' && entrada !== null ? entrada : {}) as Record<string, unknown>;

  const titulo = typeof objeto.titulo === 'string' ? objeto.titulo.trim().replace(/\s+/g, ' ') : '';
  const descricao = typeof objeto.descricao === 'string' ? objeto.descricao.trim() : '';
  const data = typeof objeto.data === 'string' ? objeto.data.trim() : '';
  const hora = typeof objeto.hora === 'string' ? objeto.hora.trim() : '';

  if (!titulo) {
    erros.titulo = 'Informe o título do evento.';
  } else if (titulo.length > TAMANHO_MAXIMO_TITULO_EVENTO) {
    erros.titulo = `Máximo de ${TAMANHO_MAXIMO_TITULO_EVENTO} caracteres.`;
  }

  if (descricao.length > TAMANHO_MAXIMO_DESCRICAO_EVENTO) {
    erros.descricao = `Máximo de ${TAMANHO_MAXIMO_DESCRICAO_EVENTO} caracteres.`;
  }

  if (!data) {
    erros.data = 'Informe a data do evento.';
  } else if (!dataIsoValida(data)) {
    erros.data = 'Informe uma data válida (AAAA-MM-DD).';
  } else if (data < hojeIso()) {
    erros.data = 'Não é possível agendar eventos em datas passadas.';
  }

  if (hora && !FORMATO_HORA.test(hora)) {
    erros.hora = 'Informe o horário no formato HH:MM.';
  }

  if (Object.keys(erros).length > 0) {
    return { valido: false, erros };
  }

  return { valido: true, dados: { titulo, descricao, data, hora: hora || null } };
}

/**
 * Valida o texto de uma sugestão (balão "Sugestões").
 * Usada pelo modal (cliente) e pela API (servidor): só o texto é obrigatório
 * (as quebras de linha são preservadas — apenas as pontas são aparadas).
 */
export function validarSugestao(entrada: unknown): ResultadoValidacaoSugestao {
  const erros: ErrosValidacao = {};
  const objeto = (typeof entrada === 'object' && entrada !== null ? entrada : {}) as Record<string, unknown>;

  const texto = typeof objeto.texto === 'string' ? objeto.texto.trim() : '';

  if (!texto) {
    erros.texto = 'Escreva sua sugestão antes de salvar.';
  } else if (texto.length > TAMANHO_MAXIMO_SUGESTAO) {
    erros.texto = `Máximo de ${TAMANHO_MAXIMO_SUGESTAO} caracteres.`;
  }

  if (Object.keys(erros).length > 0) {
    return { valido: false, erros };
  }

  return { valido: true, dados: { texto } };
}