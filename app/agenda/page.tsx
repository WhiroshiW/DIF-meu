import AgendaView from '@/components/AgendaView';
import { chaveMes, mesCorrente } from '@/lib/calendario';
import { listarEventosDoMes } from '@/lib/eventos';
import { temSessaoNoServidor } from '@/lib/sessao';
import { listarTecnicos } from '@/lib/tecnicos';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'DINF — Agenda',
};

/** Categoria "Agenda": calendário do mês (com aniversários), eventos do dia e do mês. */
export default async function PaginaAgenda() {
  // Tarefa 77: esta página monta o HTML **no servidor**. Sem esta conferência, os
  // eventos do mês e os dados dos técnicos viajariam na resposta para quem não
  // entrou — a tela de login só cobre a janela depois que o HTML já saiu.
  if (!(await temSessaoNoServidor())) {
    return null;
  }

  const { ano, mes } = mesCorrente();
  // `mes` é 0-11; a API pede o mês em 1-12 (mesmo formato de `chaveMes`).
  const eventosIniciais = listarEventosDoMes(ano, Number(chaveMes({ ano, mes }).slice(5, 7)));
  const tecnicos = listarTecnicos();

  return <AgendaView eventosIniciais={eventosIniciais} tecnicos={tecnicos} />;
}