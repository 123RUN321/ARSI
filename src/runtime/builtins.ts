import { fileURLToPath } from 'node:url';
import type { Registry } from './registry/index.js';
import { Policy } from './policy/index.js';
import * as applicationAgentbundle from '../plugins/application-agentbundle/index.js';
import * as applicationInference from '../plugins/application-inference/index.js';
import * as agentPi from '../plugins/agent-pi/index.js';
import * as agentClaudeCode from '../plugins/agent-claudecode/index.js';
import * as agentOpenCode from '../plugins/agent-opencode/index.js';
import * as agentDsh from '../plugins/agent-dsh/index.js';
import * as agentCodex from '../plugins/agent-codex/index.js';
import * as proposerAgent from '../plugins/proposer-agent/index.js';
import * as proposerOperator from '../plugins/proposer-operator/index.js';
import * as summarizerOperator from '../plugins/summarizer-operator/index.js';
import * as proposerGrid from '../plugins/proposer-grid/index.js';
import * as proposerOptuna from '../plugins/proposer-optuna/index.js';
import * as proposerParetoEvolution from '../plugins/proposer-pareto-evolution/index.js';
import * as memoryAgent from '../plugins/memory-agent/index.js';
import * as reflectionAgent from '../plugins/reflection-agent/index.js';
import * as evaluatorAgentbench from '../plugins/evaluator-agentbench/index.js';
import * as evaluatorGym from '../plugins/evaluator-gym/index.js';
import * as evaluatorInferencebench from '../plugins/evaluator-inferencebench/index.js';
import * as selectorInference from '../plugins/selector-inference/index.js';
import * as selectorMetrics from '../plugins/selector-metrics/index.js';
import * as selectorArtifacts from '../plugins/selector-artifacts/index.js';
import * as applicationKernel from '../plugins/application-kernel/index.js';
import * as evaluatorOperatorbench from '../plugins/evaluator-operatorbench/index.js';
/** Startup code is the sole built-in registration list. Registration never runs an experiment. */
export async function registerBuiltins(registry: Registry): Promise<void> {
  const plugins = [
    applicationAgentbundle,
    applicationInference,
    agentPi,
    agentCodex,
    agentClaudeCode,
    agentDsh,
    agentOpenCode,
    proposerAgent,
    proposerOperator,
    summarizerOperator,
    proposerGrid,
    proposerOptuna,
    proposerParetoEvolution,
    memoryAgent,
    reflectionAgent,
    evaluatorAgentbench,
    evaluatorGym,
    evaluatorInferencebench,
    selectorInference,
    selectorMetrics,
    selectorArtifacts,
    applicationKernel,
    evaluatorOperatorbench,
  ];
  for (const plugin of plugins) await plugin.register(registry);
  for (const path of [
    'harness2/policy.yaml',
    'wikiskill/policy.yaml',
    'gym-rsi/policy.yaml',
    'operator-search/policy.yaml',
    'parameter/grid/policy.yaml',
    'parameter/optuna/policy.yaml',
    'parameter/agent/policy.yaml',
    'gepa/policy.yaml',
  ]) {
    const file = fileURLToPath(new URL(`../policies/${path}`, import.meta.url));
    const policy = await Policy.load(file, registry);
    registry.registerPolicy(String(policy.id), file);
  }
}
