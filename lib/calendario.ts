import type { Tecnico } from './types';
import { hojeIso } from './validacao';

/** Nomes dos meses (índice 0 = janeiro), usados nos títulos da agenda. */
export const NOMES_MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/** Rótulos das colunas da grade semanal (a semana começa no domingo). */
export const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** Mês exibido na agenda: `mes` vai de 0 (janeiro) a 11 (dezembro). */
export type MesReferencia = {
  ano: number;
  mes: number;
};

/** Monta a data ISO (AAAA-MM-DD) a partir de ano, mês (0-11) e dia. */
export function montarDataIso(ano: number, mes: number, dia: number): string {
  return `${ano}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** Mês corrente segundo o relógio do usuário. */
export function mesCorrente(): MesReferencia {
  const agora = new Date();
  return { ano: agora.getFullYear(), mes: agora.getMonth() };
}

/** Período em 'AAAA-MM' — formato aceito pela API e usado como chave de comparação. */
export function chaveMes({ ano, mes }: MesReferencia): string {
  return `${ano}-${String(mes + 1).padStart(2, '0')}`;
}

/** Move o mês de referência em `passo` meses (valores negativos voltam no tempo). */
export function deslocarMes({ ano, mes }: MesReferencia, passo: number): MesReferencia {
  const total = ano * 12 + mes + passo;
  return { ano: Math.floor(total / 12), mes: ((total % 12) + 12) % 12 };
}

/** Título legível do mês: 'setembro de 2026'. */
export function descreverMes(referencia: MesReferencia): string {
  return `${NOMES_MESES[referencia.mes]} de ${referencia.ano}`;
}

/** Data ISO de hoje (usada para destacar o dia atual e bloquear datas passadas). */
export function dataDeHoje(): string {
  return hojeIso();
}

/** Mês (1-12) de uma data ISO ou o mês informado quando a data é inválida. */
export function mesDaDataIso(dataIso: string, padrao = 0): number {
  const mes = Number(dataIso.slice(5, 7));
  return Number.isInteger(mes) && mes >= 1 && mes <= 12 ? mes - 1 : padrao;
}

/** Dia (1-31) de uma data ISO ou null quando a data é inválida. */
export function diaDaDataIso(dataIso: string): number | null {
  const dia = Number(dataIso.slice(8, 10));
  return Number.isInteger(dia) && dia >= 1 && dia <= 31 ? dia : null;
}

/**
 * Grade do mês em semanas completas de domingo a sábado.
 * Cada posição traz a data ISO do dia ou `null` nas células vazias
 * (antes do dia 1 e depois do último dia do mês).
 */
export function montarGrade({ ano, mes }: MesReferencia): (string | null)[] {
  const diasNoMes = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const primeiroDiaSemana = new Date(Date.UTC(ano, mes, 1)).getUTCDay();
  const celulas: (string | null)[] = [];

  for (let vazio = 0; vazio < primeiroDiaSemana; vazio += 1) {
    celulas.push(null);
  }

  for (let dia = 1; dia <= diasNoMes; dia += 1) {
    celulas.push(montarDataIso(ano, mes, dia));
  }

  while (celulas.length % 7 !== 0) {
    celulas.push(null);
  }

  return celulas;
}

/**
 * Técnicos que fazem aniversário em cada dia do mês informado (1 a 12).
 * Considera ativos e desativados: o aniversário é uma data da pessoa, não do vínculo.
 */
export function aniversariantesPorDia(tecnicos: Tecnico[], mes: number): Map<number, Tecnico[]> {
  const porDia = new Map<number, Tecnico[]>();

  tecnicos.forEach((tecnico) => {
    if (mesDaDataIso(tecnico.dataNascimento, -1) !== mes) {
      return;
    }

    const dia = diaDaDataIso(tecnico.dataNascimento);
    if (dia === null) {
      return;
    }

    const doDia = porDia.get(dia) ?? [];
    doDia.push(tecnico);
    porDia.set(dia, doDia);
  });

  return porDia;
}
