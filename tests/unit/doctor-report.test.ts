import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  DoctorBinding,
  DoctorReport,
  DoctorResult,
} from '../../src/contracts/index.js';
import { agentContract } from '../../src/contracts/plugin-types/agent.js';
import {
  appendBindingResult,
  redactDoctorReport,
} from '../../src/runtime/doctor/report.js';
import { redactConfiguration } from '../../src/shared/errors.js';

const binding: DoctorBinding = {
  name: 'agent',
  pluginId: 'agent.fixture',
  config: {},
  definition: {
    id: 'agent.fixture',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      throw new Error('Report collection must not create a plugin.');
    },
  },
};

test('doctor report rejects a whole binding result on duplicate IDs or invalid evidence', () => {
  const report: DoctorReport = {
    recipeId: 'fixture',
    checks: [{ id: 'agent.input', status: 'passed' }],
  };
  const before = structuredClone(report);
  assert.throws(
    () =>
      appendBindingResult(report, binding, {
        checks: [
          { id: 'new', status: 'passed' },
          { id: 'input', status: 'failed', reason: 'Restore input.' },
        ],
      }),
    /Duplicate doctor check ID/,
  );
  assert.deepEqual(report, before);
  const details = {};
  Object.defineProperty(details, 'invalid', { value: 1n, enumerable: true });
  assert.throws(
    () =>
      appendBindingResult(report, binding, {
        checks: [
          { id: 'new', status: 'passed' },
          { id: 'evidence', status: 'passed', details },
        ],
      }),
    /finite JSON/,
  );
  assert.deepEqual(report, before);
  const invalid: DoctorResult = {
    checks: [{ id: 'evidence', status: 'passed', details: {} }],
  };
  Object.defineProperty(invalid.checks[0], 'details', { value: [] });
  assert.throws(
    () => appendBindingResult(report, binding, invalid),
    /expected object/,
  );
  assert.deepEqual(report, before);
});

test('doctor report snapshots evidence and redacts it with the original credentials', () => {
  const secret = 'doctor-report-fixture-secret';
  const redact = redactConfiguration({ api_key: secret });
  const details = { nested: [{ credential: secret }] };
  const report: DoctorReport = { recipeId: 'fixture', checks: [] };
  appendBindingResult(report, binding, {
    checks: [
      {
        id: 'input',
        status: 'failed',
        reason: `Rejected ${secret}`,
        details,
      },
    ],
  });
  details.nested[0]!.credential = 'changed-after-collection';
  const result = redactDoctorReport(report, redact);
  assert.deepEqual(result.checks, [
    {
      id: 'agent.input',
      binding: 'agent',
      pluginId: 'agent.fixture',
      status: 'failed',
      reason: 'Rejected [redacted]',
      details: { nested: [{ credential: '[redacted]' }] },
    },
  ]);
  assert.ok(JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(result).includes(secret));
});
