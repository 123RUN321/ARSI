import test from 'node:test';
import assert from 'node:assert/strict';
import type { DoctorStep } from '../../src/contracts/index.js';
import { runDoctorSteps } from '../../src/runtime/doctor/steps.js';

test('doctor definitions stay lazy and retain every remaining step after failure', async () => {
  const calls: string[] = [];
  const steps: DoctorStep[] = [
    {
      id: 'url',
      check: () => {
        calls.push('url');
        return true;
      },
      reason: 'Correct serviceUrl.',
    },
    {
      id: 'prompt',
      check: async (signal) => {
        signal.throwIfAborted();
        calls.push('prompt');
        return false;
      },
      reason: 'Restore prompt.md or correct prompt.',
    },
    {
      id: 'executable',
      check: () => {
        calls.push('executable');
        return true;
      },
      reason: 'Install the executable.',
    },
    { id: 'remote', reason: 'Remote readiness is unsupported.' },
  ];
  assert.deepEqual(calls, []);
  const result = await runDoctorSteps(steps, new AbortController().signal);
  assert.deepEqual(calls, ['url', 'prompt']);
  assert.deepEqual(
    result.checks.map(({ id, status }) => [id, status]),
    [
      ['url', 'passed'],
      ['prompt', 'failed'],
      ['executable', 'unchecked'],
      ['remote', 'unchecked'],
    ],
  );
  assert.equal(
    result.checks.find((check) => check.id === 'prompt')?.reason,
    'Restore prompt.md or correct prompt.',
  );
  assert.match(
    result.checks.find((check) => check.id === 'executable')?.reason ?? '',
    /prompt failed/,
  );
});

test('unsupported diagnostics do not block checks and observations are read after execution', async () => {
  let ready = false;
  const steps: DoctorStep[] = [
    { id: 'unsupported', reason: 'This diagnostic is unsupported.' },
    {
      id: 'native',
      check: () => {
        ready = true;
        return true;
      },
      reason: 'Repair the native CLI.',
      get details() {
        return { ready };
      },
    },
  ];
  const result = await runDoctorSteps(steps, new AbortController().signal);
  assert.deepEqual(result.checks, [
    {
      id: 'unsupported',
      status: 'unchecked',
      reason: 'This diagnostic is unsupported.',
    },
    { id: 'native', status: 'passed', details: { ready: true } },
  ]);
});

test('doctor rejects invalid definitions and nonboolean predicate results', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const step: DoctorStep = {
    id: 'input',
    reason: 'Correct input.',
    check: () => {
      calls++;
      return true;
    },
  };
  await assert.rejects(runDoctorSteps([step, step], signal), /unique/);
  assert.equal(calls, 0);
  Object.defineProperty(step, 'check', { value: () => undefined });
  const result = await runDoctorSteps(
    [
      step,
      {
        id: 'later',
        reason: 'Later check.',
        check: () => {
          calls++;
          return true;
        },
      },
    ],
    signal,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    result.checks.map((check) => check.status),
    ['failed', 'unchecked'],
  );
  assert.match(
    result.checks.find((check) => check.id === 'input')?.reason ?? '',
    /must return a boolean/,
  );
});
