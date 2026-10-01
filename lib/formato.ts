/** Helpers de formatação usados na interface (cliente e servidor). */

/** Converte AAAA-MM-DD em DD/MM/AAAA. */
export function formatarDataBr(dataIso: string): string {
  const [ano, mes, dia] = dataIso.split('-');
  if (!ano || !mes || !dia) return dataIso;
  return `${dia}/${mes}/${ano}`;
}

/** Idade completa em anos a partir de AAAA-MM-DD (null quando a data é inválida). */
export function calcularIdade(dataIso: string): number | null {
  const [ano, mes, dia] = dataIso.split('-').map(Number);
  if (!ano || !mes || !dia) return null;

  const hoje = new Date();
  let idade = hoje.getFullYear() - ano;
  const mesAtual = hoje.getMonth() + 1;
  const diaAtual = hoje.getDate();

  if (mesAtual < mes || (mesAtual === mes && diaAtual < dia)) {
    idade -= 1;
  }

  return idade >= 0 ? idade : null;
}

/** 'Técnico ativo' / 'Técnico desativado' — usado nas etiquetas de status. */
export function rotuloStatus(ativo: boolean): string {
  return ativo ? 'Ativo' : 'Desativado';
}

/** 'A'..'Z' usado nos avatares com iniciais do técnico. */
export function iniciais(nomeCompleto: string): string {
  const partes = nomeCompleto.trim().split(/\s+/);
  const primeira = partes[0]?.[0] ?? '';
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] : '';
  return (primeira + ultima).toUpperCase();
}