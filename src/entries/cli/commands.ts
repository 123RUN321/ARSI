import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { aborted } from 'node:util';
import { Argument, Command, InvalidArgumentError } from 'commander';
import type { Runtime } from '../../runtime/context.js';
import { checkRecipe } from './doctor.js';

export class CommandUsageError extends Error {
  constructor(
    message: string,
    readonly helpText: string,
  ) {
    super(message);
  }
}

export interface CommandContext {
  signal: AbortSignal;
  openRuntime(pluginDirectories: string[]): Promise<Runtime>;
  disposeRuntime(): Promise<{ exitCode: 0 } | { exitCode: 1; error: unknown }>;
}

interface CommandResult {
  exitCode: number;
  stdout?: string;
}

async function ensurePluginHome(): Promise<void> {
  await mkdir(join(homedir(), '.arsi', 'plugins'), { recursive: true });
}

function requiredRevisionId(id: string): string {
  if (!id) throw new Error('Revision ID is required');
  return id;
}

export async function runCommand(
  argv: string[],
  context: CommandContext,
): Promise<CommandResult> {
  let result: CommandResult | undefined;
  let help = '';
  const helpRequested = new Error('Help requested');
  const captureHelp = (text: string): void => {
    help += text;
  };
  const program = new Command('arsi')
    .description('Make everything rsi-able')
    .allowExcessArguments(false)
    .showHelpAfterError()
    .exitOverride((error) => {
      if (error.exitCode === 0) throw helpRequested;
      throw new CommandUsageError(
        error.message,
        help || program.helpInformation(),
      );
    })
    .configureOutput({ writeOut: captureHelp, writeErr: captureHelp })
    .option(
      '--plugin-dir <directory>',
      'Load extensions from a directory (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [],
    );
  program.addHelpText(
    'after',
    '\nRun facts are saved in .rsi/ under the current directory.\nExtensions load from ~/.arsi/plugins/<name>/index.mjs by default.\nEach plugin directory must contain index.mjs exporting register(registry).',
  );
  const pluginDirectories = (): string[] =>
    program.opts<{ pluginDir: string[] }>().pluginDir;
  const jsonResult = (value: unknown, exitCode = 0): CommandResult => ({
    exitCode,
    stdout: JSON.stringify(value, null, 2) + '\n',
  });
  const withRuntime = async (
    execute: (runtime: Runtime) => unknown,
  ): Promise<void> => {
    await ensurePluginHome();
    const runtime = await context.openRuntime(pluginDirectories());
    result = jsonResult(await execute(runtime));
  };
  program
    .command('run <recipe.yaml>')
    .description('Run or resume an experiment')
    .option('--id <experiment-id>', 'Set the experiment ID')
    .option('--resume', 'Resume an experiment using a compatible Recipe')
    .action(runExperiment);
  program
    .command('doctor <recipe.yaml>')
    .description('Check experiment configuration and runtime prerequisites')
    .option('--static', 'Check configuration and declared local paths only')
    .action(async (file: string, options: { static?: boolean }) => {
      const report = await checkRecipe(
        file,
        options.static ?? false,
        pluginDirectories(),
        context,
      );
      result = jsonResult(report, report.summary.failed > 0 ? 1 : 0);
    });
  program
    .command('list')
    .description('List experiments, plugins, or policies')
    .addArgument(
      new Argument('[kind]').choices([
        'plugin',
        'plugins',
        'policy',
        'policies',
      ]),
    )
    .action(list);
  program
    .command('show <experiment-id>')
    .description('Show an experiment')
    .action((id: string) => withRuntime(({ manager }) => manager.get(id)));
  program
    .command('cancel <experiment-id>')
    .description('Cancel an experiment')
    .action((id: string) =>
      withRuntime(async ({ manager }) => {
        await manager.cancel(id);
        return { id, cancellationRequested: true };
      }),
    );
  const reflection = program
    .command('reflection')
    .description('Inspect and apply reflection revisions');
  reflection
    .command('list [experiment-id]')
    .description('List reflection revisions')
    .action((id: string | undefined) =>
      withRuntime(({ manager }) => manager.reflection().list(id || undefined)),
    );
  reflection
    .command('show <revisionID>')
    .description('Show reflection revisions')
    .action((id: string) =>
      withRuntime(({ manager }) =>
        manager.reflection().show(requiredRevisionId(id)),
      ),
    );
  reflection
    .command('apply <revisionID>')
    .description('Apply reflection revisions')
    .action((id: string) =>
      withRuntime(({ manager }) =>
        manager.reflection().apply(requiredRevisionId(id)),
      ),
    );
  program
    .command('catalog')
    .description('Show registered contracts, plugins, and policies')
    .action(() => withRuntime(({ registry }) => registry.catalog()));
  program
    .command('dashboard')
    .description('Start the dashboard on localhost')
    .option(
      '--port <port>',
      'Listening port (1..65535)',
      (value: string) => {
        const port = Number(value);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
          throw new InvalidArgumentError('port must be 1..65535');
        return port;
      },
      4317,
    )
    .action(startDashboard);

  function runExperiment(
    file: string,
    { id, resume = false }: { id?: string; resume?: boolean },
    cmd: Command,
  ): Promise<void> {
    if (resume && !id) cmd.error('--resume requires --id');
    return withRuntime(({ manager }) =>
      manager.run(resolve(file), { id, resume, signal: context.signal }),
    );
  }

  function list(kind: string | undefined): Promise<void> {
    return withRuntime(async ({ manager, registry }) => {
      if (!kind) return manager.list();
      const { describeCatalog } = await import('./catalog.js');
      const catalog = await describeCatalog(registry);
      return kind === 'plugin' || kind === 'plugins'
        ? catalog.plugins
        : catalog.policies;
    });
  }

  async function startDashboard({ port }: { port: number }): Promise<void> {
    await ensurePluginHome();
    if (!statSync('.rsi', { throwIfNoEntry: false })?.isDirectory())
      throw new Error(
        'Dashboard requires a .rsi directory in the current working directory. Run it from your experiment workspace.',
      );
    const runtime = await context.openRuntime(pluginDirectories());
    const { createServer } = await import('../web/server.js');
    const server = await createServer(runtime);
    const address = await server.listen({ host: '127.0.0.1', port });
    process.stdout.write(`Dashboard open at ${address}\n`);
    try {
      await aborted(context.signal, server);
    } finally {
      await server.close();
    }
    result = { exitCode: 0 };
  }

  try {
    await program.parseAsync(argv.length ? argv : ['--help'], { from: 'user' });
  } catch (error) {
    if (error !== helpRequested) throw error;
    await ensurePluginHome();
    return { exitCode: 0, stdout: help };
  }
  if (!result)
    throw new Error('Choose a subcommand; use --help for available commands');
  return result;
}
