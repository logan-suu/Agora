export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerLocalStartup } = await import('./server/local-startup');
    await registerLocalStartup();
  }
}
