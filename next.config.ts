import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 é um módulo nativo: deve ficar fora do bundle do servidor.
  serverExternalPackages: ['better-sqlite3'],
  // Remove o indicador de desenvolvimento do Next (botão do canto inferior esquerdo).
  // O canto passou a ser do bloco de perfil do técnico no rodapé do menu (Tarefa 46).
  // Erros de compilação/execução continuam aparecendo normalmente.
  devIndicators: false,
};

export default nextConfig;
