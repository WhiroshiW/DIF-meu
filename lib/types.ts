/** Tipos de domínio compartilhados entre servidor (API) e cliente (componentes). */

/** Categorias disponíveis no menu lateral. Novas categorias entram aqui. */
export type CategoriaMenu = 'Agenda' | 'Glpi' | 'Tecnicos';

/** Técnico como é devolvido pela API / usado na interface. */
export type Tecnico = {
  id: number;
  nomeCompleto: string;
  funcao: string;
  /** Data no formato ISO AAAA-MM-DD (usada pelo <input type="date">). */
  dataNascimento: string;
  ativo: boolean;
  /** Timestamp ISO de criação do registro. */
  criadoEm: string;
};

/** Dados aceitos no cadastro de um técnico. */
export type NovoTecnico = {
  nomeCompleto: string;
  funcao: string;
  dataNascimento: string;
};

/**
 * Perfil do técnico logado, como devolvido por `GET /api/tecnicos/:id` (Tarefa 61).
 * Traz também `telefone`, `email` e `usuario` (CPF do técnico ou `admin`).
 * Nunca inclui o hash da coluna `senha`.
 */
export type PerfilTecnico = {
  id: number;
  nomeCompleto: string;
  funcao: string;
  dataNascimento: string;
  telefone: string | null;
  email: string | null;
  usuario: string | null;
};

/**
 * Campos gravados por `PATCH /api/tecnicos/:id` a partir do modal de perfil (Tarefa 61).
 * `senha` é opcional e só chega preenchida quando o técnico pediu a redefinição —
 * quando ausente, a senha no banco permanece intacta.
 */
export type DadosPerfilTecnico = {
  nomeCompleto: string;
  funcao: string;
  dataNascimento: string;
  telefone: string | null;
  email: string | null;
  senha?: string;
};

/** Resposta padrão da API de técnicos. */
export type RespostaTecnicos = {
  tecnicos: Tecnico[];
};

/** Evento da agenda conforme devolvido pela API / usado na interface. */
export type Evento = {
  id: number;
  titulo: string;
  descricao: string;
  /** Data no formato ISO AAAA-MM-DD (usada pelo <input type="date">). */
  data: string;
  /** Horário HH:MM, ou null quando o evento é de dia inteiro. */
  hora: string | null;
  /** Timestamp ISO de criação do registro. */
  criadoEm: string;
};

/** Dados aceitos no cadastro de um evento da agenda. */
export type NovoEvento = {
  titulo: string;
  descricao: string;
  data: string;
  hora: string | null;
};

/** Resposta padrão da API de eventos. */
export type RespostaEventos = {
  eventos: Evento[];
};

/** Sugestão do balão "Sugestões" conforme devolvida pela API / usada na interface. */
export type Sugestao = {
  id: number;
  texto: string;
  /** Timestamp ISO de criação do registro. */
  criadoEm: string;
};

/** Dados aceitos no cadastro de uma sugestão. */
export type NovaSugestao = {
  texto: string;
};

/** Resposta padrão da API de sugestões. */
export type RespostaSugestoes = {
  sugestoes: Sugestao[];
};