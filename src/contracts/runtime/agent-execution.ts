export interface AgentProcessSpec {
  executable: string;
  args: string[];
  input: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
}
export type AgentLineHandler = (
  line: string,
  send: (message: unknown) => void,
) => void | boolean | Promise<void | boolean>;
export type AgentProcessLauncher = (
  spec: AgentProcessSpec,
  onLine: AgentLineHandler,
) => Promise<void>;
export interface AgentLaunchScope {
  directory: string;
  project: string;
  signal: AbortSignal;
}
