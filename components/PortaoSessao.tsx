'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import LoginModal, {
  CHAVE_SESSAO_LOCAL,
  limparUsuarioSessao,
  obterUsuarioSessao,
  salvarUsuarioSessao,
  type UsuarioSessao,
} from '@/components/LoginModal';

/** Intervalo mínimo entre duas renovações de sessão (Tarefa 78). */
const INTERVALO_RENOVACAO_MS = 15 * 60 * 1000;

/** Interações que contam como "a pessoa está usando o sistema" (Tarefa 78). */
const EVENTOS_DE_ATIVIDADE = ['pointerdown', 'keydown', 'wheel', 'scroll'] as const;

/**
 * Portão de sessão (Tarefa 66).
 *
 * Antes, o login era só uma sobreposição: o sistema inteiro (menu, telas, listas do
 * banco e requisições em segundo plano) era montado e hidratado **atrás** dela, o que
 * deixava o login demorar e ainda mostrava a última tela aberta por baixo.
 *
 * Aqui a ordem se inverte: sem sessão, **não se renderiza nada do sistema** — apenas
 * o `<LoginModal />`. Só depois do login as telas entram, e o usuário sempre cai na
 * primeira tela (`/`).
 *
 * Limitação conhecida: o servidor do Next ainda gera o conteúdo de `children` (é o
 * App Router montando a página antes de o navegador receber o JavaScript). O que deixa
 * de existir é a montagem/hidratação de todas as telas no navegador enquanto o
 * usuário ainda nem entrou. Para barrar também no servidor seria preciso um
 * `middleware.ts` e uma tela de login em rota própria — mudança maior, não pedida aqui.
 */
