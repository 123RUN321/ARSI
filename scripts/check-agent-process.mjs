import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentProcessLauncher } from '../dist/src/runtime/services/agent-execution/process.js';

const root = await mkdtemp(join(tmpdir(), 'rsi-agent-process-'));
try {
  const project = join(root, 'project');
  await mkdir(project);
  const controller = new AbortController();
  const launch = agentProcessLauncher({
    directory: join(root, 'call'),
    project,
    signal: controller.signal,
  });
  const seen = [];
  await launch(
    {
      executable: process.execPath,
      args: [
        '-e',
        'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write(JSON.stringify({text:"完整消息",cwd:process.cwd()})))',
      ],
      input: 'task',
    },
    (line) => {
      seen.push(JSON.parse(line));
    },
  );
  assert.equal(seen[0].text, '完整消息');
  const ticks = join(project, 'ticks');
  const running = launch(
    {
      executable: process.execPath,
      args: [
        '-e',
        `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(ticks)},'x'),20)`)}],{stdio:'inherit'}); console.log('ready'); setInterval(()=>{},1000);`,
      ],
      input: '',
    },
    () => {
      setTimeout(() => controller.abort(new Error('probe cancelled')), 150);
    },
  );
  await assert.rejects(running, /probe cancelled/);
  let before = '';
  try {
    before = await readFile(ticks, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await new Promise((done) => setTimeout(done, 120));
  let after = '';
  try {
    after = await readFile(ticks, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.equal(before, after);
  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      protocol: 'passed',
      cancellation: 'passed',
      descendants: 'passed',
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
