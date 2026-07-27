import type { FailureArtifact, ScenarioCommand } from './runner.js';

export function assertReplayableArtifact(value: FailureArtifact): void {
  if (value.schemaVersion !== 1) throw new Error('Unsupported artifact schema version');
  if (
    typeof value.seed !== 'string' ||
    value.seed.length === 0 ||
    typeof value.scenario !== 'string' ||
    value.scenario.length === 0 ||
    !Array.isArray(value.commands)
  ) {
    throw new Error('Invalid replay artifact');
  }
}

function hasValidCommandDependencies(commands: readonly ScenarioCommand[]): boolean {
  const started = new Set<string>();
  const awaited = new Set<string>();
  for (const command of commands) {
    if (command.type === 'start_send') {
      if (command.operationId.length === 0 || started.has(command.operationId)) return false;
      started.add(command.operationId);
      continue;
    }
    if (command.type === 'await_send') {
      if (
        command.operationId.length === 0 ||
        !started.has(command.operationId) ||
        awaited.has(command.operationId)
      ) {
        return false;
      }
      awaited.add(command.operationId);
    }
  }
  return started.size === awaited.size;
}

export async function minimizeFailingCommands(
  commands: readonly ScenarioCommand[],
  stillFails: (candidate: readonly ScenarioCommand[]) => Promise<boolean>,
  runLimit = 100,
): Promise<readonly ScenarioCommand[]> {
  if (!Number.isSafeInteger(runLimit) || runLimit < 1) throw new Error('Invalid shrink run limit');
  let candidate = [...commands];
  let chunkSize = Math.max(1, Math.floor(candidate.length / 2));
  let runs = 0;

  while (candidate.length > 1 && runs < runLimit) {
    let reduced = false;
    for (let start = 0; start < candidate.length && runs < runLimit; start += chunkSize) {
      const next = [...candidate.slice(0, start), ...candidate.slice(start + chunkSize)];
      if (next.length === 0) continue;
      if (!hasValidCommandDependencies(next)) continue;
      runs += 1;
      if (await stillFails(next)) {
        candidate = next;
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (chunkSize === 1) break;
      chunkSize = Math.max(1, Math.floor(chunkSize / 2));
    } else {
      chunkSize = Math.min(chunkSize, Math.max(1, Math.floor(candidate.length / 2)));
    }
  }
  for (let index = 0; index < candidate.length && runs < runLimit; index += 1) {
    const command = candidate[index];
    if (command?.type !== 'advance_time' || command.milliseconds <= 0) continue;
    let low = 0;
    let high = command.milliseconds;
    while (low < high && runs < runLimit) {
      const nextValue = Math.floor((low + high) / 2);
      const next = candidate.map((entry, entryIndex) =>
        entryIndex === index && entry.type === 'advance_time'
          ? { ...entry, milliseconds: nextValue }
          : entry,
      );
      if (!hasValidCommandDependencies(next)) break;
      runs += 1;
      if (await stillFails(next)) {
        candidate = next;
        high = nextValue;
      } else {
        low = nextValue + 1;
      }
    }
  }
  return candidate;
}
