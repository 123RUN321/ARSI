import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedObservation } from '../fixtures/observation/seed.js';
import { ObservationQueries } from '../../src/runtime/services/observation.js';
import { parseMeasurements } from '../../web/api/observation-client.js';

test('a resumed call keeps each saved evaluation diagnostic owned, redacted and bounded', async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'rsi-evaluation-diagnostics-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { facts, artifacts } = await seedObservation(directory);
  const diagnosticsRef = await artifacts.putJson({
    message: 'Historical startup failure: fixture-private-value',
    apiKey: 'diagnostic-private-value',
    tail: 'diagnostic-private-value ' + 'x'.repeat(40000),
  });
  const saved = {
    ...(await facts.read('measurements', 'measurement-second')),
    status: 'failed',
    diagnosticsRef,
  };
  await facts.write('measurements', 'measurement-second', saved);
  await facts.write('calls', 'call-second', {
    ...(await facts.read('calls', 'call-second')),
    status: 'running',
    error: null,
    resumedAt: '2026-10-29T01:01:00.000Z',
  });
  const queries = new ObservationQueries(facts, artifacts);
  const measurements = parseMeasurements(
    await queries.measurements('run-alpha'),
  );
  assert.equal(measurements.items[0]?.diagnosticsRef, null);
  const failed = measurements.items.find(
    (item) => item.ref === 'measurement-second',
  );
  assert.equal(failed?.diagnosticsRef, diagnosticsRef);
  assert.equal(failed?.status, 'failed');
  const preview = await queries.artifact('run-alpha', diagnosticsRef);
  assert.match(preview.content!.text, /Historical startup failure/);
  assert.doesNotMatch(
    preview.content!.text,
    /fixture-private-value|diagnostic-private-value/,
  );
  assert.equal(preview.content!.truncated, true);
  assert.equal(preview.content!.text.length, 32768);
  await assert.rejects(
    queries.artifact('run-other', diagnosticsRef),
    /not found in experiment/,
  );
  assert.deepEqual(
    await facts.read('measurements', 'measurement-second'),
    saved,
  );
});
