import React, { useState } from 'react';
import { ArtifactBrowser } from './artifact-browser';

export function MeasurementDiagnostics({
  id,
  diagnosticsRef,
}: {
  id: string;
  diagnosticsRef?: string | null;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!diagnosticsRef) return null;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Recorded evaluation diagnostics</summary>
      <p className="muted">
        Saved with this evaluation. The linked call may have been retried since
        then.
      </p>
      {open ? (
        <ArtifactBrowser id={id} artifact={diagnosticsRef} embedded />
      ) : null}
    </details>
  );
}
