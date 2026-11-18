import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { lock } from 'proper-lockfile';
import { ObservationQueries } from '../../src/runtime/services/observation.js';
import { FileFacts, FileArtifacts } from '../../src/runtime/storage/index.js';
import {
  executionLockPath,
  executionLockTiming,
} from '../../src/runtime/manager/execution-lock.js';
import {
  parseExperiment,
  parseOverview,
} from '../../web/api/observation-client.js';

test('list and detail require a live Runtime owner, preserve facts, and observe resume', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-execution-observation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const facts = new FileFacts(join(directory, 'facts'));
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const saved = {
    id: 'run',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
  };
  await facts.write('experiments', 'run', saved);
  await facts.write('calls', 'failed-call', {
    experimentId: 'run',
    callId: 'failed-call',
    status: 'failed',
  });
  await facts.write('experiments', 'finished', {
    id: 'finished',
    status: 'failed',
  });
  const query = new ObservationQueries(facts, artifacts, directory);
  const expectStatus = async (
    expected: 'running' | 'unconfirmed',
  ): Promise<void> => {
    const list = await query.experiments();
    const entry = list.items.find((item) => item.id === 'run')!;
    const detail = parseOverview(await query.overview('run'));
    for (const item of [parseExperiment(entry), detail]) {
      assert.equal(item.status, expected);
      assert.equal('executionStatus' in item, false);
    }
    assert.equal('executionStatus' in entry, false);
    assert.equal(
      list.items.find((item) => item.id === 'finished')?.status,
      'failed',
    );
    assert.deepEqual(await facts.read('experiments', 'run'), saved);
  };
  await expectStatus('unconfirmed');
  const path = executionLockPath(directory, 'run');
  await mkdir(dirname(path), { recursive: true });
  let release = await lock(path, { realpath: false, ...executionLockTiming });
  try {
    await expectStatus('running');
  } finally {
    await release();
  }
  await expectStatus('unconfirmed');
  release = await lock(path, { realpath: false, ...executionLockTiming });
  try {
    await expectStatus('running');
  } finally {
    await release();
  }
});

test('stale or uninspectable locks and unavailable execution sources remain unconfirmed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-stale-execution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const facts = new FileFacts(join(directory, 'facts'));
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  await facts.write('experiments', 'run', { id: 'run', status: 'running' });
  const query = new ObservationQueries(facts, artifacts, directory);
  const path = executionLockPath(directory, 'run') + '.lock';
  await mkdir(path, { recursive: true });
  const old = new Date(Date.now() - executionLockTiming.stale - 10_000);
  await utimes(path, old, old);
  const before = await stat(path);
  assert.equal((await query.overview('run')).status, 'unconfirmed');
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  await rm(dirname(path), { recursive: true });
  await writeFile(dirname(path), 'not a lock directory');
  assert.equal((await query.overview('run')).status, 'unconfirmed');
  assert.equal(
    (await new ObservationQueries(facts, artifacts).overview('run')).status,
    'unconfirmed',
  );
});
