import React from 'react';
import { parseExperiments } from '../../api/observation-client';
import { route } from '../../app/routing';
import { useRoute, replaceRouteSelection } from '../../app/use-route';
import {
  Feedback,
  Pagination,
  Status,
  Timestamp,
} from '../../components/observation-feedback';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { useObservation } from './use-observation';
export function Experiments(): React.JSX.Element {
  const location = useRoute();
  const offset = location.offset ?? 0,
    search = location.search ?? '',
    policy = location.policy ?? '';
  const setOffset = (value: number): void =>
    replaceRouteSelection({ offset: value });
  const query = new URLSearchParams({ offset: String(offset) });
  if (policy) query.set('policy', policy);
  const result = useObservation(`?${query}`, parseExperiments);
  const visible = result.data?.items.filter((entry) =>
    `${entry.id} ${entry.recipeId ?? ''} ${entry.status}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <h1>Experiments</h1>
        </div>
      </header>
      <div className="chart-controls">
        <label htmlFor="policy-filter">
          Policy
          <select
            id="policy-filter"
            value={policy}
            onChange={(event) =>
              replaceRouteSelection({ policy: event.target.value, offset: 0 })
            }
          >
            <option value="">All policies</option>
            {policy && !result.data?.policies.includes(policy) ? (
              <option value={policy}>{policy}</option>
            ) : null}
            {result.data?.policies.map((ref) => (
              <option key={ref} value={ref}>
                {ref}
              </option>
            ))}
          </select>
        </label>
        <div className="search-field">
          <label htmlFor="search">Filter this page</label>
          <Input
            id="search"
            value={search}
            onChange={(event) =>
              replaceRouteSelection({ search: event.target.value })
            }
            placeholder="Experiment, recipe, or status"
          />
        </div>
        <span className="muted">
          {search ? `${visible?.length ?? '—'} matches on this page · ` : ''}
          {result.data?.total ?? '—'} experiments
        </span>
      </div>
      <Feedback {...result} />
      {result.data ? (
        <Card>
          <CardContent>
            {visible?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Experiment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Recipe</TableHead>
                    <TableHead>Policy</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>
                        <a className="text-link" href={route(entry.id)}>
                          {entry.id}
                        </a>
                      </TableCell>
                      <TableCell>
                        <Status value={entry.status} />
                      </TableCell>
                      <TableCell>{entry.recipeId ?? 'Not recorded'}</TableCell>
                      <TableCell>{entry.policyRef ?? 'Not recorded'}</TableCell>
                      <TableCell>
                        <Timestamp value={entry.startedAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="empty-state">
                <h2>
                  {search
                    ? 'No matching experiments on this page'
                    : policy
                      ? 'No experiments for this policy'
                      : 'No experiments recorded'}
                </h2>
                <p>
                  {search
                    ? 'Change the filter or browse another page.'
                    : policy
                      ? 'Select another policy or All policies.'
                      : 'Experiments started through your existing workflow will appear here.'}
                </p>
              </div>
            )}
            <Pagination
              page={result.data}
              offset={offset}
              setOffset={setOffset}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
