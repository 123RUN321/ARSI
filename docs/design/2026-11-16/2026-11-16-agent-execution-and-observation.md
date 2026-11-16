# Agent execution and observation

Date: 2026-11-16

Status: Implemented with initial macOS/Linux acceptance. Native Windows execution
acceptance remains pending. Design requirements and verified evidence are
recorded separately.

## Goal and current scope

Unify Pi, Codex, Claude Code, DSH and OpenCode task execution and recorded
conversations. Borrow Multica's separation of native protocols from unified
messages, without copying its source or adopting product-specific protocols.

The user's latest scope decision supersedes the earlier sandbox/worker proposal:

- No sandbox or related filesystem/native permission restrictions for any backend
  in this release. Do not retain an unused isolation framework or dependency.
- Pi remains an in-process SDK integration. No worker or budget/event IPC.
- Native CLIs retain explicit process ownership, timeout, cancellation and cleanup
  on macOS, Linux and Windows. These are lifecycle responsibilities, not sandboxing.
- Keep structured result validation and Application candidate validation.
- Preserve existing experiment data without migration, deletion or legacy readers.
- Keep five public plugin IDs and backend-owned configuration schemas.
- Native agents own models, tools, skills, delegation and native retries.
- Direct editing uses the actual candidate workspace, never JSON edits replay.
- Sessions last for one RSI call; native children form its internal run tree.
- Validate final structured output once, without corrective prompts.
- Reject unsupported required execution capabilities and applicable hard budgets.
- Missing observation capabilities never prevent ordinary execution. A record
  storage failure stops execution and prevents accepting its result.
- Save backend-provided content without redaction. Do not collect unrelated
  credentials, environment dumps or private configuration merely for tracing.
- No interactive approval UI, automatic backend fallback, cross-call continuation,
  network proxy service, or compatibility with old experiments.

## Ownership

| Owner                              | Responsibility                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Agent contract                     | Task, project reference, analyze/edit intent, output schema and required execution capabilities |
| Backend plugin                     | Native configuration, protocol exchange and event conversion                                    |
| Shared runner                      | Single-call lifecycle, cancellation, final result validation and recording coordination         |
| Runtime project/workspace services | Project identity, execution lease, storage and resource ownership                               |
| Runtime CLI process host           | Launch, bounded diagnostics, stdio backpressure, timeout/cancel and descendant cleanup          |
| Runtime record storage             | Ordered durable records, payload files and ownership-checked reads                              |
| Application                        | Freeze the edited workspace, validate its snapshot and request candidate registration           |
| Manager                            | Call receipts, budgets and candidate facts                                                      |
| Dashboard                          | Backend-independent projection of recorded facts                                                |

Analyze/edit is task intent, not a security boundary. Native execution retains
ordinary host access. Application validates only the candidate it accepts; this
must not be described as protection against arbitrary host side effects.

## Public interfaces

```ts
interface AgentInput {
  goal: string;
  projectRef: string;
  mode: 'analyze' | 'edit';
  outputSchema: JsonObject;
  requirements?: { delegation?: boolean };
}
type AgentOutput = JsonObject;
```

A project reference identifies a Runtime workspace whose candidate directory is
also its Application editRef. Project metadata records its owning call and input
artifact. The project contains candidate/, context/, instructions, skills and
scratch/. The business caller owns project release; an Agent call owns an
exclusive execution lease. A lease with an unknown execution outcome prevents
commit or release until reconciled.

Application commit keeps parentCandidateRef/editRef/editConstraints. Agent success
and candidate acceptance are distinct facts. Memory and Reflection capture actual
resource snapshots and before/after differences, without application candidates.
Proposer batches use independent projects/calls per candidate. Remove model edits
expansion, replay and merging rather than keeping parallel mutation sources.

## Backend interfaces

Each plugin supplies its native session implementation to the shared runner. The
runner supplies the project directory, AbortSignal, normalized event recorder,
Runtime charge interface and, for native backends, the process launcher.

Execution capabilities cover editing, native delegation and enforceable model-call
limits. Observation capabilities cover message/tool/thinking/child coverage and
are separate from execution requirements. Native token usage is not an accurate
upstream modelCalls counter. Pi awaits Runtime charge before each model request,
including native retries and compaction, through an ordinary in-process call.

Native configuration and login stay owned by each CLI. Do not copy/filter personal
configuration or impose tool allowlists as part of this release. Task projects
still provide their explicit instructions, skills and roles.

## Lifecycle

1. Validate task/configuration and supported execution requirements.
2. Check applicable hard budgets; acquire the project execution lease.
3. Open records and start the SDK session or native process.
4. Convert native observations into the common event model and persist them.
5. Receive a native completed result and settle owned execution.
6. Validate the final output schema once.
7. Flush records before publishing Agent success.
8. Release execution resources. Business callers can commit/capture the edited
   workspace and then release the project.

Known cancellation, failure and unknown stop outcomes remain distinct. Do not
retry an uncertain external effect or claim cancellation reverses remote effects.
A missing observation is not a failed task. Failed record persistence is an
infrastructure failure, not ordinary user cancellation.

## Observation protocol

Each record has Runtime sequence, recordedAt, internal runId, optional native
session/turn/item identity, and a discriminated event:

