import { getBanco } from './db';
import { gerarHashSenha } from './senha';
import type { DadosPerfilTecnico, NovoTecnico, PerfilTecnico, Tecnico } from './types';

/** Linha como armazenada no SQLite (snake_case). */
type LinhaTecnico = {
  id: number;
  nome_completo: string;
  funcao: string;
  data_nascimento: string;
  ativo: number;
  criado_em: string;
};

/** Linha do perfil: `tecnicos` + colunas de contato e login (Tarefa 61). */
type LinhaPerfilTecnico = {
  id: number;
  nome_completo: string;
  funcao: string;
  data_nascimento: string;
  telefone: string | null;
  email: string | null;
  usuario: string | null;
};

const SELECT_BASE = `
  SELECT id, nome_completo, funcao, data_nascimento, ativo, criado_em
  FROM tecnicos
`;

/**
 * O admin do sistema (`usuario = 'admin'`) não é técnico: ele administra a equipe,
 * por isso fica FORA das listagens da tela de Técnicos e dos aniversários
 * (Tarefa 62). O registro continua existindo normalmente no banco — e por isso
 * `buscarTecnico`, o login e o perfil continuam enxergando o admin normalmente.
 */
const CONDICAO_NAO_ADMIN = `
  usuario IS NULL OR LOWER(usuario) <> 'admin'
`;

/** Colunas do perfil — nunca inclui `senha`, para não expor o hash. */
const SELECT_PERFIL = `
  SELECT id, nome_completo, funcao, data_nascimento, telefone, email, usuario
  FROM tecnicos
`;

/** Converte a linha do banco no tipo de domínio. */
function converterLinha(linha: LinhaTecnico): Tecnico {
  return {
    id: linha.id,
    nomeCompleto: linha.nome_completo,
    funcao: linha.funcao,
    dataNascimento: linha.data_nascimento,
    ativo: linha.ativo === 1,
    criadoEm: linha.criado_em,
  };
}

/**
 * Lista todos os técnicos (ativos e desativados) em ordem alfabética.
 * O admin do sistema não entra na listagem — ver `CONDICAO_NAO_ADMIN` (Tarefa 62).
 */
export function listarTecnicos(): Tecnico[] {
  const linhas = getBanco()
    .prepare<[], LinhaTecnico>(
      `${SELECT_BASE} WHERE ${CONDICAO_NAO_ADMIN} ORDER BY nome_completo COLLATE NOCASE ASC`
    )
    .all();

  return linhas.map(converterLinha);
}

/** Busca um técnico pelo id (null quando não existe). */
export function buscarTecnico(id: number): Tecnico | null {
  const linha = getBanco()
    .prepare<[number], LinhaTecnico>(`${SELECT_BASE} WHERE id = ?`)
    .get(id);

  return linha ? converterLinha(linha) : null;
}

/** Insere um novo técnico já ativo. */
export function criarTecnico(dados: NovoTecnico): Tecnico {
  const resultado = getBanco()
    .prepare(
      `INSERT INTO tecnicos (nome_completo, funcao, data_nascimento, ativo)
       VALUES (?, ?, ?, 1)`
    )
    .run(dados.nomeCompleto, dados.funcao, dados.dataNascimento);

  const criado = buscarTecnico(Number(resultado.lastInsertRowid));
  if (!criado) {
    throw new Error('Falha ao recuperar o técnico recém-cadastrado.');
  }

  return criado;
}

/** Atualiza nome, função e data de nascimento (mantém o status ativo/inativo). */
export function atualizarTecnico(id: number, dados: NovoTecnico): Tecnico | null {
  const resultado = getBanco()
    .prepare(
      `UPDATE tecnicos
       SET nome_completo = ?, funcao = ?, data_nascimento = ?
       WHERE id = ?`
    )
    .run(dados.nomeCompleto, dados.funcao, dados.dataNascimento, id);

  return resultado.changes > 0 ? buscarTecnico(id) : null;
}

/** Ativa ou desativa um técnico (base do botão "Desativar"/"Reativar"). */
export function definirAtivoTecnico(id: number, ativo: boolean): Tecnico | null {
  const resultado = getBanco()
    .prepare(`UPDATE tecnicos SET ativo = ? WHERE id = ?`)
    .run(ativo ? 1 : 0, id);

  return resultado.changes > 0 ? buscarTecnico(id) : null;
}

/** Converte a linha do perfil no tipo de domínio. */
function converterLinhaPerfil(linha: LinhaPerfilTecnico): PerfilTecnico {
  return {
    id: linha.id,
    nomeCompleto: linha.nome_completo,
    funcao: linha.funcao,
    dataNascimento: linha.data_nascimento,
    telefone: linha.telefone,
    email: linha.email,
    usuario: linha.usuario,
  };
}

/**
 * Busca o perfil completo de um técnico (usado pelo modal de perfil, Tarefa 61).
 * A coluna `senha` não é lida: o hash nunca sai do servidor.
 */
export function buscarPerfilTecnico(id: number): PerfilTecnico | null {
  const linha = getBanco()
    .prepare<[number], LinhaPerfilTecnico>(`${SELECT_PERFIL} WHERE id = ?`)
    .get(id);

  return linha ? converterLinhaPerfil(linha) : null;
}

/**
 * Grava o perfil do técnico logado (Tarefa 61).
 * Quando `dados.senha` vem preenchida, o valor é gravado como hash `scrypt`
 * (nunca em texto puro); quando vem vazia/ausente, a senha no banco fica intacta.
 * Telefone e e-mail vazios viram `NULL`.
 */
export function atualizarPerfilTecnico(id: number, dados: DadosPerfilTecnico): PerfilTecnico | null {
  const telefone = dados.telefone?.trim() ? dados.telefone.trim() : null;
  const email = dados.email?.trim() ? dados.email.trim() : null;
  const senha = dados.senha?.trim();

  const resultado = getBanco()
    .prepare(
      `UPDATE tecnicos
       SET nome_completo = ?, funcao = ?, data_nascimento = ?, telefone = ?, email = ?
           ${senha ? ', senha = ?' : ''}
       WHERE id = ?`
    )
    .run(
      ...(senha
        ? [
            dados.nomeCompleto,
            dados.funcao,
            dados.dataNascimento,
            telefone,
            email,
            gerarHashSenha(senha),
            id,
          ]
        : [dados.nomeCompleto, dados.funcao, dados.dataNascimento, telefone, email, id])
    );

  return resultado.changes > 0 ? buscarPerfilTecnico(id) : null;
}