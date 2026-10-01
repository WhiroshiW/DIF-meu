'use client';

import { Suspense } from 'react';
import GlpiTabs from '@/components/GlpiTabs';

export default function PaginaGlpi() {
  // O painel lê `?aba=` da URL para saber qual aba mostrar (Tarefa 106), por isso
  // precisa da fronteira de Suspense.
  return (
    <Suspense fallback={null}>
      <GlpiTabs />
    </Suspense>
  );
}