- run.started: backend and parent run;
- message.appended: native message text delta;
- message.completed: authoritative text, visible thinking, role and phase;
- tool.started/tool.completed: stable tool ID, input/output and status;
- usage.reported: native statistic ID, scope, cumulative/incremental meaning;
- observation.gap: explicit unavailable/truncated/interrupted content;
- run.finished: execution outcome, not candidate acceptance.

Pair tools by run and ID. Final message snapshots replace accumulated deltas.
Never invent start times or infer success from a final-looking message. Native
children have an internal parent relationship, not fabricated Runtime receipts.
If a backend cannot provide a child's terminal event, show unavailable coverage
rather than treating that child as known to be running indefinitely.

## Storage and query

Use calls/<callId>/agent/manifest.json, events.jsonl and payloads/. One writer
assigns sequences. Persist payloads before referring to them. Full supplied
content is stored independently of UI previews and is loaded on demand.

Queries validate experiment/call ownership before reading manifests, event pages
or payloads. Scan event records without loading the whole log into memory; no
fixed 4 MiB prefix. An incomplete trailing line is not a valid event. UI polling
uses recorded sequences and reconciles final snapshots without duplicate text.
No diagnostics.jsonl compatibility reader is retained.

If final recording fails, the success receipt must not be published. Incomplete
records are visible as interrupted. A failed disk write cannot be presumed to
have durably stored its own terminal error. Call receipt state remains the
external authority when recording status and execution status differ.

## CLI process host

Launch executable/argument arrays without shell interpolation. Resolve Windows
npm shims to a supported native executable or Node entrypoint. Drain stderr with
a bounded failure summary; do not archive raw stderr or configuration wholesale.
Pause stdout while asynchronous protocol handling is pending.

POSIX calls own a process group. Windows calls must own/track descendants so a
parent exit is not mistaken for successful tree cleanup. Propagate cancellation,
wait for pipe/handler settlement, and report an unknown stop when cleanup cannot
be confirmed. No process-host fallback switches backend or starts a new task.

## Modules and replacement plan

- contracts/models/agent-record.ts: shared observation types and transport schema;
- contracts/plugin-types/agent.ts: the sole Agent input/output contract;
- contracts/runtime/agent-execution.ts: native process launch interface;
- runtime/services/agent-execution/: CLI lifecycle implementation;
- runtime/storage/agent-records.ts: append writer and query readers;
- plugins/shared/agent-backend/: shared SDK/CLI call coordination;
- plugins/agent-\*/observations.ts: native event conversion;
- plugins/shared/agent-editing/: project assembly and direct resource editing;
- web/features/experiments/: common timeline and on-demand payload display.

Remove old cwd/role Agent inputs, per-plugin diagnostic writers, Pi corrective
prompts, Runtime-recursive Pi delegation, JSON edits replay/merge and Pi-only UI
filters. Do not change unrelated Runtime/Policy/Evaluator responsibilities.

## Verification and actual evidence

Acceptance covers five backend protocol fixtures, final JSON failure, real Pi SDK
with a local simulated model, shared budgets, cancellation, child attribution,
long records and payload ownership, record failures, direct workspace handoff,
Application validation and the Dashboard query/projection path.

Implement native CLI lifecycle on macOS/Linux/Windows. Initially validate macOS
and Linux; explicitly mark Windows execution acceptance as pending until run.
Do not start real model experiments merely to run deterministic checks.

Implemented and verified on 2026-11-16:

- TypeScript checks for backend and Web pass; repository formatting passes.
- Complete macOS deterministic suite: 805 tests, 798 passed, 5 platform skips,
  2 failures in the existing retrieval-worker descendant cleanup cases. Both
  failures reproduce on unmodified HEAD with the same `kill EPERM` cause.
- Final focused macOS acceptance: 36 tests passed, including all five backend
  fixtures, real in-process Pi SDK with a local simulated model, model budgets,
  cancellation, unknown leases, recording failures and Dashboard projections.
- Linux Node 24 container: 15 tests passed using compiled source, local SDK
  dependencies and a simulated model. Coverage includes all four CLI protocol
  fixtures, real Pi SDK edits/budgets/cancellation, record storage and Dashboard
  queries. No real model service was called.
- The ordinary Node process probe passes on macOS and Linux: protocol,
  cancellation and descendant cleanup. The Linux container has no extra
  capabilities or privileged mode.
- Windows executable resolution and literal argv serialization are checked on
  macOS. Native Windows Job Object execution is not yet accepted.

Independent package-consumer verification passes: isolated tarball installation, public contracts/types, managed project creation/delegation, packaged Windows .ps1/.cs resources, SDK integration, operator direct editing, cleanup and completed resume. Existing
experiment data and the shared Dashboard service have not been migrated,
deleted, or restarted. Earlier sandbox probes are outside this release scope.

## References

- [Agent contract](../../../src/contracts/plugin-types/agent.ts)
- [Application contract](../../../src/contracts/plugin-types/application.ts)
- [Application lifecycle](../../../src/plugins/shared/file-application/files.ts)
- [Multica message model](https://github.com/multica-ai/multica/blob/7f93210318880dac49c26828d9a9018108fc28df/server/pkg/agent/agent.go)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Claude Code programmatic execution](https://code.claude.com/docs/en/headless)
- [DSH headless](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless)
