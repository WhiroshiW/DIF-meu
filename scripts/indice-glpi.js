#!/usr/bin/env node
/**
 * Comando manual do índice de busca (Tarefa 85).
 *
 *   node scripts/indice-glpi.js            -> cria o índice ou atualiza o que mudou
 *   node scripts/indice-glpi.js --forcar   -> refaz o índice inteiro do zero
 *
 * O mesmo trabalho acontece sozinho ao fim de cada sincronização
 * (`scripts/sincronizar-glpi.js`, ETAPA 6); este comando existe para quando se
 * quiser forçar a reconstrução sem sincronizar.
 */
'use strict';

const { garantirIndice, reconstruir, estadoIndice, caminhoIndice } = require('../lib/indiceGlpi');

const forcar = process.argv.includes('--forcar');
const antes = estadoIndice();

console.log('===========================================================');
console.log('Indice de busca do GLPI');
console.log('===========================================================');
console.log(`Arquivo: ${caminhoIndice()}`);
console.log(
  `Situacao: ${!antes.existe ? 'nao existe' : antes.pronto ? `pronto (${antes.chamados} chamados, criado em ${antes.reconstruidoEm})` : 'incompleto ou de outra versao'}\n`
);

const resultado = forcar
  ? { acao: 'reconstruido', detalhe: reconstruir({ aoProgredir: (m) => console.log(m) }) }
  : garantirIndice({ aoProgredir: (m) => console.log(m) });

console.log('');
if (resultado.acao === 'falhou') {
  console.log(resultado.erro);
  process.exitCode = 1;
} else {
  const depois = estadoIndice();
  console.log(`Pronto: ${depois.pronto ? 'sim' : 'nao'} | ${depois.chamados} chamados indexados.`);
}
