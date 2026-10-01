import Link from 'next/link';

/**
 * Raiz do sistema: abre sem nenhuma categoria selecionada.
 * O conteúdo de cada categoria só é exibido depois que o usuário a seleciona no menu lateral.
 */
export default function PaginaInicial() {
  return (
    <>
      <header className="cabecalho">
        <div>
          <h1 className="cabecalho__titulo">Início</h1>
          <p className="cabecalho__descricao">
            Selecione uma categoria no menu lateral para começar.
          </p>
        </div>
      </header>

      <section className="painel boas-vindas">
        <h2 className="boas-vindas__titulo">Nenhuma categoria selecionada</h2>
        <p className="boas-vindas__texto">
          O conteúdo aparece aqui após a escolha de uma categoria no menu à esquerda. Hoje estão
          disponíveis as categorias <strong>Técnicos</strong>, com a lista de cadastrados ativos,
          a lista de desativados e o botão de adicionar, e <strong>Agenda</strong>, com o calendário
          do mês, os eventos do dia selecionado e os aniversários dos técnicos. A categoria{' '}
          <strong>GLPI</strong> já está reservada no menu, mas ainda não tem conteúdo.
        </p>
        <Link href="/tecnicos" className="botao">
          Abrir categoria Técnicos
        </Link>
      </section>
    </>
  );
}