import type { DoctorContext, DoctorResult } from './doctor.js';
import type { JsonObject } from './json.js';
import type { FactStore } from './runtime/services.js';

/** A binding from a saved Recipe. Its plugin instance may never have started. */
export interface CleanupContext {
  readonly experimentId: string;
  readonly bindingId: string;
  readonly pluginId: string;
  readonly dryRun: boolean;
  readonly dataDirectory: string;
  readonly facts: FactStore;
  readonly signal: AbortSignal;
}

/** Return one result per resource or receipt, and an empty array when none remain. */
export interface CleanupResult {
  key: string;
  status: 'complete' | 'preview' | 'pending';
  report?: JsonObject;
  error?: string;
}

/** Queries owned by a plugin registration and answered once per addressed binding. */
export interface OperationEventMap<C extends JsonObject = JsonObject> {
  'rsi/doctor'(context: DoctorContext<C>): DoctorResult | Promise<DoctorResult>;
  'rsi/cleanup'(
    context: CleanupContext,
  ): CleanupResult[] | Promise<CleanupResult[]>;
}

export interface OperationEvents<C extends JsonObject = JsonObject> {
  on<K extends keyof OperationEventMap>(
    name: K,
    handler: OperationEventMap<C>[K],
  ): void;
}

declare module '@deepseek-ai/cordis' {
  interface Events extends OperationEventMap {}
}
