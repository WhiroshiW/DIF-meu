import { getBanco } from './db';
import type { Evento, NovoEvento } from './types';

/** Linha como armazenada no SQLite (snake_case). */
type LinhaEvento = {
  id: number;
  titulo: string;
  descricao: string;
  data: string;
  hora: string | null;
  criado_em: string;
};

const SELECT_BASE = `
  SELECT id, titulo, descricao, data, hora, criado_em
  FROM eventos
`;

/** Eventos sem hora (dia inteiro) ficam no topo do dia; o resto vem por horário. */
const ORDEM = `data ASC, hora IS NULL ASC, hora ASC, titulo COLLATE NOCASE ASC`;

/** Converte a linha do banco no tipo de domínio. */
function converterLinha(linha: LinhaEvento): Evento {
  return {
    id: linha.id,
    titulo: linha.titulo,
    descricao: linha.descricao,
    data: linha.data,
    hora: linha.hora,
    criadoEm: linha.criado_em,
  };
}

/** Lista todos os eventos da agenda em ordem cronológica. */
export function listarEventos(): Evento[] {
  return getBanco()
    .prepare<[], LinhaEvento>(`${SELECT_BASE} ORDER BY ${ORDEM}`)
    .all()
    .map(converterLinha);
}

/** Lista os eventos de um mês (ano com 4 dígitos e mês de 1 a 12), em ordem cronológica. */
export function listarEventosDoMes(ano: number, mes: number): Evento[] {
  const periodo = `${ano}-${String(mes).padStart(2, '0')}`;

  return getBanco()
    .prepare<[string], LinhaEvento>(`${SELECT_BASE} WHERE substr(data, 1, 7) = ? ORDER BY ${ORDEM}`)
    .all(periodo)
    .map(converterLinha);
}

/** Busca um evento pelo id (null quando não existe). */
export function buscarEvento(id: number): Evento | null {
  const linha = getBanco()
    .prepare<[number], LinhaEvento>(`${SELECT_BASE} WHERE id = ?`)
    .get(id);

  return linha ? converterLinha(linha) : null;
}

/** Agenda um novo evento. */
export function criarEvento(dados: NovoEvento): Evento {
  const resultado = getBanco()
    .prepare(
      `INSERT INTO eventos (titulo, descricao, data, hora)
       VALUES (?, ?, ?, ?)`
    )
    .run(dados.titulo, dados.descricao, dados.data, dados.hora);

  const criado = buscarEvento(Number(resultado.lastInsertRowid));
  if (!criado) {
    throw new Error('Falha ao recuperar o evento recém-cadastrado.');
  }

  return criado;
}

/** Remove um evento da agenda (true quando algum registro foi apagado). */
export function excluirEvento(id: number): boolean {
  const resultado = getBanco().prepare(`DELETE FROM eventos WHERE id = ?`).run(id);
  return resultado.changes > 0;
}
