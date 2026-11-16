import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MeasurementDiagnostics } from '../../web/features/experiments/measurement-diagnostics.tsx';

test('saved diagnostics are optional and only loaded after opening the evaluation evidence', () => {
  const render = (diagnosticsRef) =>
    renderToStaticMarkup(
      React.createElement(MeasurementDiagnostics, {
        id: 'run',
        diagnosticsRef,
      }),
    );
  assert.equal(render(undefined), '');
  assert.equal(render(null), '');
  const html = render('artifact:' + 'a'.repeat(64));
  assert.match(html, /Recorded evaluation diagnostics/);
  assert.match(html, /linked call may have resumed/);
  assert.doesNotMatch(html, /text preview|code-content/);
});
