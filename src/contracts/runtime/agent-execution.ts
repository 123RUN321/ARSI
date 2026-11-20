import type { JsonValue } from '../json.js';

export interface AgentProcessSpec {
  executable: string;
  args: string[];
  input: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
}
export type AgentLineHandler = (
  line: string,
  send: (message: JsonValue) => void,
) => void | boolean | Promise<void | boolean>;
export type AgentProcessLauncher = (
  spec: AgentProcessSpec,
  onLine: AgentLineHandler,
) => Promise<void>;
