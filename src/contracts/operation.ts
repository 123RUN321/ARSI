import type { JsonObject, JsonSchema, JsonValue } from './json.js';
import type { PluginContract } from './contract.js';
import type { RuntimeContext } from './runtime/context.js';
import type { DoctorContext, DoctorResult } from './doctor.js';

/** A concrete plugin uses the input and output types owned by its public contract. */
export interface Operation<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
> {
  execute(input: I, context: RuntimeContext): Promise<O>;
  dispose(): Promise<void>;
}
/** C describes supplied configuration; fields with Schema defaults may be optional. */
export interface OperationDefinition<
  I extends JsonValue = JsonValue,
  O extends JsonValue = JsonValue,
  C extends JsonObject = JsonObject,
> {
  id: string;
  description?: string;
  implementationDigest?: string;
  contract: PluginContract;
  configSchema: JsonSchema;
  /** Optional diagnostic capability, called only by doctor with validated effective configuration. */
  doctor?(context: DoctorContext<C>): Promise<DoctorResult>;
  create(config: C, context: RuntimeContext): Promise<Operation<I, O>>;
}
