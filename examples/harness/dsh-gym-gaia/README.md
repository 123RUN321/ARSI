# DSH AgentBundle on Gym GAIA: train_full search plus holdout release

This example connects ember-rsi to Gym `eval_service` and keeps two decisions
separate:

- **Search:** RSI measures candidates on Gym's `train_full` split, using
  task-disjoint `trainTaskIds` and `validationTaskIds`. Validation rejects a
  strictly worse proposal; a tie advances the candidate to the holdout gate.
- **Release:** after search freezes its final candidate, `release.gym` asks Gym
  to evaluate that bundle and the original incumbent on the locked `holdout`
  split, then promotes only on strict improvement.

RSI never receives holdout task IDs, cannot submit `holdout` through
`evaluator.gym`, and never writes the holdout result into Wiki memory,
proposer evidence, or candidate selection.

## End-to-end flow

1. RSI materializes the baseline or proposed AgentBundle and acquires a ready
   execution. It sends the materialized directory, bundle digest and bundle
   kind to Gym; it does not install the bundle into DSH.
2. `evaluator.gym` submits a `train_full` evaluation to Gym
   `POST /gym_evaluate` with `candidate_dir`, `candidate_digest` and
   `candidate_kind`.
3. Gym core validates the candidate path and declared kind, then the
   `dsh_candidate` adapter installs the bundle into a run-local DSH home and
   runs the rollouts. Gym returns reward metrics plus harness/environment
   identity.
4. WikiSkill updates its Wiki from training evidence, proposes a candidate,
   and compares the proposal with the incumbent on the pinned validation
   tasks. A strictly worse proposal is rejected; a tie advances the candidate
   to the holdout gate.
5. When the search loop ends, `release.gym` calls Gym `POST /promotion` with
   the frozen candidate directory, digest and kind. The request also carries
   `candidate_id`, adapter, benchmark and seed; it cannot express `split` or
   `task_ids`.
   If validation rejected every proposal, the frozen candidate is still the
   original incumbent. `release.gym` then writes a `keep-incumbent` audit
   artifact without calling `POST /promotion`; a bundle is never compared with
   itself on holdout.
6. `release.gym` polls `GET /promotion/{promotion_id}` until the holdout report
   is terminal. Gym serializes these runs, and a bundle+benchmark report is
   reused rather than executed twice.
7. `release.gym` repeats the same flow for the original incumbent, compares
   the two completed reports, and writes a release artifact. The decision is
   `promote`, `keep-incumbent` or `reject`; no shared profile is mutated.

The Policy output records `searchCandidateRef`, `effectiveRef`,
`releaseDecision`, `releaseReason` and `releaseRef`. `searchCandidateRef` is
the best validation candidate; `effectiveRef` is the candidate selected by the
release gate (the incumbent when release keeps it), not a runtime-activation
record. The release artifact contains aggregate scores and
environment identities, but not holdout task rows. The policy ends after
release, so these values cannot feed another search round.

## Harness and candidate contract

The Gym-RSI core is harness-agnostic. `evaluator.gym` and `release.gym` send
the same three candidate fields on every request:

| Field              | Meaning                                                       |
| ------------------ | ------------------------------------------------------------- |
| `candidate_dir`    | Absolute path to a ready, materialized AgentBundle directory. |
| `candidate_digest` | The bundle digest used as the immutable candidate identity.   |
| `candidate_kind`   | The `bundle.yaml.kind` value, for example `dsh-agent-bundle`. |

RSI never publishes into a harness-specific location. Gym core checks that the
directory is absolute, exists, is outside the Gym overlay, and contains a
`bundle.yaml` whose `kind` matches the request. It then checks that the selected
adapter declares the kind in `supported_bundle_kinds`. Gym validates the
`candidate_digest` format only; RSI computes the content digest. `POST /promotion`
requires `candidate_dir`, `candidate_digest` and `candidate_kind`, and rejects
`budget.max_rollouts`. `eval_service` copies the
candidate identity into every input row as `agent_candidate`, so a long-running
head can install a different bundle for each evaluation. The adapter reads that
row field in its `/run` request.

