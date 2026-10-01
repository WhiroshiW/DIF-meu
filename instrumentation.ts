// Registrado automaticamente pelo Next.js na subida do servidor.
// No Next 15 o `instrumentation.ts` e estavel (sem flag experimental).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { iniciarAgendadorGlpi } = await import('./lib/agendadorGlpi');
    iniciarAgendadorGlpi();
  }
}
