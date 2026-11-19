import { statSync } from 'node:fs';
import { aborted } from 'node:util';
import { ensurePluginHome, type CommandContext } from './runtime.js';

export async function startDashboard(
  port: number,
  pluginDirectories: string[],
  { openRuntime, signal }: CommandContext,
): Promise<void> {
  await ensurePluginHome();
  if (!statSync('.rsi', { throwIfNoEntry: false })?.isDirectory())
    throw new Error(
      'Dashboard requires a .rsi directory in the current working directory. Run it from your experiment workspace.',
    );
  const runtime = await openRuntime(pluginDirectories);
  const { createServer } = await import('../web/server.js');
  const server = await createServer(runtime);
  const address = await server.listen({ host: '127.0.0.1', port });
  process.stdout.write(`Dashboard open at ${address}\n`);
  try {
    await aborted(signal, server);
  } finally {
    await server.close();
  }
}