The `dsh_candidate` adapter owns all DSH knowledge. It copies the candidate to
`<workspace_root>/rsi-candidate-home/candidates/<digest>`, builds a run-local home at
`<workspace_root>/rsi-candidate-home/homes/<identity>`, copies the host `profiles/headless`
profile, links the host `node_modules`, links the candidate plugins into the
profile, and merges `GYM_DSH_BASE_PATCH` with the candidate patch. It writes
`.rsi-gym-install.json` and `.rsi-gym-candidate-ready` inside that run-local
home and starts DSH with `DSH_HOME` pointing at it. These are adapter-local
installation/idempotency records, not host activation state.

For AgentBundle kinds already registered by `agent-bundle-core`, switching the
recipe changes `requestDefaults.adapter` / `promotionDefaults.adapter` to a Gym
adapter that supports that kind. It does not change `evaluator.gym`,
`release.gym`, `policy.gym-rsi`, `application.agentbundle`, or the selector. A
new harness needs a Gym-side adapter that consumes the per-request
`agent_candidate` row. A genuinely new kind must first be registered in
`agent-bundle-core`; the SDK currently validates a fixed kind set.

## Search versus release

| Stage               | Gym split    | Tasks                  | Decision owner        |
| ------------------- | ------------ | ---------------------- | --------------------- |
| Baseline            | `train_full` | `validationTaskIds`    | WikiSkill selector    |
| Training evidence   | `train_full` | `trainTaskIds`         | WikiSkill/Wiki memory |
| Proposal validation | `train_full` | `validationTaskIds`    | WikiSkill selector    |
| Final release       | `holdout`    | Gym-owned locked split | `release.gym`         |

`policy.config.dataset` therefore contains only RSI-owned task subsets:

- `trainTaskIds` supplies training evidence to WikiSkill.
- `validationTaskIds` independently gates each proposal against the incumbent.
- `testTaskIds` is empty because Gym owns the release split.

Both lists in `recipe.yaml` are disjoint subsets of Gym's `train_full` split.
No holdout task ID may appear in any RSI list. The example pins thirty-six
training tasks and twelve validation tasks; RSI still
evaluates them under `split: train_full`, not `train_probe`.

Validation intentionally uses text-only tasks; video URL tasks are excluded
because YouTube retrieval is environment-dependent. Additional network-heavy
validation tasks are excluded when they can exhaust the DSH timeout.
The University of Leicester fish-bag task is also excluded from training because
it requires downloading an external paper and can stall in network-isolated runs.

`maxRounds: 1` demonstrates one complete mutation and selection round. The policy
schema defaults to three rounds, but this recipe explicitly overrides it to one;
raise it for a longer search. `tier: full` is the search-side Gym rollout budget
and runs the pinned 36-task slice at concurrency 12 with one repeat;
`release.gym` always requests Gym's `full` tier for holdout. It compares
effective `successRate` by default; set `metric: meanReward` when a dense-reward
benchmark should use Gym's `reward_mean` objective instead.

The GAIA profile's `full` tier caps 64 task rows with one repeat per task.
The locked 26-row holdout therefore produces 26 rollouts.

## Prerequisites

- Node.js 24 and pnpm 11.22.0 for ember-rsi.
- A built DSH CLI and a host `DSH_HOME` containing the `headless` profile and
  its `node_modules`.
- Gym's GAIA data and `eval_service/profiles/rsi_v1_gaia.yaml`.
- Model credentials for the RSI agent and for the DSH agent under evaluation.
- A Linux or WSL host with the Gym runtime available.
- Both RSI and `eval_service` on the same loopback host. Gym's promotion
  control plane is loopback-only and is not registered as an MCP tool.

Set these variables in the Gym shell:

```bash
export DSH_HOME=$HOME/.dsh
export GYM_DSH_COMMAND=dsh
export GYM_DSH_HOST_HOME=$DSH_HOME
export GYM_DSH_BASE_PATCH=$DSH_HOME/rsi-gym-base.patch.yml
export GYM_DSH_WORKSPACE_ROOT=$HOME/rsi-runs/gaia-dsh-work
export GYM_DSH_TIMEOUT_S=300
export RUN_ROOT=$HOME/rsi-runs/gaia-train-full
mkdir -p "$RUN_ROOT"
```

