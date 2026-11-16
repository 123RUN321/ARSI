import {
  createBashToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

/** Native SDK tools retain normal host access; task mode is not a sandbox. */
export function projectTools(directory: string): ToolDefinition[] {
  return [
    defineTool(createReadToolDefinition(directory)),
    defineTool(
      createBashToolDefinition(directory, {
        operations: createLocalBashOperations(),
        exposeSessionEnvironment: false,
      }),
    ),
    defineTool(createEditToolDefinition(directory)),
    defineTool(createWriteToolDefinition(directory)),
  ];
}
