import type {
  CrashArmInput,
  CrashArmStatus,
} from '@cashu-fault-lab/adapter-contract';
import {
  receiverCrashBoundaries,
  senderCrashBoundaries,
  type CrashBoundary,
  type CrashCheckpoint,
} from '@cashu-fault-lab/delivery-core';
import type { CrashArmStore } from './postgres-crash-arm-store.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SENDER_BOUNDARIES = new Set<CrashBoundary>(senderCrashBoundaries);
const RECEIVER_BOUNDARIES = new Set<CrashBoundary>(receiverCrashBoundaries);

export interface ProcessTerminator {
  terminate(): never;
}

export interface CrashControl extends CrashCheckpoint {
  readonly boundaries: readonly CrashBoundary[];
  reset(runId: string): Promise<void>;
  arm(input: CrashArmInput): Promise<void>;
  status(): Promise<readonly CrashArmStatus[]>;
  initialize(): Promise<void>;
  activeRunId(): string | undefined;
}

export class SigkillProcessTerminator implements ProcessTerminator {
  terminate(): never {
    process.kill(process.pid, 'SIGKILL');
    throw new Error('SIGKILL did not terminate the adapter process');
  }
}

export interface PostgresCrashCheckpointOptions {
  readonly store: CrashArmStore;
  readonly terminator: ProcessTerminator;
}

export class PostgresCrashCheckpoint implements CrashControl {
  readonly boundaries = [...senderCrashBoundaries, ...receiverCrashBoundaries] as const;
  readonly #store: CrashArmStore;
  readonly #terminator: ProcessTerminator;
  #runId = '';

  constructor(options: PostgresCrashCheckpointOptions) {
    this.#store = options.store;
    this.#terminator = options.terminator;
  }

  async initialize(): Promise<void> {
    this.#runId = (await this.#store.activeRun()) ?? '';
  }

  activeRunId(): string | undefined {
    return this.#runId.length === 0 ? undefined : this.#runId;
  }

  async reset(runId: string): Promise<void> {
    if (!RUN_ID.test(runId)) throw new Error('Crash control run ID is invalid');
    await this.#store.reset(runId);
    this.#runId = runId;
  }

  async arm(input: CrashArmInput): Promise<void> {
    if (this.#runId.length === 0) throw new Error('Crash controls must be reset first');
    if (input.runId !== this.#runId) {
      throw new Error('Crash arm run ID does not match the active lab run');
    }
    await this.#store.arm(input);
  }

  async status(): Promise<readonly CrashArmStatus[]> {
    if (this.#runId.length === 0) throw new Error('Crash controls must be reset first');
    return this.#store.list(this.#runId);
  }

  async hit(boundary: CrashBoundary, _deliveryId: string): Promise<void> {
    if (this.#runId.length === 0) return;
    const component = SENDER_BOUNDARIES.has(boundary)
      ? 'sender'
      : RECEIVER_BOUNDARIES.has(boundary)
        ? 'receiver'
        : undefined;
    if (component === undefined) throw new Error('Crash checkpoint boundary is invalid');
    const consumed = await this.#store.hit({ runId: this.#runId, component, boundary });
    if (consumed) this.#terminator.terminate();
  }
}
