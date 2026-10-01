/**
 * Abas do GLPI (Tarefa 106).
 *
 * A escolha vai na URL (`/glpi?aba=chamados`) e não em estado local do painel:
 * com estado local, o submenu do menu lateral não teria como saber o que está
 * aberto, e recarregar a página voltaria sempre para o Dashboard. Na URL, os dois
 * lados leem o mesmo lugar e o link dá para compartilhar.
 */
export type Aba = 'dashboard' | 'chamados' | 'faq';

/** Aba usada quando a URL não traz `aba` (ou traz um valor desconhecido). */
export const ABA_PADRAO: Aba = 'dashboard';

export const ABAS: { id: Aba; rotulo: string; icone: string }[] = [
  { id: 'dashboard', rotulo: 'Dashboard', icone: '📊' },
  { id: 'chamados', rotulo: 'Chamados', icone: '🎫' },
  { id: 'faq', rotulo: 'FAQ', icone: '❓' },
];

/** Converte o valor vindo da URL numa aba válida; fora da lista, cai no padrão. */
export function abaDaUrl(valor: string | null): Aba {
  return ABAS.some((aba) => aba.id === valor) ? (valor as Aba) : ABA_PADRAO;
}