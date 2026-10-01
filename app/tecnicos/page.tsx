import TecnicosView from '@/components/TecnicosView';
import { listarTecnicos } from '@/lib/tecnicos';
import { temSessaoNoServidor } from '@/lib/sessao';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'DINF — Técnicos',
};

/** Categoria "Técnicos": lista os cadastrados e permite adicionar/desativar. */
export default async function PaginaTecnicos() {
  // Tarefa 77: a lista de todos os técnicos é montada no servidor; sem esta
  // conferência ela seria entregue a quem não entrou.
  if (!(await temSessaoNoServidor())) {
    return null;
  }

  const tecnicos = listarTecnicos();

  return <TecnicosView tecnicosIniciais={tecnicos} />;
}