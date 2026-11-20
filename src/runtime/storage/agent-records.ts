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
  AgentObservation,
  AgentRecord,
} from '../../contracts/models/agent-record.js';

/** One call owns one writer, stored separately from the editable project. */
export class FileAgentRecorder {
  private sequence = 0;
  private descriptor: number | undefined;
  readonly directory: string;
  constructor(callDirectory: string) {
    this.directory = join(callDirectory, 'agent');
    mkdirSync(join(this.directory, 'payloads'), {
      recursive: true,
      mode: 0o700,
    });
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
    const event = { ...observation.event };
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
      // Keep identities and status inline so lazy bodies remain filterable and pairable.
      if ('text' in event) event.text = '';
      if ('thinking' in event) event.thinking = '';
      if ('input' in event) event.input = null;
      if ('output' in event) event.output = null;
    }
    const record: AgentRecord = {
      sequence: this.sequence + 1,
      type: observation.event.type,
      recordedAt: new Date().toISOString(),
      runId: observation.runId,
      ...(observation.native ? { native: observation.native } : {}),
      event,
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
): Promise<{
  items: AgentRecord[];
  nextAfter: number;
  recording: 'open' | 'closed' | 'interrupted';
  total: number;
}> {
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
  let total = 0,
    tail = '',
    interrupted = false;
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
        if (record.sequence > after && items.length < limit) items.push(record);
      }
      if (interrupted) break;
    }
    interrupted ||= tail.length > 0;
  } finally {
    stream.destroy();
    await file.close();
  }
  return {
    items,
    total,
    nextAfter: items.at(-1)?.sequence ?? after,
    recording: interrupted ? 'interrupted' : finished ? 'closed' : 'open',
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

/** Reflection receives the same new records, with lazy payloads resolved for its evidence packet. */
export async function readAgentTrace(callDirectory: string): Promise<string> {
  const file = await open(
    join(callDirectory, 'agent', 'events.jsonl'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const source = await file.readFile('utf8');
    const lines = source
      .slice(0, source.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean);
    const output: string[] = [];
    for (const line of lines) {
      const record: AgentRecord = JSON.parse(line);
      if (record.payload)
        record.event = JSON.parse(
          (await readAgentPayload(callDirectory, record.payload.ref)).toString(
            'utf8',
          ),
        );
      output.push(JSON.stringify(record));
    }
    return output.join('\n') + '\n';
  } finally {
    await file.close();
  }
}
