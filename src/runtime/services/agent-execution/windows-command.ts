import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProcessSpec } from '../../../contracts/index.js';

/** PowerShell only loads the shipped job owner; CLI argv is JSON, never script. */
export function windowsCommand(spec: AgentProcessSpec): {
  executable: string;
  args: string[];
} {
  return {
    executable: join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('./windows-job.ps1', import.meta.url)),
      '-Launch',
      Buffer.from(
        JSON.stringify({ executable: spec.executable, args: spec.args }),
      ).toString('base64'),
    ],
  };
}
