import type { RunEventSource, RunStreamRecord } from "../run-stream.js";

export const MAX_RUN_EVENT_LOG_BYTES = 64 * 1024 * 1024;

interface Subscriber {
  readonly onRecord: (record: RunStreamRecord) => void;
  readonly onClose: () => void;
}

/** Parent-scoped transport log. Agent event seq values are never rewritten. */
export class RunEventLog {
  readonly #records: RunStreamRecord[] = [];
  readonly #subscribers = new Set<Subscriber>();
  #bytes = 0;
  #truncated = false;
  #closed = false;
  #latestStreamSeq = 0;

  constructor(private readonly maxBytes = MAX_RUN_EVENT_LOG_BYTES) {}

  append(source: RunEventSource): void {
    if (this.#closed) return;
    const record: RunStreamRecord = { ...source, streamSeq: ++this.#latestStreamSeq };
    if (!this.#truncated) {
      const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
      if (this.#bytes + bytes > this.maxBytes) this.#truncated = true;
      else {
        this.#records.push(record);
        this.#bytes += bytes;
      }
    }
    for (const subscriber of this.#subscribers) subscriber.onRecord(record);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) subscriber.onClose();
  }
  get truncated(): boolean {
    return this.#truncated;
  }

  get latestStreamSeq(): number {
    return this.#latestStreamSeq;
  }

  subscribe(afterStreamSeq: number, signal: AbortSignal): AsyncIterable<RunStreamRecord> {
    if (this.#truncated) throw new RunEventLogTruncatedError();
    return this.#subscribe(afterStreamSeq, signal, true);
  }
  subscribeLive(afterStreamSeq: number, signal: AbortSignal): AsyncIterable<RunStreamRecord> {
    return this.#subscribe(afterStreamSeq, signal, false);
  }
  #subscribe(
    afterStreamSeq: number,
    signal: AbortSignal,
    replay: boolean,
  ): AsyncIterable<RunStreamRecord> {
    const queue = replay ? this.#records.filter((r) => r.streamSeq > afterStreamSeq) : [];
    let closed = this.#closed;
    let wake: (() => void) | undefined;
    let subscriber!: Subscriber;
    const release = (): void => {
      closed = true;
      this.#subscribers.delete(subscriber);
      signal.removeEventListener("abort", release);
      wake?.();
    };
    subscriber = {
      onRecord: (record) => {
        queue.push(record);
        wake?.();
      },
      onClose: release,
    };
    if (!closed && !signal.aborted) {
      this.#subscribers.add(subscriber);
      signal.addEventListener("abort", release, { once: true });
    }
    return (async function* () {
      try {
        while (!signal.aborted) {
          while (queue.length > 0 && !signal.aborted) {
            const record = queue.shift()!;
            if (record.streamSeq > afterStreamSeq) {
              afterStreamSeq = record.streamSeq;
              yield record;
            }
          }
          if (closed || signal.aborted) return;
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = undefined;
        }
      } finally {
        release();
      }
    })();
  }
}
export class RunEventLogTruncatedError extends Error {
  constructor() {
    super("Run event log exceeds the in-memory replay limit.");
    this.name = "RunEventLogTruncatedError";
  }
}
