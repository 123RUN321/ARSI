import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import type {
  AgentManifest,
  AgentObservation,
  AgentRecord,
  AgentRecorder,
  AgentRecordPage,
} from '../../contracts/models/agent-record.js';

/** One call owns one writer, stored separately from the editable project. */
export class FileAgentRecorder implements AgentRecorder {
  private sequence = 0;
  private descriptor: number | undefined;
  readonly directory: string;
  constructor(callDirectory: string, manifest: AgentManifest) {
    this.directory = join(callDirectory, 'agent');
    mkdirSync(join(this.directory, 'payloads'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(this.directory, 'manifest.json'),
      JSON.stringify(manifest) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    this.descriptor = openSync(
      join(this.directory, 'events.jsonl'),
      'wx',
      0o600,
    );
  }
  record(observation: AgentObservation): void {
    if (this.descriptor === undefined)
      throw new Error('Agent record is closed');
    const text = JSON.stringify(observation.event);
    let payload: AgentRecord['payload'] = null;
    if (Buffer.byteLength(text) > 8192) {
      const ref = createHash('sha256').update(text).digest('hex');
      const bytes = Buffer.from(text);
      // Identical content is immutable and may be referenced more than once.
      const path = join(this.directory, 'payloads', ref);
      let file: number;
      try {
        file = openSync(path, 'wx', 0o600);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
          )
        )
          throw error;
        file = -1;
      }
      if (file !== -1) {
        try {
          writeFileSync(file, bytes);
          fsyncSync(file);
        } finally {
          closeSync(file);
        }
      }
      payload = { ref, bytes: bytes.length };
    }
    const record: AgentRecord = {
      sequence: this.sequence + 1,
      type: observation.event.type,
      ...(observation.event.type === 'run.finished'
        ? { terminal: observation.event.status }
        : {}),
      recordedAt: new Date().toISOString(),
      runId: observation.runId,
      ...(observation.native ? { native: observation.native } : {}),
      event: payload ? null : observation.event,
      payload,
    };
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    writeFileSync(this.descriptor, bytes);
    this.sequence++;
  }
  close(): void {
    if (this.descriptor === undefined) return;
    const file = this.descriptor;
    this.descriptor = undefined;
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
  }
}

export async function readAgentRecords(
  callDirectory: string,
  after: number,
  limit: number,
  finished: boolean,
): Promise<AgentRecordPage & { total: number; terminalStatus?: string }> {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error('Invalid agent record cursor');
  const file = await open(
    join(callDirectory, 'agent', 'events.jsonl'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const items: AgentRecord[] = [];
  let terminalStatus: string | undefined;
  let total = 0,
    tail = '',
    interrupted = false,
    terminal = false;
  const stream = file.createReadStream({ autoClose: false, encoding: 'utf8' });
  try {
    for await (const chunk of stream) {
      tail += chunk;
      let end: number;
      while ((end = tail.indexOf('\n')) !== -1) {
        const line = tail.slice(0, end);
        tail = tail.slice(end + 1);
        let record: AgentRecord;
        try {
          record = JSON.parse(line);
        } catch {
          interrupted = true;
          break;
        }
        if (record.sequence !== total + 1) {
          interrupted = true;
          break;
        }
        total = record.sequence;
        terminal = record.type === 'run.finished' && record.runId === 'main';
        if (terminal) terminalStatus = record.terminal;
        if (record.sequence > after && items.length < limit) items.push(record);
      }
      if (interrupted) break;
    }
    interrupted ||= tail.length > 0 || (finished && !terminal);
  } finally {
    stream.destroy();
    await file.close();
  }
  return {
    items,
    total,
    terminalStatus,
    nextAfter: items.at(-1)?.sequence ?? after,
    recording: interrupted ? 'interrupted' : terminal ? 'closed' : 'open',
  };
}

export async function readAgentPayload(
  callDirectory: string,
  ref: string,
): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(ref))
    throw new Error('Invalid agent payload reference');
  const file = await open(
    join(callDirectory, 'agent', 'payloads', ref),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const bytes = await file.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== ref)
      throw new Error('Agent payload digest mismatch');
    return bytes;
  } finally {
    await file.close();
  }
}

/** Full content is streamed on demand; the caller owns destroying the stream. */
export async function streamAgentPayload(
  callDirectory: string,
  ref: string,
): Promise<import('node:fs').ReadStream> {
  if (!/^[a-f0-9]{64}$/.test(ref))
    throw new Error('Invalid agent payload reference');
  const file = await open(
    join(callDirectory, 'agent', 'payloads', ref),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile())
      throw new Error('Agent payload must be a regular file');
    return file.createReadStream({ autoClose: true });
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function readAgentManifest(
  callDirectory: string,
): Promise<AgentManifest> {
  const file = await open(
    join(callDirectory, 'agent', 'manifest.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}
