/**
 * Base de papéis e permissões do sistema (Tarefa 62).
 *
 * Hoje existe um único nível de acesso: o **admin** (registro com
 * `usuario = 'admin'`), que administra a equipe. Os demais usuários são
 * **técnicos**, que apenas consultam e editam o próprio perfil.
 *
 * As funções abaixo são o ponto único de decisão: telas e componentes
 * consultam `pode()` em vez de comparar nomes de usuário espalhados pelo
 * código. Para criar novos papéis (ex.: "gestor", "suporte externo") basta
 * acrescentar o papel e as ações em `PERMISSOES_POR_PAPEL`.
 */

/** Identificador do usuário administrador do sistema. */
export const USUARIO_ADMIN = 'admin';

/** Papéis reconhecidos pelo sistema. */
export type Papel = 'admin' | 'tecnico';

/** Ações que a interface pode bloquear conforme o papel do usuário. */
export type Acao =
  /** Cadastrar um novo técnico. */
  | 'tecnicos:adicionar'
  /** Alterar os dados cadastrais de um técnico da lista. */
  | 'tecnicos:editar'
  /** Desativar ou reativar um técnico da lista. */
  | 'tecnicos:alternarAtivo';

/** Ações liberadas por papel. O técnico não administra a equipe. */
const PERMISSOES_POR_PAPEL: Record<Papel, Acao[]> = {
  admin: ['tecnicos:adicionar', 'tecnicos:editar', 'tecnicos:alternarAtivo'],
  tecnico: [],
};

/** Descobre o papel de um usuário a partir do identificador de login. */
export function papelDoUsuario(usuario: string | null | undefined): Papel {
  return usuario && usuario.trim().toLowerCase() === USUARIO_ADMIN ? 'admin' : 'tecnico';
}

/** Verdadeiro apenas para o usuário administrador do sistema. */
export function ehAdministrador(usuario: string | null | undefined): boolean {
  return papelDoUsuario(usuario) === 'admin';
}

/** Diz se o usuário informado pode executar a ação. */
export function pode(usuario: string | null | undefined, acao: Acao): boolean {
  return PERMISSOES_POR_PAPEL[papelDoUsuario(usuario)].includes(acao);
}
