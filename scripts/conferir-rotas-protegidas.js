/**
 * Verifica se TODA rota de API exige sessão e se TODA página que lê o banco
 * confere a sessão antes de ler (Tarefas 76 e 77).
 *
 * Por que existe: a trava introduzida na Tarefa 74 é uma **convenção**, não um
 * mecanismo. Onze rotas nasceram abertas simplesmente porque ninguém escreveu a
 * linha — e nada no projeto reclamou. Na Tarefa 77 o mesmo valeu para as
 * páginas: `app/agenda/page.tsx` e `app/tecnicos/page.tsx` montavam o HTML no
 * servidor e entregavam os dados a quem não tinha sessão.
 *
 * Este script transforma o esquecimento em **erro de build**: o `prebuild` do
 * `package.json` chama ele antes do `next build`, então uma rota aberta ou uma
 * página sem a conferência impede a compilação de passar.
 *
 * Sem dependência: só módulos nativos do Node, para rodar também no release
 * (onde o `node_modules` chega por junction e não se instala nada).
 *
 * Uso: `node scripts/conferir-rotas-protegidas.js`
 * Sai com 0 se tudo estiver protegido, 1 se houver rota aberta ou página sem a
 * conferência de sessão.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Rotas públicas por natureza, com o motivo — adicionar aqui exige justificativa.
 * Só o login entra e sai: sem isso ninguém conseguiria entrar no sistema.
 */
const ROTAS_PUBLICAS = {
  'app/api/login/route.ts': 'entrar, conferir a sessao e sair precisa ser publico',
};

/** Qualquer uma destas chamadas na linha do handler conta como trava. */
const CHAMADAS_DE_TRAVA = ['bloquearSemSessao(', 'lerSessao(', 'exigirSessao('];

/**
 * Módulos que alcançam o banco (Tarefa 77). Uma página que importe qualquer um
 * deles monta dados no servidor, então precisa de `temSessaoNoServidor()` antes.
 */
const REPOSITORIOS_DE_DADOS = [
  '@/lib/db',
  '@/lib/eventos',
  '@/lib/sugestoes',
  '@/lib/tecnicos',
];

/** Função que a página precisa chamar para poder ler o banco. */
const CONFERENCIA_DE_PAGINA = 'temSessaoNoServidor(';

/** Métodos HTTP que o App Router trata como handler. */
const METODOS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

/** Encontra arquivos com certo nome dentro de uma pasta, em qualquer profundidade. */
function acharArquivos(diretorio, nome) {
  const encontrados = [];

  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const completa = path.join(diretorio, entrada.name);

    if (entrada.isDirectory()) {
      encontrados.push(...acharArquivos(completa, nome));
    } else if (entrada.name === nome) {
      encontrados.push(completa);
    }
  }

  return encontrados;
}

/** Encontra os arquivos `route.*` dentro de `app/api`. */
function acharRotas(diretorio) {
  const encontradas = [];

  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const completa = path.join(diretorio, entrada.name);

    if (entrada.isDirectory()) {
      encontradas.push(...acharRotas(completa));
    } else if (entrada.name.startsWith('route.')) {
      encontradas.push(completa);
    }
  }

  return encontradas;
}

/**
 * Confere as páginas que leem o banco (Tarefa 77).
 * Devolve a lista de `arquivo` que usam um repositório de dados sem conferir a sessão.
 */
function conferirPaginas(raizApp) {
  const semConferencia = [];

  for (const arquivo of acharArquivos(raizApp, 'page.tsx')) {
    const fonte = fs.readFileSync(arquivo, 'utf8');
    const usaBanco = REPOSITORIOS_DE_DADOS.some((modulo) => fonte.includes(`'${modulo}'`));

    if (usaBanco && !fonte.includes(CONFERENCIA_DE_PAGINA)) {
      semConferencia.push(path.relative(process.cwd(), arquivo).split(path.sep).join('/'));
    }
  }

  return semConferencia;
}

/**
 * Devolve os handlers exportados de um arquivo: `export async function GET(...)`
 * e `export const GET = ...`. Cada item traz método e linha.
 */
