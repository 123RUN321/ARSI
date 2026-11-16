# Evaluator operational scheduling

An experiment can retain its locked Recipe, checkpoints and completed SDK task
records while using different local scheduling limits. Set all three variables
in the experiment worker's own environment:

```text
RSI_EVALUATOR_CONCURRENCY=16
RSI_EVALUATOR_PREPARATION_CONCURRENCY=16
RSI_EVALUATOR_SCHEDULING_REASON=operator-approved change reference
```

The AgentBench adapter passes these as explicit SDK scheduling options. Both
counts must be positive safe integers and the reason must be nonempty. The SDK
must advertise scheduling override API version 1; otherwise the call fails
before evaluation. Each call records a separate scheduling receipt. Its original
evaluation configuration and the native resume checks remain intact.

These variables do not alter the model, task split, retry policy, configured
timeout bases or the experiment's elapsed-time budget. They do not provide
resource admission or make a requested concurrency safe for a particular host.
