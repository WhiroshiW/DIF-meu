import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Tamanho do sal e da chave derivada (bytes) do hash de senha (Tarefa 56). */
const TAMANHO_SAL = 16;
const TAMANHO_CHAVE = 64;

/**
 * Gera o hash de uma senha no formato `base64(sal):base64(chave)`, com `scrypt`
 * do próprio Node (sem dependências novas). Nunca grave a senha em texto puro.
 */
export function gerarHashSenha(senha: string): string {
  const sal = randomBytes(TAMANHO_SAL);
  const chave = scryptSync(senha, sal, TAMANHO_CHAVE);

  return `${sal.toString('base64')}:${chave.toString('base64')}`;
}

/**
 * Confere a senha digitada contra o hash armazenado (`sal:chave`, ambos base64).
 * Usa comparação em tempo constante (`timingSafeEqual`) e trata qualquer hash
 * malformado como "não confere" (nunca lança).
 */
export function conferirSenha(senha: string, hash: string): boolean {
  try {
    const partes = hash.split(':');
    if (partes.length !== 2) {
      return false;
    }

    const sal = Buffer.from(partes[0], 'base64');
    const chaveEsperada = Buffer.from(partes[1], 'base64');

    if (sal.length !== TAMANHO_SAL || chaveEsperada.length !== TAMANHO_CHAVE) {
      return false;
    }

    const chaveDigitada = scryptSync(senha, sal, TAMANHO_CHAVE);

    return timingSafeEqual(chaveDigitada, chaveEsperada);
  } catch {
    return false;
  }
}
