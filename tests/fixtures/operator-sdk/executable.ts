import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

let windowsLauncher: Promise<string> | undefined;

async function compileWindowsLauncher(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-node-fixture-'));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'launcher.cs');
  const executable = join(root, 'launcher.exe');
  await writeFile(
    source,
    String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;

static class FixtureLauncher {
  static string Quote(string argument) {
    // Double backslashes immediately before a quote or the end of the argument.
    return "\"" + Regex.Replace(argument, @"(\\*)(""|$)", match =>
      match.Groups[1].Value + match.Groups[1].Value +
      (match.Groups[2].Value == "\"" ? "\\\"" : "")) + "\"";
  }

  static int Main(string[] args) {
    string script = Path.ChangeExtension(Assembly.GetExecutingAssembly().Location, ".mjs");
    string arguments = Quote(script) + " " + String.Join(" ", Array.ConvertAll(args, Quote));
    var start = new ProcessStartInfo(@"${process.execPath.replaceAll('"', '""')}", arguments);
    start.UseShellExecute = false;
    using (Process child = Process.Start(start)) {
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}
`,
  );
  // The Windows SDK process runner already depends on Windows PowerShell and
  // .NET Framework. Use its compiler to turn the fixture into a CreateProcess target.
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  await promisify(execFile)(
    join(systemRoot, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
    ['/nologo', '/codepage:65001', `/out:${executable}`, source],
    { windowsHide: true },
  );
  return executable;
}

export async function prepareNodeFixture(scriptPath: string): Promise<string> {
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
    return scriptPath;
  }
  windowsLauncher ??= compileWindowsLauncher();
  const executable = join(
    dirname(scriptPath),
    basename(scriptPath, '.mjs') + '.exe',
  );
  await copyFile(await windowsLauncher, executable);
  return executable;
}
