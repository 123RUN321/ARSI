import type { JSX } from 'react';
import type { CallInstructions } from '../../../src/contracts/observation.js';
import { parseCallInstructions } from '../../api/observation-client';
import { Feedback } from '../../components/observation-feedback';
import { eventObject } from './trace-model';
import { useObservation } from './use-observation';

export function TraceInputs({
  id,
  callId,
  runId,
  finished,
  onViewParentEvent,
}: {
  id: string;
  callId: string;
  runId: string;
  finished: boolean;
  onViewParentEvent: (
    source: Pick<
      NonNullable<CallInstructions['delegation']>,
      'parentRunId' | 'sequence'
    >,
  ) => void;
}): JSX.Element {
  const result = useObservation(
    `/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}/instructions?runId=${encodeURIComponent(runId)}`,
    parseCallInstructions,
    finished ? null : 4000,
    finished,
  );
  const inputs = result.data;
  const delegation = inputs?.delegation;
  const task = inputs?.submittedTask ?? delegation?.message;
  const child = runId !== 'main';
  const workspace = inputs?.workspaceInstructions ?? [];
  const guides = workspace.filter(
    ({ path }) => path === 'AGENTS.md' || path === 'CLAUDE.md',
  );
  const sharedGuide =
    guides.length === 2 &&
    guides.every(
      ({ content }) =>
        !content.truncated && content.text === guides[0].content.text,
    );
  const files = sharedGuide
    ? [
        { path: 'AGENTS.md · CLAUDE.md', content: guides[0].content },
        ...workspace.filter((file) => !guides.includes(file)),
      ]
    : workspace;

  let readableTask: { goal: string; instruction?: string } | undefined;
  if (inputs?.submittedTask && task && !task.truncated) {
    try {
      const parsed = eventObject(JSON.parse(task.text));
      if (typeof parsed.goal === 'string') {
        readableTask = {
          goal: parsed.goal,
          ...(typeof parsed.instruction === 'string'
            ? { instruction: parsed.instruction }
            : {}),
        };
      }
    } catch {
      // Native adapters can submit plain text.
    }
  }

  return (
    <>
      <Feedback {...result} />
      {inputs ? (
        <div className="trace-inputs">
          <section className="trace-input-task">
            <h4>{child ? 'Delegated task' : 'Submitted task'}</h4>
            {readableTask ? (
              <>
                <dl className="trace-task-fields">
                  <dt>Goal</dt>
                  <dd>{readableTask.goal}</dd>
                  {readableTask.instruction ? (
                    <>
                      <dt>Instruction</dt>
                      <dd>{readableTask.instruction}</dd>
                    </>
                  ) : null}
                </dl>
              </>
            ) : task ? (
              <>
                <pre tabIndex={0}>{task.text}</pre>
                {task.truncated ? <small>Truncated preview</small> : null}
              </>
            ) : (
              <p className="muted">
                {delegation
                  ? 'Delegation message unavailable.'
                  : finished
                    ? child
                      ? 'Delegated task not recorded.'
                      : 'Task submission not recorded.'
                    : 'Waiting for a recorded task.'}
              </p>
            )}
            {delegation ? (
              <button
                type="button"
                className="quiet-button"
                onClick={() => onViewParentEvent(delegation)}
              >
                View parent event
              </button>
            ) : null}
          </section>
          {readableTask ? (
            <details className="trace-input-disclosure">
              <summary>Raw task text</summary>
              <pre tabIndex={0}>{task?.text}</pre>
            </details>
          ) : null}
          {files.length ? (
            <details className="trace-input-disclosure">
              <summary>
                {child
                  ? 'Shared workspace instructions'
                  : 'Workspace instructions'}
              </summary>
              <p className="muted">
                Files saved in the workspace snapshot at call start.
              </p>
              {files.map(({ path, content }) => (
                <details className="trace-input-file" key={path}>
                  <summary>
                    {path}
                    {content.truncated ? ' · truncated preview' : ''}
                  </summary>
                  <pre tabIndex={0}>{content.text}</pre>
                </details>
              ))}
            </details>
          ) : null}
          {inputs.outputSchema ? (
            <details className="trace-input-disclosure">
              <summary>
                Output schema
                {inputs.outputSchema.truncated ? ' · truncated preview' : ''}
              </summary>
              <pre tabIndex={0}>{inputs.outputSchema.text}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
