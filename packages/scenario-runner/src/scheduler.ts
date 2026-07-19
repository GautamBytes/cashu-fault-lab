export interface ScheduledHandle {
  readonly cancelled: boolean;
  cancel(): void;
}

interface ScheduledTask {
  readonly deadline: number;
  readonly sequence: number;
  readonly callback: () => void;
  cancelled: boolean;
}

function assertTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer virtual time`);
  }
}

export class VirtualScheduler {
  #now: number;
  #sequence = 0;
  readonly #tasks: ScheduledTask[] = [];

  constructor(start = 0) {
    assertTime(start, 'Start time');
    this.#now = start;
  }

  get now(): number {
    return this.#now;
  }

  schedule(delay: number, callback: () => void): ScheduledHandle {
    assertTime(delay, 'Delay');
    if (typeof callback !== 'function') throw new Error('Scheduled callback must be a function');
    const deadline = this.#now + delay;
    assertTime(deadline, 'Deadline');
    const task: ScheduledTask = {
      deadline,
      sequence: this.#sequence,
      callback,
      cancelled: false,
    };
    this.#sequence += 1;
    this.#tasks.push(task);
    return {
      get cancelled() {
        return task.cancelled;
      },
      cancel() {
        task.cancelled = true;
      },
    };
  }

  advanceBy(milliseconds: number, executionLimit = 10_000): void {
    assertTime(milliseconds, 'Advance time');
    this.#advanceTo(this.#now + milliseconds, executionLimit);
  }

  runUntilIdle(executionLimit = 10_000): void {
    this.#assertLimit(executionLimit);
    let executed = 0;
    while (this.#tasks.length > 0) {
      const next = this.#takeNext();
      if (!next) break;
      if (next.cancelled) continue;
      if (executed >= executionLimit) throw new Error('Virtual scheduler execution limit exceeded');
      this.#now = next.deadline;
      next.callback();
      executed += 1;
    }
  }

  #advanceTo(target: number, executionLimit: number): void {
    assertTime(target, 'Target time');
    this.#assertLimit(executionLimit);
    let executed = 0;
    while (true) {
      const next = this.#peekNext();
      if (!next || next.deadline > target) break;
      this.#tasks.splice(this.#tasks.indexOf(next), 1);
      if (next.cancelled) continue;
      if (executed >= executionLimit) throw new Error('Virtual scheduler execution limit exceeded');
      this.#now = next.deadline;
      next.callback();
      executed += 1;
    }
    this.#now = target;
  }

  #peekNext(): ScheduledTask | undefined {
    let next: ScheduledTask | undefined;
    for (const task of this.#tasks) {
      if (
        !next ||
        task.deadline < next.deadline ||
        (task.deadline === next.deadline && task.sequence < next.sequence)
      ) {
        next = task;
      }
    }
    return next;
  }

  #takeNext(): ScheduledTask | undefined {
    const next = this.#peekNext();
    if (next) this.#tasks.splice(this.#tasks.indexOf(next), 1);
    return next;
  }

  #assertLimit(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('Execution limit must be a positive safe integer');
    }
  }
}