export default function PortaoSessao({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  /** `null` = ainda não conferido; evita piscar o sistema antes de saber. */
  const [logado, setLogado] = useState<boolean | null>(null);

  useEffect(() => {
    setLogado(obterUsuarioSessao() !== null);

    // Entrou agora: garante a primeira tela, e não a última que estava aberta.
    function aoLogar() {
      setLogado(true);
      router.replace('/');
    }

    // Saiu: encerra a sessão de verdade e volta a mostrar só o login.
    //
    // A limpeza mora aqui, e não no `LoginModal`, por um motivo que só aparece depois
    // da Tarefa 66: logado, o modal **não está montado** (aqui é renderizado
    // `children`). Com o cleanup dentro dele, o logout chegava sem apagar nada — o
    // `LoginModal` voltava a montar, reencontrava a sessão salva e disparava
    // `dinf:login` de novo, deixando o sistema carregado.
    //
    // A ordem importa: limpar o armazenamento ANTES de `setLogado(false)` garante que
    // o modal que vai subir não se considere logado.
    function aoDeslogar() {
      void fetch('/api/login', { method: 'DELETE' }).catch(() => undefined);
      limparUsuarioSessao();
      setLogado(false);
    }

    // Tarefa 73 — a sessão salva no navegador não expira, o cookie expira (8 h).
    // Ao reabrir o sistema depois desse prazo, a tela montaria "logada" e cada rota
    // protegida responderia 401: o sistema pareceria quebrado em vez de pedir a senha.
    // Daí conferir no servidor. De propósito só 401 derruba para o login — uma falha
    // de rede ou o servidor fora do ar não desconecta quem já está dentro.
    async function conferirSessaoSalva() {
      try {
        const resposta = await fetch('/api/login', { method: 'GET', cache: 'no-store' });
        if (resposta.status === 401) {
          limparUsuarioSessao();
          setLogado(false);
          return;
        }

        if (resposta.ok) {
          const corpo = (await resposta.json()) as { usuario?: UsuarioSessao };
          atualizarDadosDoUsuario(corpo.usuario ?? null);
        }
      } catch {
        // Sem resposta do servidor: mantém a tela como está.
      }
    }
    if (obterUsuarioSessao() !== null) {
      void conferirSessaoSalva();
    }

    // Tarefa 75 — nome e função vinham de uma cópia antiga gravada no login, e como o
    // `localStorage` não expira, quem o admin renomeasse ou promovesse continuava vendo o
    // texto velho até entrar de novo. Aqui a cópia é reescrita com o que veio do banco.
    //
    // O evento é `dinf:sessao` e **não** `dinf:login` de propósito: o `aoLogar` faz
    // `router.replace('/')`, e dispará-lo a cada abertura jogaria o técnico para a
    // primeira tela. Este só atualiza o texto do menu.
    function atualizarDadosDoUsuario(doServidor: UsuarioSessao | null) {
      if (!doServidor) {
        return;
      }

      const guardado = obterUsuarioSessao();
      const iguais =
        guardado !== null &&
        guardado.nome === doServidor.nome &&
        guardado.funcao === doServidor.funcao &&
        (guardado.usuario ?? '') === (doServidor.usuario ?? '');

      if (iguais) {
        return;
      }

      salvarUsuarioSessao(doServidor);
      window.dispatchEvent(new CustomEvent<UsuarioSessao>('dinf:sessao', { detail: doServidor }));
    }

    // Tarefa 73 — `localStorage` é compartilhado entre as abas do navegador, mas os
    // eventos `dinf:login`/`dinf:logout` só alcançam a janela que os disparou. Sem
    // isto, um login ou logout feito em uma aba deixaria as outras para trás, com a
    // tela mostrando uma sessão que o cookie já não representa.
    function aoMudarEmOutraAba(evento: StorageEvent) {
      if (evento.key !== CHAVE_SESSAO_LOCAL) {
        return;
      }
      setLogado(obterUsuarioSessao() !== null);
    }

    window.addEventListener('dinf:login', aoLogar);
    window.addEventListener('dinf:logout', aoDeslogar);
    window.addEventListener('storage', aoMudarEmOutraAba);

    return () => {
      window.removeEventListener('dinf:login', aoLogar);
      window.removeEventListener('dinf:logout', aoDeslogar);
      window.removeEventListener('storage', aoMudarEmOutraAba);
    };
  }, [router]);

  // Tarefa 78 — sessão deslizante.
  //
  // A validade de 4 h conta como **tempo de inatividade**: enquanto a pessoa estiver
  // usando o sistema, o prazo é renovado. O gatilho é a interação aqui no navegador
  // (clique, tecla, rolagem) e não o servidor, porque trocar de aba dentro do Next é
  // client-side e não passa por aqui — quem só navega entre telas nunca chamaria o
  // servidor. Um `setInterval` fixo também não serviria: manteria a sessão viva de quem
  // deixou a máquina esquecida, que é justamente o que o usuário pediu para não
  // acontecer.
  //
  // O intervalo de 15 min evita uma chamada por clique; a cada 15 min de uso, no máximo
  // uma requisição — e ela é a mesma que já confere a sessão.
  useEffect(() => {
    let ultimaRenovacao = Date.now();

    async function renovarSeHouverUso() {
      if (Date.now() - ultimaRenovacao < INTERVALO_RENOVACAO_MS) {
        return;
      }
      ultimaRenovacao = Date.now();

      try {
        const resposta = await fetch('/api/login', { method: 'GET', cache: 'no-store' });

        // 401 aqui significa que o prazo de inatividade estourou: o cookie já sumiu e
        // não há o que renovar. Aí sim é para limpar e voltar ao login.
        if (resposta.status === 401) {
          limparUsuarioSessao();
          setLogado(false);
        }
      } catch {
        // Sem rede, a sessão não é mexida — o servidor fora do ar não desloga ninguém.
      }
    }

    for (const evento of EVENTOS_DE_ATIVIDADE) {
      window.addEventListener(evento, renovarSeHouverUso, { passive: true });
    }

    return () => {
      for (const evento of EVENTOS_DE_ATIVIDADE) {
        window.removeEventListener(evento, renovarSeHouverUso);
      }
    };
  }, []);

  if (logado === null) {
    return null;
  }

  if (!logado) {
    return <LoginModal />;
  }

  return <>{children}</>;
}