function acharHandlers(fonte, arquivo) {
  const handlers = [];
  const padrao = new RegExp(
    `export\\s+(?:async\\s+)?(?:function\\s+(${METODOS})\\b|const\\s+(${METODOS})\\s*=)`,
    'g'
  );

  let achado;
  while ((achado = padrao.exec(fonte)) !== null) {
    const metodo = achado[1] ?? achado[2];
    handlers.push({ metodo, indice: achado.index, linha: fonte.slice(0, achado.index).split('\n').length });
    // Guarda o arquivo, já que a linha é calculada aqui.
    handlers[handlers.length - 1].arquivo = arquivo;
  }

  return handlers;
}

function main() {
  const raizApp = path.join(process.cwd(), 'app');
  const raizApi = path.join(raizApp, 'api');

  // Só a ausência da pasta `app` desliga a verificação. Se for só `app/api` que não
  // existe, a conferência das páginas (Tarefa 77) continua rodando — a versão
  // anterior saía cedo nesse caso e pulava justamente a conferência nova.
  if (!fs.existsSync(raizApp)) {
    console.log('[rotas] app nao encontrado neste diretorio — verificacao ignorada.');
    return 0;
  }

  const arquivos = fs.existsSync(raizApi) ? acharRotas(raizApi) : [];
  const abertas = [];
  let total = 0;

  for (const arquivo of arquivos) {
    const relativa = path.relative(process.cwd(), arquivo).split(path.sep).join('/');
    const fonte = fs.readFileSync(arquivo, 'utf8');
    const handlers = acharHandlers(fonte, relativa);

    if (handlers.length === 0) {
      console.warn(`[rotas] ${relativa} nao exporta nenhum handler — arquivo ignorado.`);
      continue;
    }

    // Cada handler e julgado pelo trecho do codigo que vai do seu nome ate o proximo
    // handler (ou o fim do arquivo): assim a trava de um handler nao "empresta" o
    // resultado para o outro.
    for (let i = 0; i < handlers.length; i += 1) {
      const inicio = handlers[i].indice;
      const fim = i + 1 < handlers.length ? handlers[i + 1].indice : fonte.length;
      const trecho = fonte.slice(inicio, fim);
      total += 1;

      if (CHAMADAS_DE_TRAVA.some((chamada) => trecho.includes(chamada))) {
        continue;
      }

      if (ROTAS_PUBLICAS[relativa]) {
        console.log(`[rotas] ${relativa} ${handlers[i].metodo} — publico (${ROTAS_PUBLICAS[relativa]})`);
        continue;
      }

      abertas.push(`${relativa}:${handlers[i].linha} (${handlers[i].metodo})`);
    }
  }

  if (abertas.length > 0) {
    console.error('');
    console.error('[rotas] FALHA: estas rotas de API nao exigem sessao:');
    for (const item of abertas) {
      console.error(`  - ${item}`);
    }
    console.error('');
    console.error('  Toda rota precisa da trava antes de ler corpo, parametro ou banco:');
    console.error('    const semSessao = bloquearSemSessao(request);');
    console.error('    if (semSessao) return semSessao;');
    console.error('  Se a rota for publica de verdade, acrescente o caminho e o motivo em');
    console.error('  ROTAS_PUBLICAS, no inicio de scripts/conferir-rotas-protegidas.js.');
    return 1;
  }

  // Tarefa 77: paginas que leem o banco precisam conferir a sessao antes de ler.
  const paginasSemConferencia = conferirPaginas(raizApp);

  if (paginasSemConferencia.length > 0) {
    console.error('');
    console.error('[rotas] FALHA: estas paginas leem o banco sem conferir a sessao:');
    for (const item of paginasSemConferencia) {
      console.error(`  - ${item}`);
    }
    console.error('');
    console.error('  A pagina monta o HTML no servidor: sem a conferencia, quem nao entrou');
    console.error('  recebe os dados no codigo-fonte. Use assim, antes de ler o banco:');
    console.error('    if (!(await temSessaoNoServidor())) {');
    console.error('      return null;');
    console.error('    }');
    return 1;
  }

  console.log(`[rotas] OK: ${total} handler(s) conferido(s) em ${arquivos.length} arquivo(s).`);
  return 0;
}

try {
  process.exit(main());
} catch (erro) {
  // Falha interna tambem derruba o build: um verificador que engole o proprio
  // erro daria uma falsa sensacao de seguranca.
  console.error('[rotas] ERRO INTERNO do verificador:', erro);
  process.exit(1);
}
