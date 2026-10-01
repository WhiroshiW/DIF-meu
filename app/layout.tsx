import type { Metadata } from 'next';
import { Suspense } from 'react';
import Sidebar from '@/components/Sidebar';
import BotaoSugestoes from '@/components/BotaoSugestoes';
import PortaoSessao from '@/components/PortaoSessao';
import './globals.css';

export const metadata: Metadata = {
  title: 'DINF — Gestão de Técnicos',
  description: 'Cadastro e gestão de técnicos por categoria.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        {/* Portão de sessão (Tarefa 66): sem login, o sistema inteiro NÃO é montado —
            nem menu, nem telas, nem o botão de sugestões. Só a tela de login. */}
        <PortaoSessao>
          <div className="app">
            {/* Tarefa 106: o menu marca em qual aba do GLPI estamos, lendo `?aba=`
                da URL — por isso precisa da fronteira de Suspense. */}
            <Suspense fallback={null}>
              <Sidebar />
            </Suspense>
            <main className="conteudo">{children}</main>
          </div>
          <BotaoSugestoes />
        </PortaoSessao>
      </body>
    </html>
  );
}