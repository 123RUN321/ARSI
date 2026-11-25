import { useRoundLabels } from './round-labels';
import React from 'react';
import {
  type ExperimentOverview,
  parseDetails,
  parseCandidates,
  parseMeasurements,
} from '../../api/observation-client';
import { useAllObservations, useObservation } from './use-observation';
import { Feedback } from '../../components/observation-feedback';
import { recordedDuration } from './experiment-summary';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { InferenceReport } from './inference-report';
import { inferenceSummary } from './inference-summary';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
export function Overview({
  data,
  children,
}: {
  data: ExperimentOverview;
  children?: React.ReactNode;
}): React.JSX.Element {
  const labels = useRoundLabels();
  const usage = data.usage;
  const candidates = useAllObservations(
    `/${encodeURIComponent(data.id)}/candidates`,
    parseCandidates,
  );
  const measurements = useAllObservations(
    `/${encodeURIComponent(data.id)}/measurements`,
    parseMeasurements,
  );
  const inference = inferenceSummary(
    measurements.data?.items ?? [],
    candidates.data?.items ?? [],
  );
  const details = useObservation(
    inference && data.output ? `/${encodeURIComponent(data.id)}/details` : null,
    parseDetails,
    null,
  );
  return (
    <div className="section-stack">
      {inference ? (
        <InferenceReport
          id={data.id}
          resultReferences={details.data?.resultReferences}
          result={data.output}
          measurements={measurements.data!.items}
          candidates={candidates.data?.items ?? []}
        />
      ) : null}
      <div className="overview-metrics">
        <div>
          <span>Duration</span>
          <strong>
            {recordedDuration(
              data.startedAt,
              data.finishedAt ??
                (data.status === 'running' ? data.observedAt : null),
            )}
          </strong>
        </div>
        <div>
          <span>
            {labels.isHarness ? 'Evaluated rounds' : 'Candidate versions'}
          </span>
          <strong>
            {labels.isHarness
              ? measurements.data
                ? new Set(
                    measurements.data.items
                      .map((item) => labels.harness(item.ref)?.round)
                      .filter(Boolean),
                  ).size
                : '—'
              : (candidates.data?.total ?? '—')}
          </strong>
        </div>
        <div>
          <span>
            {usage?.evaluationRuns == null
              ? 'Measurement records'
              : 'Evaluation runs'}
          </span>
          <strong>
            {usage?.evaluationRuns ?? measurements.data?.total ?? '—'}
          </strong>
        </div>
        <div>
          <span>Model calls</span>
          <strong>
            {usage?.modelCalls?.toLocaleString(undefined, {
              maximumFractionDigits: 2,
            }) ?? 'Not recorded'}
          </strong>
        </div>
      </div>
      <Feedback {...candidates} loading={false} />
      <Feedback {...measurements} loading={false} />
      {inference ? null : children}
      <Card>
        <CardHeader>
          <h2>Resource usage</h2>
        </CardHeader>
        <CardContent>
          {usage && Object.keys(usage).length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead>Recorded usage</TableHead>
                  <TableHead>Configured limit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(usage).map(([key, value]) => (
                  <TableRow key={key}>
                    <TableCell>
                      {(
                        {
                          evaluationRuns: 'Evaluations',
                          modelCalls: 'Model calls',
                          operations: 'Operations',
                        } as Record<string, string>
                      )[key] ?? key}
                    </TableCell>
                    <TableCell>
                      <strong>
                        {value.toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })}
                      </strong>
                    </TableCell>
                    <TableCell>
                      {data.limits[key]?.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      }) ?? 'Not specified'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="empty-state">No usage has been recorded.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
