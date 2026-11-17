# Unified Agent execution and conversation observation

Date: 2026-11-17. Scope: PR62.

## Scope and ownership

The framework provides execution ownership and a common conversation view for Pi,
Codex, DSH, Claude Code, and OpenCode. It does not change how business plugins
propose or apply edits. This document supersedes the earlier PR62 direct-editing
proposal retained in Git history.

An ordinary Agent plugin implements the existing Agent contract with `execute`
and `dispose`. Registration automatically installs execution observation and
output validation. No new plugin hooks, capability declarations, or lifecycle
implementations are required. Optional backend decoders supply richer native
messages, tools, usage, and child sessions; absent detail is an observation gap.

| Owner           | Responsibility                                                              |
| --------------- | --------------------------------------------------------------------------- |
| Registry        | Automatically wrap every Agent operation                                    |
| Runtime         | Execution deadline, cancellation, process ownership, output validation      |
| Manager         | Authoritative call input, output, status, budgets, and retry admission      |
| Backend adapter | Native protocol, configuration, output extraction, optional detail decoding |
| Business plugin | Prompt, result Schema, JSON edits, proposal batches                         |
| Application     | Validate and commit accepted candidate changes                              |
| Web             | Read public observation queries and render normalized records               |

## Execution and configuration

CLI adapters use `RuntimeContext.runAgentProcess`. POSIX process groups and
Windows Job Objects own native processes and descendants through completion,
failure, and cancellation. Pi uses its SDK in process and shares the caller's
budget. Internal Pi delegation creates native child sessions, not extra Runtime
calls. A child inherits both parent cancellation and the SDK tool's cancellation
signal. Cancelled children cannot return a late successful result.

Native model/auth configuration, hooks, MCP, and retry behavior remain available.
The framework does not introduce tool restrictions, sandbox configuration, or an
RSI model-output correction loop. Unsupported CLI `role` dispatch is rejected
before launch; delegation uses the native backend's mechanism. Pi supports its
project role tool directly. DSH retains its original task instructions and final
JSON reminder.

Whole-call deadlines belong to binding `execution`, outside a plugin's config:

```yaml
agent:
  plugin: agent.pi
  execution:
    timeoutMs: 1800000
  config:
    timeoutMs: 600000
```

`execution.timeoutMs` bounds the whole operation; Pi's `config.timeoutMs` bounds
one model request. Both are optional. `1800000` is not a framework requirement or
a newly imposed default: examples move their existing total deadline unchanged.
A plugin does not declare or consume the execution Schema. Binding resolution,
serialization, overrides, and revision restoration retain execution settings.

## Result and observation contracts

`AgentInput` remains `{ goal, cwd, role?, outputSchema }`; the output remains a
JSON object validated against the caller's Schema. A proposer can return several
proposals from one Agent call. Each proposal retains the existing JSON edits
protocol and is applied independently to the same parent candidate. No direct
file-edit output protocol, Application lifecycle changes, or proposal loop is
introduced.

The Manager receipt owns root call input, result, and status. Optional
`rsi/agent-observation` events carry native messages, tools, usage, child-session
relationships, and gaps. The framework records an explicit coverage gap even for
plugins that emit no native events. Native child sessions are represented by
`runId`/`parentRunId`, not invented Runtime receipts or fabricated usage.

Records live under the call's `agent/events.jsonl`; large payloads are stored
separately and loaded on demand. Content is retained without adding redaction.
Malformed optional observations become gaps and do not fail execution. Storage
failures abort the call rather than report an unrecorded success. Final result
parsing and Schema validation remain execution failures when invalid.

A safely admitted retry archives the previous receipt and the complete Agent
record directory under a unique attempt identity before creating a new journal.
Unknown outcomes and refused retries retain their original evidence. No reader
for historical trace formats, migration layer, or dual-write path is added.
Existing experiment data is left in place.

The Web pairs tools by run and tool-call ID. Known start/end timestamps produce
elapsed seconds; missing or invalid timestamps leave duration unknown. Parallel
native children remain distinct even when tool IDs coincide.

## Verification

Verification uses temporary resources, deterministic native protocol fixtures,
and local simulated model endpoints. It covers cancellation, role validation,
native errors, retries and budgets, compaction, JSON validation, proposal batches,
record archival, and tool duration rendering. These checks do not establish
real-model quality or full live coverage of each CLI version.

Actual checks on Node 24.22.2 / macOS:

- Formatting, backend and Web type checks, and backend/Web builds passed.
- The full serial run completed 899 tests: 892 passed, 5 skipped, and 2 failed.
  Both failures are the existing retrieval descendant-success/descendant-exit
  cleanup cases (`kill EPERM`), previously reproduced on unchanged upstream
  commit `7f31d7a6fd630f2341f476563b9f000d98f2c60d`. Their implementation and tests
  are unchanged by this PR. The restored disposal case added after that full
  run is also covered by the final focused run.
- Final focused regression results: 91 tests passed, including the restored disposal case.
- Native macOS protocol, cancellation, and descendant cleanup acceptance passed.
- Independent tarball installation, public consumer interfaces, SDK integration,
  and packaged Windows resources passed.

Docker remains paused. Linux acceptance is pending revalidation; Windows is
implemented and packaged, with native Windows acceptance pending.
