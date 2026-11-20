import test from 'node:test';
import assert from 'node:assert/strict';
import { retryStartup } from '../../src/shared/startup-retry.js';

test('temporary initialization failures retry, permanent failures stop immediately', async () => {
  for (const [code, expected] of [
    ['EAGAIN', 3],
    ['ENOENT', 1],
  ] as const) {
    let attempts = 0;
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(
      retryStartup(new AbortController().signal, async () => {
        attempts++;
        throw error;
      }),
      (caught) => caught === error,
    );
    assert.equal(attempts, expected);
  }
});

test('cancellation during startup backoff prevents a second attempt', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const result = retryStartup(controller.signal, async () => {
    attempts++;
    throw Object.assign(new Error('temporary'), { code: 'EBUSY' });
  });
  setImmediate(() => controller.abort());
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(attempts, 1);
});
