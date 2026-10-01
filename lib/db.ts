import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/** Diretório onde o arquivo SQLite do projeto é gravado. */
const DIRETORIO_DADOS = path.join(process.cwd(), 'data');

/** Caminho absoluto do banco: data/dinf.db */
export const CAMINHO_BANCO = path.join(DIRETORIO_DADOS, 'dinf.db');

/** Esquema da tabela de técnicos (criado de forma idempotente na primeira conexão). */
const SQL_ESQUEMA = `
  CREATE TABLE IF NOT EXISTS tecnicos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome_completo TEXT NOT NULL,
    funcao TEXT NOT NULL,
    data_nascimento TEXT NOT NULL,
    telefone TEXT,
    email TEXT,
    senha TEXT,
    usuario TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tecnicos_ativo ON tecnicos (ativo);

  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    descricao TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    hora TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_eventos_data ON eventos (data);

  CREATE TABLE IF NOT EXISTS sugestoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    texto TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/**
 * Colunas acrescentadas à tabela `tecnicos` depois da criação original (Tarefas 51 e 52).
 * Nascem nulas: nada é populado automaticamente e nenhuma funcionalidade as consome
 * ainda. `senha` é TEXT porque receberá o hash (nunca a senha em texto puro);
 * `usuario` receberá o CPF (somente números) — o registro admin usa `admin`.
 */
const COLUNAS_TECNICOS_ADICIONAIS = ['telefone', 'email', 'senha', 'usuario'] as const;

/**
 * Garante as colunas adicionais de `tecnicos` em bancos já existentes.
 * `CREATE TABLE IF NOT EXISTS` não altera tabela existente, então a base real
 * (`data/dinf.db`, criada antes destas colunas) só as recebe via `ALTER TABLE`.
 * A operação é aditiva e idempotente: o `ALTER TABLE ADD COLUMN` só roda quando
 * `PRAGMA table_info` não encontra a coluna.
 */
function garantirColunasTecnicos(banco: Database.Database): void {
  const existentes = new Set(
    banco
      .prepare<[], { name: string }>('PRAGMA table_info(tecnicos)')
      .all()
      .map((coluna) => coluna.name)
  );

  for (const nome of COLUNAS_TECNICOS_ADICIONAIS) {
    if (!existentes.has(nome)) {
      banco.exec(`ALTER TABLE tecnicos ADD COLUMN ${nome} TEXT`);
    }
  }
}

/**
 * Cache de conexão reaproveitado entre requisições e recarregamentos (HMR) do Next.
 * `__dinfEncerramentoRegistrado` garante que o hook de saída seja registrado uma só vez.
 */
const cacheGlobal = globalThis as unknown as {
  __dinfBanco?: Database.Database;
  __dinfEncerramentoRegistrado?: boolean;
};

/**
 * Consolida o WAL no arquivo `data/dinf.db` quando o processo encerra (CTRL+C ou fim
 * do servidor). Sem isso, escritas recentes ficam apenas no arquivo `-wal`, que é
 * recuperado automaticamente na próxima abertura — mas o banco só fica autocontido
 * (seguro para copiar/backup) após o checkpoint.
 */
function registrarEncerramentoLimpo(banco: Database.Database): void {
  if (cacheGlobal.__dinfEncerramentoRegistrado) {
    return;
  }
  cacheGlobal.__dinfEncerramentoRegistrado = true;

  process.once('exit', () => {
    try {
      banco.pragma('wal_checkpoint(TRUNCATE)');
      banco.close();
    } catch (erro) {
      console.error('[dinf] Falha ao encerrar o banco SQLite:', erro);
    }
  });
}

/**
 * Retorna a conexão única com o SQLite, garantindo diretório, arquivo e esquema.
 * Deve ser chamada apenas em código de servidor (Server Components, Route Handlers).
 */
export function getBanco(): Database.Database {
  if (cacheGlobal.__dinfBanco) {
    // Reaplica o esquema na conexão em cache: o HMR do dev (e upgrades do
    // schema em servidor já rodando) mantêm a conexão viva, então tabelas novas
    // só passam a existir se o CREATE TABLE IF NOT EXISTS rodar de novo.
    cacheGlobal.__dinfBanco.exec(SQL_ESQUEMA);
    garantirColunasTecnicos(cacheGlobal.__dinfBanco);
    return cacheGlobal.__dinfBanco;
  }

  fs.mkdirSync(DIRETORIO_DADOS, { recursive: true });

  const banco = new Database(CAMINHO_BANCO);
  banco.pragma('journal_mode = WAL');
  banco.pragma('foreign_keys = ON');
  banco.exec(SQL_ESQUEMA);
  garantirColunasTecnicos(banco);

  cacheGlobal.__dinfBanco = banco;
  registrarEncerramentoLimpo(banco);
  return banco;
}