Set these variables in the RSI shell:

```bash
export GYM_BASE_URL=http://127.0.0.1:8399
```

`GYM_DSH_BASE_PATCH` is a host-owned DSH patch list read by the Gym adapter.
Put model-provider, credential-reference, and search-route entries there. The
adapter merges this list before the candidate's patch while building the
run-local profile, so a candidate cannot silently remove the host's model
route. Start from a known working profile layer and keep the file outside
`profiles/<name>/`:

```bash
cp $DSH_HOME/profiles/headless/cordis.patch.yml $GYM_DSH_BASE_PATCH
```

Set the RSI proposer credentials in the RSI shell:

```bash
export MODEL_NAME=...
export MODEL_ENDPOINT=...
export MODEL_API_KEY=...
```

## 1. Start Gym

From the Gym repository root:

```bash
export GYM_ENV_CONFIGS=benchmarks/gaia/config_dsh.yaml,responses_api_agents/dsh_agent/configs/rsi_dsh_candidate.yaml
gym env start "+config_paths=[$GYM_ENV_CONFIGS]"

python -m eval_service.server \
  --profile-path eval_service/profiles/rsi_v1_gaia.yaml \
  --results-root "$RUN_ROOT/results" \
  --ledger-path "$RUN_ROOT/ledger.json" \
  --reports-root "$RUN_ROOT/reports" \
  --host 127.0.0.1 \
  --port 8399
```

Keep this shell running. `/gym_evaluate` accepts only `train_probe` and
`train_full`; a direct `holdout` request is rejected with `HOLDOUT_LOCKED`.
`POST /promotion` is enabled by default but accepts only loopback clients.

## 2. Run RSI train_full evolution and release

From the ember-rsi repository root:

```bash
ember-rsi validate examples/harness/dsh-gym-gaia/recipe.yaml
ember-rsi run examples/harness/dsh-gym-gaia/recipe.yaml
```

The run blocks through the final release gate. Search-side calls use
`train_full`; only `release.gym` reaches Gym's holdout promotion endpoint.

At the end, inspect the Policy output for `searchCandidateRef`, `effectiveRef`
(the candidate selected by the release gate), `releaseDecision`,
`releaseReason` and `releaseRef`. The referenced artifact
records:

- candidate and incumbent candidate/digest identities;
- both promotion ids and terminal report states;
- aggregate `reward_mean`, rollout counts and the strict-improvement delta;
- harness manifest, environment, evaluation, profile and dataset identities.

It does not contain holdout task rows or per-task answers. The two holdout
reports must share environment identity; otherwise `release.gym` returns
`reject` rather than comparing incomparable scores.

## Observability and recovery

Gym writes promotion reports under `$RUN_ROOT/reports`. `POST /feedback` only
reads a candidate's latest verdict and ledger summaries; it does not trigger a
holdout rollout. `POST /promotion` is the only holdout trigger used by the RSI
flow.

If an RSI process is interrupted during release, rerun it. Gym keys a promotion
by candidate digest, benchmark, adapter, tier, and evaluation digest. The seed
is recorded in the report but excluded from the one-shot key, so changing it
cannot buy another holdout run. An already completed report is reused instead
of spending a second holdout run.

## Guardrails

- RSI's evaluator schema accepts only `train_probe` and `train_full`.
- `release.gym` cannot express a split or task IDs; Gym always evaluates the
  complete locked holdout split.
- Promotion is loopback-only and is not an MCP tool.
- The DSH adapter writes its run-local installation record and readiness marker
  atomically before starting DSH. Gym validation and holdout identity are
  carried by the request and `agent_candidate` row, not by a sidecar.
- Holdout output is terminal evidence only. It must not be written back into
  Wiki memory, proposer evidence, training summaries, or search selection.
- Validation ties advance the candidate to release; only a strictly worse
  proposal is rejected during search.
- At release, a candidate must strictly exceed the incumbent by `minDelta`
  (default `0`) on the configured `metric` (`successRate` by default). Ties
  keep the incumbent.
