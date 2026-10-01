import { getBanco } from './db';
import type { Sugestao } from './types';

/** Linha como armazenada no SQLite (snake_case). */
type LinhaSugestao = {
  id: number;
  texto: string;
  criado_em: string;
};

const SELECT_BASE = `
  SELECT id, texto, criado_em
  FROM sugestoes
`;

/** Converte a linha do banco no tipo de domínio. */
function converterLinha(linha: LinhaSugestao): Sugestao {
  return {
    id: linha.id,
    texto: linha.texto,
    criadoEm: linha.criado_em,
  };
}

/** Lista todas as sugestões; as mais novas vêm primeiro (id DESC). */
export function listarSugestoes(): Sugestao[] {
  return getBanco()
    .prepare<[], LinhaSugestao>(`${SELECT_BASE} ORDER BY id DESC`)
    .all()
    .map(converterLinha);
}

/** Busca uma sugestão pelo id (null quando não existe). */
export function buscarSugestao(id: number): Sugestao | null {
  const linha = getBanco()
    .prepare<[number], LinhaSugestao>(`${SELECT_BASE} WHERE id = ?`)
    .get(id);

  return linha ? converterLinha(linha) : null;
}

/** Cadastra uma nova sugestão (o texto já deve vir validado/aparado). */
export function criarSugestao(texto: string): Sugestao {
  const resultado = getBanco()
    .prepare(`INSERT INTO sugestoes (texto) VALUES (?)`)
    .run(texto);

  const criado = buscarSugestao(Number(resultado.lastInsertRowid));
  if (!criado) {
    throw new Error('Falha ao recuperar a sugestão recém-cadastrada.');
  }

  return criado;
}

/** Remove uma sugestão (true quando algum registro foi apagado). */
export function excluirSugestao(id: number): boolean {
  const resultado = getBanco().prepare(`DELETE FROM sugestoes WHERE id = ?`).run(id);
  return resultado.changes > 0;
}