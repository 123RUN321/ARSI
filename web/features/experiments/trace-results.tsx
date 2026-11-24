import { useState, type JSX } from 'react';
import {
  parseAgentPayload,
  parseCallDetail,
  parseCallTrace,
} from '../../api/observation-client';
import { Feedback, Preview } from '../../components/observation-feedback';
import { eventObject, eventText } from './trace-model';
import { useObservation } from './use-observation';

export function TraceResults({
  callPath,
  sequence,
  finished,
  main,
}: {
  callPath: string;
  sequence: number | undefined;
  finished: boolean;
  main: boolean;
}): JSX.Element {
  const [finalOpen, setFinalOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const response = useObservation(
    finalOpen && sequence !== undefined
      ? `${callPath}/trace?offset=${sequence - 1}&limit=1`
      : null,
    parseCallTrace,
    null,
    true,
  );
  const record = response.data?.items[0];
  const payload = useObservation(
    record?.payloadRef
      ? `${callPath}/agent/payloads/${record.payloadRef}`
      : null,
    parseAgentPayload,
    null,
    true,
  );
  const message = eventText(
    eventObject(record?.payloadRef ? payload.data : record?.event).text,
  );
  const result = useObservation(
    main && resultOpen ? callPath : null,
    parseCallDetail,
    finished ? null : 4000,
    finished,
  );
  return (
    <>
      <details
        className="inspector-inputs"
        onToggle={(event) => setFinalOpen(event.currentTarget.open)}
      >
        <summary>Final response</summary>
        {finalOpen ? (
          <div className="inspector-input-view">
            <Feedback {...response} />
            <Feedback {...payload} />
            {message ? (
              <pre tabIndex={0}>{message}</pre>
            ) : !response.loading &&
              !payload.loading &&
              !response.error &&
              !payload.error ? (
              <p className="muted">
                {finished
                  ? 'No final response was recorded.'
                  : 'Waiting for a final response.'}
              </p>
            ) : null}
          </div>
        ) : null}
      </details>
      {main ? (
        <details
          className="inspector-inputs"
          onToggle={(event) => setResultOpen(event.currentTarget.open)}
        >
          <summary>Structured result</summary>
          {resultOpen ? (
            <div className="inspector-input-view">
              <Feedback {...result} />
              {result.data?.error ? (
                <p className="error-notice">{result.data.error}</p>
              ) : null}
              {result.data ? (
                <>
                  <pre tabIndex={0}>
                    {result.data.output?.text ??
                      (finished
                        ? 'No structured result was saved.'
                        : 'Waiting for the structured result.')}
                  </pre>
                  {result.data.output?.truncated ? (
                    <small>Truncated preview</small>
                  ) : null}
                  {result.data.input ? (
                    <details className="trace-input-disclosure">
                      <summary>Agent task</summary>
                      <Preview label="Task" value={result.data.input} />
                    </details>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </details>
      ) : null}
    </>
  );
}
