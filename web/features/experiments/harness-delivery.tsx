import React from 'react';
import type { MeasurementSummary } from '../../api/observation-client';
import { Status } from '../../components/observation-feedback';
import { route } from '../../app/routing';
import { primaryScore } from './measurement-score';
import { scoreLabel } from './record-identifiers';

/** A delivery is supplied by the saved selector output, never inferred from scores. */
export function HarnessDelivery({
  id,
  measurement,
  stage,
}: {
  id: string;
  measurement: MeasurementSummary;
  stage: string;
}): React.JSX.Element {
  const score = primaryScore(measurement);
  return (
    <div>
      <a
        className="harness-score-link"
        href={route(id, 'measurements', undefined, undefined, {
          measurement: measurement.ref,
        })}
        aria-label={`Delivered · ${stage} · ${score === null ? 'Score unavailable' : scoreLabel(score)}`}
      >
        {score === null ? '—' : scoreLabel(score)}
      </a>
      <small className="muted"> · {stage}</small>
      {measurement.status !== 'succeeded' ? (
        <Status value={measurement.status} />
      ) : null}
      {measurement.coverage !== 'complete' ? (
        <small className="muted"> · {measurement.coverage}</small>
      ) : null}
    </div>
  );
}
